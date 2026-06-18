import * as vscode from "vscode";
import { OpenRouterClient } from "../openrouter/client";
import {
  AssistantMessage,
  ToolCall,
  Usage,
} from "../openrouter/types";
import { ContextManager } from "./contextManager";
import {
  ApprovalDecision,
  ApprovalRequest,
  Tool,
  ToolContext,
} from "./tools/types";
import { toolByName, toolsForMode, toToolDefinitions } from "./tools";
import { AgentMode, MODES } from "../modes";

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: any }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string; diff?: import("../webview/protocol").DiffData }
  | { type: "status"; message: string }
  | {
      type: "usage";
      usage: Usage;
      cachedTokens: number;
    }
  | { type: "error"; message: string }
  | { type: "turn_end"; stopReason: string };

export interface AgentCallbacks {
  onEvent(e: AgentEvent): void;
  /** Bridge an approval request to the UI; resolves with the user's decision. */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface AgentDeps {
  client: OpenRouterClient;
  context: ContextManager;
  output: vscode.OutputChannel;
  workspaceRoot: string;
  maxTokens: number;
  temperature: number;
  maxContextTokens: number;
}

const MAX_TOOL_ITERATIONS = 50;

/**
 * Drives a single user turn to completion: streams assistant output, executes
 * any tool calls (respecting the mode + approvals), and loops until the model
 * stops requesting tools.
 */
export class Agent {
  private abort?: AbortController;

  constructor(private deps: AgentDeps, private cb: AgentCallbacks) {}

  cancel() {
    this.abort?.abort();
  }

  async run(userText: string, mode: AgentMode): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.deps.context.addUser(userText);
    this.cb.onEvent({ type: "turn_start" });

    const tools = toolsForMode(!MODES[mode].allowsMutation);
    const toolDefs = toToolDefinitions(tools);

    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        if (signal.aborted) {
          this.cb.onEvent({ type: "turn_end", stopReason: "cancelled" });
          return;
        }

        // Keep within the context budget before each call.
        if (this.deps.context.compactIfNeeded(this.deps.maxContextTokens)) {
          this.cb.onEvent({ type: "status", message: "Compacted older context to fit budget." });
        }

        const assistantMsg: AssistantMessage = { role: "assistant", content: "" };
        let textBuf = "";
        const toolCalls: Map<number, ToolCall> = new Map();
        let finishReason: string | null = null;
        let errored = false;

        for await (const ev of this.deps.client.stream({
          messages: this.deps.context.render(),
          tools: toolDefs,
          temperature: this.deps.temperature,
          maxTokens: this.deps.maxTokens,
          signal,
        })) {
          switch (ev.type) {
            case "text":
              textBuf += ev.delta;
              this.cb.onEvent({ type: "text", delta: ev.delta });
              break;
            case "reasoning":
              this.cb.onEvent({ type: "reasoning", delta: ev.delta });
              break;
            case "tool_call_start": {
              const existing = toolCalls.get(ev.index);
              if (existing) {
                if (ev.id) existing.id = ev.id;
                if (ev.name) existing.function.name = ev.name;
              } else {
                toolCalls.set(ev.index, {
                  id: ev.id || `call_${ev.index}`,
                  type: "function",
                  function: { name: ev.name, arguments: "" },
                });
              }
              break;
            }
            case "tool_call_delta": {
              const tc = toolCalls.get(ev.index);
              if (tc) tc.function.arguments += ev.argsDelta;
              break;
            }
            case "usage":
              this.cb.onEvent({
                type: "usage",
                usage: ev.usage,
                cachedTokens:
                  ev.usage.prompt_tokens_details?.cached_tokens ??
                  ev.usage.cache_read_input_tokens ??
                  0,
              });
              break;
            case "done":
              finishReason = ev.finishReason;
              break;
            case "error":
              this.cb.onEvent({ type: "error", message: ev.message });
              errored = true;
              break;
          }
        }

        if (errored) {
          this.cb.onEvent({ type: "turn_end", stopReason: "error" });
          return;
        }

        const calls = [...toolCalls.values()].filter((c) => c.function.name);
        assistantMsg.content = textBuf.length ? textBuf : null;
        if (calls.length) assistantMsg.tool_calls = calls;
        this.deps.context.addAssistant(assistantMsg);

        if (!calls.length) {
          this.cb.onEvent({ type: "turn_end", stopReason: finishReason ?? "stop" });
          return;
        }

        // If the model hit the output-token limit, its last tool call's JSON
        // arguments are almost certainly truncated. Flag it so the parse-failure
        // message is actionable instead of a cryptic "invalid JSON".
        const truncated = finishReason === "length";

        // Execute each tool call sequentially (edits/commands shouldn't race).
        // Every tool_call MUST get a matching tool result or the next request
        // will be rejected — so on abort we backfill the remaining calls.
        for (let i = 0; i < calls.length; i++) {
          if (signal.aborted) {
            for (let j = i; j < calls.length; j++) {
              this.deps.context.addToolResult(calls[j].id, "Cancelled by user.");
            }
            break;
          }
          await this.executeToolCall(calls[i], mode, signal, truncated);
        }
      }
      this.cb.onEvent({
        type: "status",
        message: `Reached the ${MAX_TOOL_ITERATIONS}-step limit for this turn.`,
      });
      this.cb.onEvent({ type: "turn_end", stopReason: "max_iterations" });
    } catch (e: any) {
      this.cb.onEvent({ type: "error", message: `Agent error: ${e?.message ?? e}` });
      this.cb.onEvent({ type: "turn_end", stopReason: "error" });
    }
  }

  private async executeToolCall(
    call: ToolCall,
    mode: AgentMode,
    signal: AbortSignal,
    truncated = false
  ): Promise<void> {
    const tool = toolByName(call.function.name);
    let args: any = {};
    let parseFailed = false;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      parseFailed = true;
    }

    // Always emit tool_start first so the UI has a card to update — otherwise a
    // parse failure would render only on reload (when the transcript replays).
    this.cb.onEvent({ type: "tool_start", id: call.id, name: call.function.name, args });

    if (parseFailed) {
      const msg = truncated
        ? `The tool call was cut off at the output-token limit, so its arguments are incomplete. Increase "lunacode.maxTokens", or write/edit the file in smaller pieces (e.g. create it then append with edit_file).`
        : `Invalid JSON arguments for ${call.function.name}. Re-issue the call with valid JSON.`;
      this.deps.context.addToolResult(call.id, msg);
      this.cb.onEvent({
        type: "tool_end",
        id: call.id,
        name: call.function.name,
        ok: false,
        summary: msg,
      });
      return;
    }

    if (!tool) {
      const msg = `Unknown tool: ${call.function.name}`;
      this.deps.context.addToolResult(call.id, msg);
      this.cb.onEvent({ type: "tool_end", id: call.id, name: call.function.name, ok: false, summary: msg });
      return;
    }

    // Plan mode: refuse mutating tools (also filtered from the tool list).
    if (tool.mutating && !MODES[mode].allowsMutation) {
      const msg = `Blocked: ${tool.name} cannot run in Plan mode. Propose the change instead.`;
      this.deps.context.addToolResult(call.id, msg);
      this.cb.onEvent({ type: "tool_end", id: call.id, name: tool.name, ok: false, summary: msg });
      return;
    }

    const ctx: ToolContext = {
      workspaceRoot: this.deps.workspaceRoot,
      mode,
      signal,
      output: this.deps.output,
      log: (m) => this.cb.onEvent({ type: "status", message: m }),
      requestApproval: async (req) => {
        // Auto mode is fully autonomous: it runs edits AND commands without
        // prompting. (Always-deny commands are still hard-blocked inside
        // run_command, and Plan mode never reaches a mutating tool at all.)
        if (mode === "auto") {
          return "approved";
        }
        // The provider owns session-level "approve always" memory and maps
        // approved-always -> approved.
        return this.cb.requestApproval(req);
      },
    };

    try {
      const result = await tool.execute(args, ctx);
      this.deps.context.addToolResult(call.id, result.content);
      const diff = result.ui?.diff as import("../webview/protocol").DiffData | undefined;
      this.cb.onEvent({
        type: "tool_end",
        id: call.id,
        name: tool.name,
        ok: !result.isError,
        summary: firstLine(result.content),
        diff,
      });
    } catch (e: any) {
      const msg = `Tool ${tool.name} threw: ${e?.message ?? e}`;
      this.deps.context.addToolResult(call.id, msg);
      this.cb.onEvent({ type: "tool_end", id: call.id, name: tool.name, ok: false, summary: msg });
    }
  }
}

function firstLine(s: string): string {
  const line = s.split("\n")[0];
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}
