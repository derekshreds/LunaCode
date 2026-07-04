import * as vscode from "vscode";
import { OpenRouterClient } from "../openrouter/client";
import { ToolCall, Usage } from "../openrouter/types";
import { ContextManager } from "./contextManager";
import { Tool, ToolContext } from "./tools/types";
import { toToolDefinitions } from "./tools";

/**
 * A disposable research sub-agent with its OWN context. The main conversation
 * receives only the final digest (~a few hundred tokens), while the greps and
 * file reads needed to produce it — often tens of thousands of tokens — live
 * and die here instead of being re-billed on every subsequent main-loop call.
 */

const SUBAGENT_SYSTEM_PROMPT = `You are a code-research sub-agent inside a VS Code workspace. Answer the research question below using the read-only tools, then reply with a concise, self-contained digest for the primary coding agent.

Rules:
- Investigate efficiently: batch ALL independent lookups (grep, glob, read_file, file_outline, list_dir) into a single response — they run in parallel.
- For large files, use file_outline first, then read_file with offset/limit for just the relevant range.
- Your FINAL text response is returned verbatim as the answer. Make it self-contained: relevant file paths with line numbers, how the pieces connect, key functions/types, and a direct answer to the question. No preamble, no "I found...", no speculation — only what the code shows.
- If you cannot find something, say precisely what you looked for and where.`;

const MAX_SUBAGENT_ITERATIONS = 10;
/** Force a final answer if the sub-context grows past this (rough tokens). */
const MAX_SUBAGENT_CONTEXT_TOKENS = 60_000;

export interface SubagentOptions {
  client: OpenRouterClient;
  /** Model override for the sub-agent; undefined = client's session model. */
  model?: string;
  /** Read-only tools available to the sub-agent (must not include explore). */
  tools: Tool[];
  workspaceRoot: string;
  output: vscode.OutputChannel;
  signal: AbortSignal;
  onStatus?: (message: string) => void;
  onUsage?: (usage: Usage) => void;
}

export async function runSubagent(question: string, opts: SubagentOptions): Promise<string> {
  const context = new ContextManager(true);
  context.setSystemPrompt(SUBAGENT_SYSTEM_PROMPT);
  context.addUser(question);

  const toolDefs = toToolDefinitions(opts.tools);
  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));

  const ctx: ToolContext = {
    workspaceRoot: opts.workspaceRoot,
    mode: "plan", // read-only semantics
    signal: opts.signal,
    output: opts.output,
    log: () => {}, // sub-agent progress stays out of the main chat
    // Tools here are read-only and never ask; reject defensively if one does.
    requestApproval: async () => "rejected",
  };

  let lastText = "";
  for (let iter = 0; iter < MAX_SUBAGENT_ITERATIONS; iter++) {
    if (opts.signal.aborted) break;

    // Out of iteration/context budget → one final call with NO tools so the
    // model must answer from what it has gathered.
    const finalRound =
      iter === MAX_SUBAGENT_ITERATIONS - 1 ||
      context.estimate() > MAX_SUBAGENT_CONTEXT_TOKENS;

    let textBuf = "";
    const toolCalls = new Map<number, ToolCall>();
    let errored: string | null = null;

    for await (const ev of opts.client.stream({
      model: opts.model,
      messages: context.render(),
      tools: finalRound ? undefined : toolDefs,
      temperature: 0,
      signal: opts.signal,
    })) {
      switch (ev.type) {
        case "text":
          textBuf += ev.delta;
          break;
        case "tool_call_start": {
          const existing = toolCalls.get(ev.index);
          if (existing) {
            if (ev.id) existing.id = ev.id;
            if (ev.name) existing.function.name = ev.name;
          } else {
            toolCalls.set(ev.index, {
              id: ev.id || `sub_${ev.index}`,
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
          opts.onUsage?.(ev.usage);
          break;
        case "error":
          errored = ev.message;
          break;
      }
    }

    if (errored) {
      return lastText || `Explore failed: ${errored}`;
    }
    if (textBuf.trim()) lastText = textBuf.trim();

    const calls = [...toolCalls.values()].filter((c) => c.function.name);
    context.addAssistant({
      role: "assistant",
      content: textBuf.length ? textBuf : null,
      tool_calls: calls.length ? calls : undefined,
    });

    if (!calls.length) break; // answered

    opts.onStatus?.(
      `explore: ${calls.map((c) => c.function.name).join(", ")} (${calls.length} lookup${calls.length > 1 ? "s" : ""})`
    );

    // All sub-agent tools are read-only → always safe to run in parallel.
    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = toolByName.get(call.function.name);
        if (!tool) return `Unknown tool: ${call.function.name}`;
        let args: any = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          return `Invalid JSON arguments for ${call.function.name}.`;
        }
        try {
          const result = await tool.execute(args, ctx);
          return result.content;
        } catch (e: any) {
          return `Tool ${call.function.name} threw: ${e?.message ?? e}`;
        }
      })
    );
    for (let i = 0; i < calls.length; i++) {
      context.addToolResult(calls[i].id, results[i]);
    }
  }

  return lastText || "The explore sub-agent did not produce an answer.";
}
