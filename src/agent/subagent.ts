import * as vscode from "vscode";
import { OpenRouterClient } from "../openrouter/client";
import { ToolCall, Usage } from "../openrouter/types";
import { ContextManager } from "./contextManager";
import { Tool, ToolContext } from "./tools/types";
import { toToolDefinitions } from "./tools";
import { truncate } from "./tools/util";

/**
 * A disposable research/implement sub-agent with its OWN context. The main
 * conversation receives only the final digest (~a few hundred tokens), while
 * the greps and file reads needed to produce it — often tens of thousands of
 * tokens — live and die here instead of being re-billed on every subsequent
 * main-loop call.
 */

function buildSubagentPrompt(
  workspaceRoot: string,
  overview?: string,
  extra?: string
): string {
  return `You are a code-research sub-agent inside VS Code. Answer the question using read-only tools, then reply with a concise digest for the primary agent.

Workspace root: ${workspaceRoot}
${overview ? `Top-level: ${overview}\n` : ""}
Rules:
- Batch ALL independent lookups (grep, glob, read_file, file_outline, list_dir, find_symbol) into one response — they run in parallel.
- For large files, file_outline first, then read_file offset/limit.
- Do not re-read files you already have.
- Your final text is returned verbatim. Be self-contained: file paths with line numbers, how pieces connect, key functions/types, direct answer. No preamble, no speculation.
- If you cannot find something, say what you looked for and where.
${extra ? `\n${extra}` : ""}`;
}

const DEFAULT_MAX_SUBAGENT_ITERATIONS = 10;
/** Force a final answer if the sub-context grows past this (rough tokens). */
const DEFAULT_MAX_SUBAGENT_CONTEXT_TOKENS = 60_000;
/** Cap individual tool results inside the sub-agent (digest quality > dumps). */
const MAX_SUBAGENT_TOOL_RESULT_CHARS = 12_000;

export interface SubagentOptions {
  client: OpenRouterClient;
  /** Model override for the sub-agent; undefined = client's session model. */
  model?: string;
  /** Read-only tools available to the sub-agent (must not include explore). */
  tools: Tool[];
  workspaceRoot: string;
  /** Optional top-level workspace listing to seed orientation. */
  workspaceOverview?: string;
  /** Extra system-prompt rules (e.g. implementer may write files). */
  systemPromptExtra?: string;
  /** Override iteration budget (default 10). */
  maxIterations?: number;
  /** Override sub-context token budget (default 60k). */
  maxContextTokens?: number;
  output: vscode.OutputChannel;
  signal: AbortSignal;
  onStatus?: (message: string) => void;
  onUsage?: (usage: Usage) => void;
}

export async function runSubagent(question: string, opts: SubagentOptions): Promise<string> {
  const context = new ContextManager(true);
  context.setSystemPrompt(
    buildSubagentPrompt(opts.workspaceRoot, opts.workspaceOverview, opts.systemPromptExtra)
  );
  context.addUser(question);

  const toolDefs = toToolDefinitions(opts.tools);
  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_SUBAGENT_ITERATIONS;
  const maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_SUBAGENT_CONTEXT_TOKENS;
  const allowsMutation = opts.tools.some((t) => t.mutating);

  const ctx: ToolContext = {
    workspaceRoot: opts.workspaceRoot,
    mode: allowsMutation ? "auto" : "plan",
    signal: opts.signal,
    output: opts.output,
    log: () => {}, // sub-agent progress stays out of the main chat
    // Tools here either are read-only or run under Auto-like trust for implementer.
    requestApproval: async () => "approved",
    context,
  };

  let lastText = "";
  for (let iter = 0; iter < maxIter; iter++) {
    if (opts.signal.aborted) break;

    // Out of iteration/context budget → one final call with NO tools so the
    // model must answer from what it has gathered.
    const finalRound =
      iter === maxIter - 1 || context.estimate() > maxContextTokens;

    let textBuf = "";
    const toolCalls = new Map<number, ToolCall>();
    let errored: string | null = null;

    // Run one tool call to a result string (shared by eager + batch paths).
    const execCall = async (call: ToolCall): Promise<string> => {
      const t = toolByName.get(call.function.name);
      if (!t) return `Unknown tool: ${call.function.name}`;
      let args: any = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        return `Invalid JSON arguments for ${call.function.name}.`;
      }
      try {
        const result = await t.execute(args, ctx);
        const { text } = truncate(result.content, MAX_SUBAGENT_TOOL_RESULT_CHARS);
        return text;
      } catch (e: any) {
        return `Tool ${call.function.name} threw: ${e?.message ?? e}`;
      }
    };

    // Eager execution (same invariant as the main loop): a READ-ONLY call
    // whose JSON args are complete starts running while the model is still
    // streaming — a call at index i is known-complete once a higher-indexed
    // call begins. Explore sub-agents are all-read-only, so nearly every call
    // overlaps with generation. Mutating tools never start early.
    const eager = new Map<ToolCall, Promise<string>>();
    const maybeStartEager = (idx: number) => {
      const tc = toolCalls.get(idx);
      if (!tc || !tc.function.name || eager.has(tc)) return;
      const tool = toolByName.get(tc.function.name);
      if (!tool || tool.mutating) return;
      try {
        if (tc.function.arguments) JSON.parse(tc.function.arguments);
      } catch {
        return; // incomplete/invalid JSON — leave for the normal path
      }
      eager.set(tc, execCall(tc));
    };

    // Chars this request sends — paired with the usage frame to calibrate the
    // sub-context's token estimator (its 60k budget check).
    const sentChars =
      context.renderChars() +
      (finalRound ? 0 : JSON.stringify(toolDefs).length);

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
            // A new call starting means every lower-indexed call is done.
            for (const idx of toolCalls.keys()) {
              if (idx < ev.index) maybeStartEager(idx);
            }
          }
          break;
        }
        case "tool_call_delta": {
          const tc = toolCalls.get(ev.index);
          if (tc) tc.function.arguments += ev.argsDelta;
          break;
        }
        case "usage":
          context.noteObservedUsage(sentChars, ev.usage.prompt_tokens);
          opts.onUsage?.(ev.usage);
          break;
        case "error":
          errored = ev.message;
          break;
      }
    }

    // Stream finished: start any remaining complete read-only calls.
    if (!errored) {
      for (const idx of toolCalls.keys()) maybeStartEager(idx);
    }

    if (errored) {
      return lastText || `Sub-agent failed: ${errored}`;
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
      `subagent: ${calls.map((c) => c.function.name).join(", ")} (${calls.length} call${calls.length > 1 ? "s" : ""})`
    );

    // Run tools. Eagerly-started calls just get awaited; other consecutive
    // read-only calls batch in parallel; mutating tools stay sequential.
    const results: string[] = new Array(calls.length);
    let i = 0;
    while (i < calls.length) {
      const call = calls[i];
      const pending = eager.get(call);
      if (pending) {
        results[i] = await pending;
        i++;
        continue;
      }
      const tool = toolByName.get(call.function.name);
      if (tool && !tool.mutating) {
        let j = i + 1;
        while (j < calls.length && !eager.has(calls[j])) {
          const t = toolByName.get(calls[j].function.name);
          if (t && !t.mutating) j++;
          else break;
        }
        const batch = calls.slice(i, j);
        const batchResults = await Promise.all(batch.map(execCall));
        for (let k = 0; k < batch.length; k++) results[i + k] = batchResults[k];
        i = j;
      } else {
        // Mutating (or unknown) — run alone, in order.
        results[i] = await execCall(call);
        i++;
      }
    }
    for (let k = 0; k < calls.length; k++) {
      context.addToolResult(calls[k].id, results[k]);
    }
  }

  return lastText || "The sub-agent did not produce an answer.";
}
