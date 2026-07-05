import * as vscode from "vscode";
import { OpenRouterClient, isTransientFrame } from "../openrouter/client";
import {
  AssistantMessage,
  ToolCall,
  Usage,
} from "../openrouter/types";
import { ContextManager } from "./contextManager";
import { summarizeSpan } from "./summarizer";
import {
  ApprovalDecision,
  ApprovalRequest,
  Tool,
  ToolContext,
} from "./tools/types";
import { toolsForMode, toolsForSubagent, toToolDefinitions } from "./tools";
import { formatFile, postEditDiagnostics } from "./tools/vscodeTools";
import { runSubagent } from "./subagent";
import { AgentMode, MODES } from "../modes";

/** Tools whose success should trigger snapshot/format/diagnostics handling. */
const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

/** A tool call whose name arrived and whose JSON arguments parse — i.e. it
 * streamed to completion and is safe to execute. */
function isCompleteCall(c: ToolCall): boolean {
  if (!c.function.name || !c.function.arguments) return false;
  try {
    JSON.parse(c.function.arguments);
    return true;
  } catch {
    return false;
  }
}

/** Workspace-relative paths an edit-tool call touches. */
function editPaths(toolName: string, args: any): string[] {
  if (!EDIT_TOOLS.has(toolName)) return [];
  if (toolName === "apply_patch") {
    return Array.isArray(args?.changes)
      ? args.changes.map((c: any) => c?.path).filter((p: any) => typeof p === "string")
      : [];
  }
  return typeof args?.path === "string" ? [args.path] : [];
}

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: any }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string; diff?: import("../webview/protocol").DiffData }
  | { type: "status"; message: string }
  /** Queued messages were drained into the running turn as steering. */
  | { type: "steering" }
  | {
      type: "usage";
      usage: Usage;
      cachedTokens: number;
      /** Model that incurred this usage; defaults to the active session model. */
      model?: string;
    }
  | { type: "compaction"; tokensSaved: number; summarized: boolean; deduped: number }
  | { type: "tasks"; tasks: TaskItem[] }
  /** Live generation progress (throttled) — includes tool-call argument
   * streaming, which otherwise produces no visible output. */
  | { type: "stream_progress"; tokens: number }
  /** Live tool output (stdout, explore lookups) for a running tool card. */
  | { type: "tool_output"; id: string; delta: string }
  | { type: "error"; message: string }
  | { type: "turn_end"; stopReason: string };

import type { TaskItem } from "../webview/protocol";
export type { TaskItem };

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
  /** Model used to summarize history during compaction events. */
  summarizerModel: string;
  /** Fraction of the budget to compact down to when an event fires. */
  compactionTargetRatio: number;
  /** Model for the explore research sub-agent; "" = the session model. */
  subagentModel: string;
  /** Capture a file's pre-edit state for turn checkpoints (revert support). */
  snapshotFile?: (relPath: string) => Promise<void>;
  /** Additional dynamic tools (e.g. bridged MCP tools). */
  extraTools?: Tool[];
  /** Drain user messages typed mid-turn — injected as steering at the next
   * loop iteration instead of waiting for the turn to finish. */
  takeSteering?: () => Array<{ text: string; images?: string[] }>;
  /** Format edited files with the workspace formatter after each edit. */
  formatAfterEdit?: boolean;
  /** Session budget check: returns {spent, limit} when the session cost has
   * crossed the configured budget, else null. */
  checkBudget?: () => { spent: number; limit: number } | null;
  /** Max tool-loop iterations per turn. 0 (or undefined) = unlimited. */
  maxTurns?: number;
  /** Stop the turn if the same file/command is mutated more than this many
   * times — catches runaway "rewrite the same file over and over" loops.
   * 0/undefined = disabled. */
  loopGuardLimit?: number;
}

const DEFAULT_MAX_TURNS = 200;

/**
 * Drives a single user turn to completion: streams assistant output, executes
 * any tool calls (respecting the mode + approvals), and loops until the model
 * stops requesting tools.
 */
export class Agent {
  private abort?: AbortController;
  /** Tools active for the current run (built-ins + dynamic), by name. */
  private toolMap = new Map<string, Tool>();
  /** User approved continuing past the session budget (for this run). */
  private budgetApproved = false;
  /** Streamed chars this turn (text + reasoning + tool args) for the counter. */
  private streamedChars = 0;
  private lastProgressAt = 0;
  /** Per-turn count of mutations per target (file/command) — the loop guard. */
  private editCounts = new Map<string, number>();

  constructor(private deps: AgentDeps, private cb: AgentCallbacks) {}

  cancel() {
    this.abort?.abort();
  }

  /** The mutation target(s) a tool call acts on, for loop detection: an edited
   * file (`file:<path>`) or a run command (`cmd:<command>`). Read-only tools
   * return none. apply_patch can touch several files. */
  private mutatingTargets(call: ToolCall): string[] {
    const name = call.function.name;
    let args: any = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return [];
    }
    if (name === "run_command" || name === "start_process") {
      const cmd = String(args.command ?? "").trim().slice(0, 100);
      return cmd ? [`cmd:${cmd}`] : [];
    }
    if (name === "write_file" || name === "edit_file") {
      return args.path ? [`file:${args.path}`] : [];
    }
    if (name === "apply_patch") {
      return Array.isArray(args.changes)
        ? args.changes.map((c: any) => c?.path).filter(Boolean).map((p: string) => `file:${p}`)
        : [];
    }
    return [];
  }

  /** Throttled live-progress counter (covers silent tool-arg streaming). */
  private trackProgress(chars: number) {
    this.streamedChars += chars;
    const now = Date.now();
    if (now - this.lastProgressAt >= 250) {
      this.lastProgressAt = now;
      this.cb.onEvent({
        type: "stream_progress",
        tokens: Math.round(this.streamedChars / 4),
      });
    }
  }

  async run(userText: string, mode: AgentMode, images?: string[]): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.budgetApproved = false;
    this.streamedChars = 0;
    this.lastProgressAt = 0;
    this.editCounts.clear();
    this.deps.context.addUser(userText, images, { turnStart: true });
    this.cb.onEvent({ type: "turn_start" });

    const allowsMutation = MODES[mode].allowsMutation;
    const tools = [
      ...toolsForMode(!allowsMutation),
      ...(this.deps.extraTools ?? []).filter((t) => allowsMutation || !t.mutating),
    ];
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
    const toolDefs = toToolDefinitions(tools);

    // 0 = unlimited; undefined falls back to the default cap.
    const configuredMaxTurns = this.deps.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxIterations = configuredMaxTurns > 0 ? configuredMaxTurns : Infinity;

    try {
      for (let iter = 0; iter < maxIterations; iter++) {
        if (signal.aborted) {
          this.cb.onEvent({ type: "turn_end", stopReason: "cancelled" });
          return;
        }

        // Session budget guardrail: when the session's spend crosses the
        // configured limit, pause and ask — even in Auto mode. "Approve always"
        // silences it for the rest of the session (provider-side memory).
        const over = this.deps.checkBudget?.();
        if (over && !this.budgetApproved) {
          const decision = await this.cb.requestApproval({
            kind: "session-budget",
            title: "Session budget reached",
            subject: `$${over.spent.toFixed(2)} spent (limit $${over.limit.toFixed(2)})`,
            detail: "Continue this session anyway? 'Always' silences this for the session.",
          });
          if (decision === "rejected") {
            this.cb.onEvent({
              type: "status",
              message: "Stopped: session budget reached. Raise lunacode.sessionBudgetUsd or start a new session.",
            });
            this.cb.onEvent({ type: "turn_end", stopReason: "budget" });
            return;
          }
          this.budgetApproved = true;
        }

        // Mid-turn steering: user messages typed while the agent works are
        // injected here so they influence the CURRENT task immediately.
        const steering = this.deps.takeSteering?.() ?? [];
        for (const s of steering) {
          this.deps.context.addUser(s.text, s.images);
        }
        if (steering.length) {
          this.cb.onEvent({ type: "status", message: "Steering message applied to the running task." });
          this.cb.onEvent({ type: "steering" });
        }

        // Context-budget check. This mutates history only when the budget is
        // exceeded (a rare "compaction event"); otherwise history stays
        // append-only so the provider prompt cache keeps hitting.
        const compaction = await this.deps.context.compactIfNeeded(
          this.deps.maxContextTokens,
          {
            targetRatio: this.deps.compactionTargetRatio,
            summarize: (span) =>
              summarizeSpan(
                this.deps.client,
                this.deps.summarizerModel,
                span,
                signal,
                (usage) =>
                  this.cb.onEvent({
                    type: "usage",
                    usage,
                    cachedTokens:
                      usage.prompt_tokens_details?.cached_tokens ??
                      usage.cache_read_input_tokens ??
                      0,
                    model: this.deps.summarizerModel,
                  })
              ),
          }
        );
        if (compaction) {
          this.cb.onEvent({ type: "compaction", ...compaction });
          this.cb.onEvent({
            type: "status",
            message: compaction.summarized
              ? `Compacted context into a checkpoint (~${Math.round(compaction.tokensSaved / 1000)}k tokens saved).`
              : `Compacted older context to fit budget (summarizer unavailable — truncated instead).`,
          });
        }

        const assistantMsg: AssistantMessage = { role: "assistant", content: "" };
        let textBuf = "";
        const toolCalls: Map<number, ToolCall> = new Map();
        let finishReason: string | null = null;
        let streamError: { message: string; transient: boolean } | null = null;
        let servedModel: string | null = null;
        // The live counter restarts for each thinking step (each model call).
        this.streamedChars = 0;
        this.lastProgressAt = 0;

        // Eager execution: a READ-ONLY tool call whose JSON is complete starts
        // running while the model is still streaming the rest of its message —
        // overlapping generation with I/O. A call at index i is known-complete
        // once a call at a higher index begins. Mutating tools never run early.
        const eager = new Map<number, Promise<string>>();
        const maybeStartEager = (idx: number) => {
          const tc = toolCalls.get(idx);
          if (!tc || !tc.function.name || eager.has(idx)) return;
          const tool = this.toolMap.get(tc.function.name);
          if (!tool || tool.mutating) return;
          try {
            if (tc.function.arguments) JSON.parse(tc.function.arguments);
          } catch {
            return; // incomplete/invalid JSON — leave for the normal path
          }
          eager.set(idx, this.runToolCall(tc, mode, signal, false));
        };

        let usageSeen = false;
        for await (const ev of this.deps.client.stream({
          messages: this.deps.context.render(),
          tools: toolDefs,
          temperature: this.deps.temperature,
          maxTokens: this.deps.maxTokens,
          signal,
        })) {
          switch (ev.type) {
            case "model":
              servedModel = ev.id;
              this.cb.onEvent({
                type: "status",
                message: `Primary model unavailable — served by fallback ${ev.id}.`,
              });
              break;
            case "text":
              textBuf += ev.delta;
              this.trackProgress(ev.delta.length);
              this.cb.onEvent({ type: "text", delta: ev.delta });
              break;
            case "reasoning":
              this.trackProgress(ev.delta.length);
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
              // Writing a big file streams entirely through tool args with no
              // visible text — the counter is what shows it isn't hung.
              this.trackProgress(ev.argsDelta.length);
              break;
            }
            case "usage":
              usageSeen = true;
              this.cb.onEvent({
                type: "usage",
                usage: ev.usage,
                cachedTokens:
                  ev.usage.prompt_tokens_details?.cached_tokens ??
                  ev.usage.cache_read_input_tokens ??
                  0,
                model: servedModel ?? undefined,
              });
              break;
            case "retry":
              this.cb.onEvent({
                type: "status",
                message: `${ev.reason} — retrying (attempt ${ev.attempt + 1} of ${ev.maxAttempts})…`,
              });
              break;
            case "done":
              finishReason = ev.finishReason;
              break;
            case "error":
              streamError = {
                message: ev.message,
                transient: isTransientFrame(ev.message, ev.code),
              };
              break;
          }
        }

        // A turn cancelled mid-stream never receives its usage frame, so the
        // tokens it already burned would go unbilled. Fetch the real cost from
        // OpenRouter's /generation record so stopped turns still count.
        if (!usageSeen && (finishReason === "aborted" || signal.aborted)) {
          const gid = this.deps.client.generationId;
          if (gid) {
            const u = await this.deps.client.fetchGenerationCost(gid);
            if (u && (u.cost > 0 || u.completion_tokens > 0)) {
              this.cb.onEvent({
                type: "usage",
                usage: {
                  prompt_tokens: u.prompt_tokens,
                  completion_tokens: u.completion_tokens,
                  total_tokens: u.prompt_tokens + u.completion_tokens,
                  cost: u.cost,
                },
                cachedTokens: u.cachedTokens,
                model: servedModel ?? undefined,
              });
            }
          }
        }

        if (streamError) {
          // Salvage a transiently-killed stream when at least one COMPLETE
          // tool call arrived: drop the cut-off call, commit the rest, and
          // let the loop continue — the model re-issues what was lost. The
          // client already retried anything that died before content; this
          // covers provider stalls after tool calls started streaming.
          const completeCalls = [...toolCalls.values()].filter(isCompleteCall).length;
          if (!streamError.transient || completeCalls === 0) {
            this.cb.onEvent({ type: "error", message: streamError.message });
            this.cb.onEvent({ type: "turn_end", stopReason: "error" });
            return;
          }
          for (const [idx, c] of [...toolCalls.entries()]) {
            if (!isCompleteCall(c)) toolCalls.delete(idx);
          }
          this.cb.onEvent({
            type: "status",
            message: `Provider stalled mid-turn (${streamError.message}) — continuing with ${completeCalls} completed tool call(s).`,
          });
        }

        const entries = [...toolCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .filter(([, c]) => c.function.name);
        const calls = entries.map(([, c]) => c);
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

        // Loop guard: catch a runaway turn that keeps rewriting the same file
        // (or re-running the same command) — a classic second-guessing loop that
        // burns tokens without progress. Count mutations per target this turn;
        // when one crosses the limit, backfill results (to keep the tool_call
        // invariant) and end the turn with a clear message.
        const limit = this.deps.loopGuardLimit ?? 0;
        if (limit > 0) {
          let tripped: string | null = null;
          for (const c of calls) {
            for (const sig of this.mutatingTargets(c)) {
              const n = (this.editCounts.get(sig) ?? 0) + 1;
              this.editCounts.set(sig, n);
              if (n > limit) tripped = sig;
            }
          }
          if (tripped) {
            for (const [idx, call] of entries) {
              const pending = eager.get(idx);
              this.deps.context.addToolResult(
                call.id,
                pending ? await pending : "Skipped — loop guard stopped this turn."
              );
            }
            const target = tripped.replace(/^(file|cmd):/, "");
            this.cb.onEvent({
              type: "status",
              message: `Stopped: "${target}" was changed ${limit}+ times this turn — looks like a loop. Refine the request, or raise lunacode.loopGuardLimit (0 disables).`,
            });
            this.cb.onEvent({ type: "turn_end", stopReason: "loop" });
            return;
          }
        }

        // Execute tool calls. Eagerly-started calls just get awaited; other
        // consecutive read-only calls run CONCURRENTLY — the model pays a full
        // context pass per round-trip, so ten batched reads must cost one pass,
        // not ten sequential ones. Mutating calls (edits/commands) never race.
        // Every tool_call MUST get a matching tool result or the next request
        // will be rejected — so on abort we backfill the remaining calls.
        let i = 0;
        while (i < entries.length) {
          if (signal.aborted) {
            for (let j = i; j < entries.length; j++) {
              const [idx, call] = entries[j];
              const pending = eager.get(idx);
              this.deps.context.addToolResult(
                call.id,
                pending ? await pending : "Cancelled by user."
              );
            }
            break;
          }
          const [idx, call] = entries[i];
          const pending = eager.get(idx);
          if (pending) {
            this.deps.context.addToolResult(call.id, await pending);
            i++;
            continue;
          }
          const tool = this.toolMap.get(call.function.name);
          if (tool && !tool.mutating) {
            // Maximal run of consecutive non-eager read-only calls → parallel.
            let j = i + 1;
            while (j < entries.length && !eager.has(entries[j][0])) {
              const t = this.toolMap.get(entries[j][1].function.name);
              if (t && !t.mutating) j++;
              else break;
            }
            const batch = entries.slice(i, j).map(([, c]) => c);
            const results = await Promise.all(
              batch.map((c) => this.runToolCall(c, mode, signal, truncated))
            );
            // Append results in call order regardless of completion order.
            for (let k = 0; k < batch.length; k++) {
              this.deps.context.addToolResult(batch[k].id, results[k]);
            }
            i = j;
          } else {
            const result = await this.runToolCall(call, mode, signal, truncated);
            this.deps.context.addToolResult(call.id, result);
            i++;
          }
        }
      }
      this.cb.onEvent({
        type: "status",
        message: `Reached the ${configuredMaxTurns}-step limit for this turn.`,
      });
      this.cb.onEvent({ type: "turn_end", stopReason: "max_iterations" });
    } catch (e: any) {
      this.cb.onEvent({ type: "error", message: `Agent error: ${e?.message ?? e}` });
      this.cb.onEvent({ type: "turn_end", stopReason: "error" });
    }
  }

  /**
   * Run one tool call end-to-end (UI events included) and RETURN the result
   * content — the caller appends it to the context, so parallel batches can
   * append results in call order regardless of completion order.
   */
  private async runToolCall(
    call: ToolCall,
    mode: AgentMode,
    signal: AbortSignal,
    truncated = false
  ): Promise<string> {
    const tool = this.toolMap.get(call.function.name);
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
      this.cb.onEvent({
        type: "tool_end",
        id: call.id,
        name: call.function.name,
        ok: false,
        summary: msg,
      });
      return msg;
    }

    if (!tool) {
      const msg = `Unknown tool: ${call.function.name}`;
      this.cb.onEvent({ type: "tool_end", id: call.id, name: call.function.name, ok: false, summary: msg });
      return msg;
    }

    // Plan mode: refuse mutating tools (also filtered from the tool list).
    if (tool.mutating && !MODES[mode].allowsMutation) {
      const msg = `Blocked: ${tool.name} cannot run in Plan mode. Propose the change instead.`;
      this.cb.onEvent({ type: "tool_end", id: call.id, name: tool.name, ok: false, summary: msg });
      return msg;
    }

    const ctx: ToolContext = {
      workspaceRoot: this.deps.workspaceRoot,
      mode,
      signal,
      output: this.deps.output,
      log: (m) => this.cb.onEvent({ type: "status", message: m }),
      emitOutput: (delta) =>
        this.cb.onEvent({ type: "tool_output", id: call.id, delta }),
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
      explore: (question) =>
        runSubagent(question, {
          client: this.deps.client,
          model: this.deps.subagentModel || undefined,
          tools: toolsForSubagent(),
          workspaceRoot: this.deps.workspaceRoot,
          output: this.deps.output,
          signal,
          // Sub-agent progress streams into the explore call's own card.
          onStatus: (m) =>
            this.cb.onEvent({ type: "tool_output", id: call.id, delta: m + "\n" }),
          onUsage: (usage) =>
            this.cb.onEvent({
              type: "usage",
              usage,
              cachedTokens:
                usage.prompt_tokens_details?.cached_tokens ??
                usage.cache_read_input_tokens ??
                0,
              model: this.deps.subagentModel || undefined,
            }),
        }),
    };

    try {
      // Checkpoint each file's before-state so the user can revert this turn.
      const paths = editPaths(tool.name, args);
      if (this.deps.snapshotFile) {
        for (const p of paths) await this.deps.snapshotFile(p);
      }
      const result = await tool.execute(args, ctx);
      // Task checklist: mirror successful set_tasks calls to the UI.
      if (tool.name === "set_tasks" && !result.isError && Array.isArray(args?.tasks)) {
        this.cb.onEvent({
          type: "tasks",
          tasks: args.tasks
            .filter((t: any) => t && typeof t.label === "string")
            .map((t: any) => ({
              label: t.label,
              status: t.status === "done" ? "done" : t.status === "active" ? "active" : "pending",
            })),
        });
      }
      let content = result.content;
      if (!result.isError && paths.length) {
        // Optional: match project style before checking diagnostics.
        if (this.deps.formatAfterEdit) {
          for (const p of paths.slice(0, 5)) {
            await formatFile(this.deps.workspaceRoot, p);
          }
        }
        // Auto-verify: surface fresh language-server diagnostics for the edited
        // files in the SAME tool result — saves the model a whole round-trip
        // (a full context pass) discovering its own type errors.
        for (const p of paths.slice(0, 3)) {
          const diag = await postEditDiagnostics(this.deps.workspaceRoot, p, signal);
          if (diag) content += `\n\n${diag}`;
        }
      }
      const diff = result.ui?.diff as import("../webview/protocol").DiffData | undefined;
      this.cb.onEvent({
        type: "tool_end",
        id: call.id,
        name: tool.name,
        ok: !result.isError,
        summary: firstLine(result.content),
        diff,
      });
      return content;
    } catch (e: any) {
      const msg = `Tool ${tool.name} threw: ${e?.message ?? e}`;
      this.cb.onEvent({ type: "tool_end", id: call.id, name: tool.name, ok: false, summary: msg });
      return msg;
    }
  }
}

function firstLine(s: string): string {
  const line = s.split("\n")[0];
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}
