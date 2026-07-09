import * as fs from "fs";
import * as vscode from "vscode";
import { OpenRouterClient, isTransientFrame, usesCacheControl } from "../openrouter/client";
import {
  AssistantMessage,
  ChatMessage,
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
import {
  toolsForSubagent,
  toolsForImplementer,
  toolsForPhase,
  ToolPhase,
  toToolDefinitions,
} from "./tools";
import { formatFile, postEditDiagnostics, postEditLint } from "./tools/vscodeTools";
import { IGNORED_DIRS, readCacheInvalidatePath, truncateHeadTail } from "./tools/util";
import { runSubagent } from "./subagent";
import { LoopGuard } from "./loopGuard";
import { AgentMode, MODES } from "../modes";
import {
  StickyMemory,
  applyStickyUpdate,
  renderStickyMemory,
  stickyIsEmpty,
} from "./stickyMemory";

/** Header for STORED scratchpad snapshots (implicit-cache models). Matches the
 * ephemeral tail's wording so the model treats both forms identically. */
const SCRATCHPAD_HEADER =
  "[Session scratchpad — auto-maintained state, not a user message]";

/** Tools whose success should trigger snapshot/format/diagnostics handling. */
const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);
/** Tools that mean we've moved from research into implementation. */
const IMPLEMENT_SIGNAL = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "run_command",
  "implement",
  "start_process",
]);

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
  /** Pause for a clarifying question (ask_user tool). */
  askUser?(req: { question: string; options?: string[] }): Promise<string>;
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
  /**
   * Cheap model for research/planning iterations. When set and different from
   * the primary, read-only phases route here; implement phases use primary.
   * Empty = always use the session model.
   */
  plannerModel?: string;
  /**
   * Model for the implementer sub-agent. Empty = session model.
   */
  implementerModel?: string;
  /** Token budget for explore/implement sub-agent contexts. */
  subagentMaxContextTokens?: number;
  /** When true (default), start with read-only tool schemas and expand after
   * the first implement signal. Off = always expose the full tool set. */
  progressiveTools?: boolean;
  /** Progressive phase carried across turns (the Agent is rebuilt per turn).
   * Without this the phase resets to "read" every turn, flipping the tool
   * schema twice per turn — two full prompt-cache misses each time. */
  initialToolPhase?: ToolPhase;
  /** Persist a phase unlock back to the session so later turns start there. */
  onToolPhaseChange?: (phase: ToolPhase) => void;
  /** Adaptive reasoning: lower effort on pure tool-follow-up iterations. */
  adaptiveReasoning?: boolean;
  /** Base reasoning effort from config (undefined = model default). */
  reasoningEffort?: "off" | "low" | "medium" | "high";
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
  /** Soft-block excess mutations / identical re-issues per turn; hard-stop only
   * after consecutive fully-blocked rounds. 0/undefined = disabled. */
  loopGuardLimit?: number;
  /** Session scratchpad shared with the controller (survives compaction). */
  stickyMemory?: StickyMemory;
  /** Rebuild system prompt (e.g. after sticky memory / compaction). */
  refreshSystemPrompt?: () => void | Promise<void>;
  /** Session-lived store of per-model render digests for cache diagnostics.
   * Must outlive the Agent (rebuilt every turn) so cross-turn prefix
   * divergence — the expensive kind — is detected too. */
  cacheDigests?: Map<string, string[]>;
}

const DEFAULT_MAX_TURNS = 200;

/** FNV-1a 32-bit — cheap, dependency-free per-message digest for the cache
 * diagnostics below. Not cryptographic; collisions only risk a missed log line. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Canonicalize a rendered message for digesting: drop cache_control marks and
 * flatten single-text-part arrays back to plain strings. The rolling
 * breakpoint MOVING between calls re-shapes a message without changing its
 * content — providers tokenize both forms identically, so it must not be
 * reported as prefix divergence. */
function normalizeForDigest(m: ChatMessage): unknown {
  const clone: any = { ...m };
  const c = clone.content;
  if (Array.isArray(c)) {
    const parts = c.map((p: any) => {
      const { cache_control: _cc, ...rest } = p;
      return rest;
    });
    clone.content =
      parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
  }
  return clone;
}

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
  /** Per-turn loop guard (mutation + identical-call detection). */
  private loopGuard = new LoopGuard({ limit: 0 });
  /** Progressive tool phase for this turn. */
  private toolPhase: ToolPhase = "read";
  /** True once any implement-signal tool ran this turn. */
  private sawImplement = false;
  /** Consecutive read-only rounds (for adaptive reasoning / planner routing). */
  private readOnlyStreak = 0;
  /** Last successful verify command (smart skip). */
  private verifyCache: ToolContext["verifyCache"] = undefined;
  /** Last post-edit diagnostics block per path this turn — consecutive edits
   * with an unchanged (often pre-existing) issue list repeat one line instead
   * of the full block. */
  private lastDiagReport = new Map<string, string>();
  /** Memoized top-level dir listing that seeds explore/implement sub-agents —
   * computed on first sub-agent launch, not on every tool call. */
  private overviewCache: string | undefined | null = null;
  /** Paths edited since last successful verify. */
  private dirtySinceVerify = new Set<string>();
  /** Last status message this turn — skip consecutive identical ones. */
  private lastStatus = "";
  /** Fallback digest store when the controller doesn't supply a session-lived
   * one (e.g. tests) — covers within-turn diagnostics only. */
  private localCacheDigests = new Map<string, string[]>();

  constructor(private deps: AgentDeps, private cb: AgentCallbacks) {}

  /**
   * Cache diagnostics: log whether this request's rendered messages are a
   * pure prefix-extension of the previous request on the same model. Between
   * compaction events every call MUST extend the previous one — a DIVERGED
   * line anywhere else means the provider prompt cache was invalidated and
   * everything after the divergence point re-bills at the uncached rate.
   */
  private diagnoseCachePrefix(modelKey: string, rendered: ChatMessage[]): void {
    // Exclude the ephemeral scratchpad tail: volatile by design and rendered
    // past every breakpoint, so it never affects the cached prefix.
    let msgs = rendered;
    const last = rendered[rendered.length - 1] as any;
    if (
      last?.role === "user" &&
      typeof last.content === "string" &&
      last.content.startsWith("[Session scratchpad")
    ) {
      msgs = rendered.slice(0, -1);
    }
    const store = this.deps.cacheDigests ?? this.localCacheDigests;
    const digests = msgs.map((m) => fnv1a(JSON.stringify(normalizeForDigest(m))));
    const prev = store.get(modelKey);
    store.set(modelKey, digests);
    if (!prev) {
      this.deps.output.appendLine(
        `[cache] ${modelKey}: first call this session (${digests.length} messages)`
      );
      return;
    }
    let i = 0;
    while (i < prev.length && i < digests.length && prev[i] === digests[i]) i++;
    if (i < prev.length) {
      this.deps.output.appendLine(
        `[cache] ${modelKey}: DIVERGED at message ${i}/${prev.length} ` +
          `(role=${(msgs[i] as any)?.role ?? "removed"}) — prompt cache lost from here ` +
          `(expected only after a compaction event or user rewind)`
      );
    } else {
      this.deps.output.appendLine(
        `[cache] ${modelKey}: prefix stable through ${prev.length} messages, ` +
          `+${digests.length - prev.length} appended`
      );
    }
  }

  cancel() {
    this.abort?.abort();
  }

  /** Body of the most recent stored scratchpad snapshot, or "" — used to skip
   * re-injecting an unchanged scratchpad on the next turn. */
  private lastStickySnapshot(): string {
    const msgs = this.deps.context.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant" || typeof m.content !== "string") continue;
      if (m.content.startsWith(SCRATCHPAD_HEADER)) {
        return m.content.slice(SCRATCHPAD_HEADER.length + 1);
      }
    }
    return "";
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

  /** Top-level workspace listing for sub-agent orientation (lazy, memoized —
   * orientation-only, so per-session staleness is fine). */
  private getOverview(): string | undefined {
    if (this.overviewCache !== null) return this.overviewCache;
    try {
      const entries = fs
        .readdirSync(this.deps.workspaceRoot, { withFileTypes: true })
        .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
        .slice(0, 40)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      this.overviewCache = entries.join("  ");
    } catch {
      this.overviewCache = undefined;
    }
    return this.overviewCache;
  }

  /** Emit a status event, skipping consecutive identical messages. */
  private emitStatus(message: string) {
    if (message === this.lastStatus) return;
    this.lastStatus = message;
    this.cb.onEvent({ type: "status", message });
  }

  async run(userText: string, mode: AgentMode, images?: string[]): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.budgetApproved = false;
    this.streamedChars = 0;
    this.lastProgressAt = 0;
    this.loopGuard = new LoopGuard({ limit: this.deps.loopGuardLimit ?? 0 });
    this.toolPhase = this.deps.initialToolPhase ?? "read";
    this.sawImplement = false;
    this.readOnlyStreak = 0;
    this.dirtySinceVerify.clear();
    this.lastDiagReport.clear();
    this.lastStatus = "";
    // Implicit-prefix-cache models (OpenAI et al.) never receive the volatile
    // ephemeral tail (it would poison every cached prefix — see render()), so
    // hand them the scratchpad as a STORED message instead: appended once per
    // turn, it rides the append-only history and caches like everything else.
    // Captured BEFORE goal seeding so the first turn (scratchpad empty until
    // now) injects nothing; skipped when unchanged since the last injection.
    const stickySnapshot =
      this.deps.stickyMemory &&
      !usesCacheControl(this.deps.client.model) &&
      !stickyIsEmpty(this.deps.stickyMemory)
        ? renderStickyMemory(this.deps.stickyMemory)
        : "";
    // Seed sticky goal from the user turn when empty.
    if (this.deps.stickyMemory && !this.deps.stickyMemory.goal) {
      applyStickyUpdate(this.deps.stickyMemory, {
        goal: userText.slice(0, 400),
      });
    }
    this.deps.context.addUser(userText, images, { turnStart: true });
    if (stickySnapshot && stickySnapshot !== this.lastStickySnapshot()) {
      this.deps.context.addAssistant({
        role: "assistant",
        content: `${SCRATCHPAD_HEADER}\n${stickySnapshot}`,
      });
    }
    this.cb.onEvent({ type: "turn_start" });

    const allowsMutation = MODES[mode].allowsMutation;
    // Plan mode always gets the full read set; progressive only applies when
    // mutations are allowed and the setting is on.
    const progressive =
      !!this.deps.progressiveTools && allowsMutation && mode !== "plan";
    if (!progressive) this.toolPhase = "all";

    const rebuildTools = () => {
      const phase = progressive ? this.toolPhase : "all";
      const tools = [
        ...toolsForPhase(!allowsMutation, phase),
        ...(this.deps.extraTools ?? []).filter((t) => allowsMutation || !t.mutating),
      ];
      this.toolMap = new Map(tools.map((t) => [t.name, t]));
      // No "tight"/compact schema variant: flipping tool descriptions mid-session
      // invalidates the entire cached prefix at the moment context is largest —
      // a far bigger cost than the few hundred schema tokens it saved.
      return toToolDefinitions(tools);
    };
    let toolDefs = rebuildTools();

    // 0 = unlimited; undefined falls back to the default cap.
    const configuredMaxTurns = this.deps.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxIterations = configuredMaxTurns > 0 ? configuredMaxTurns : Infinity;

    try {
      for (let iter = 0; iter < maxIterations; iter++) {
        if (signal.aborted) {
          this.cb.onEvent({ type: "turn_end", stopReason: "cancelled" });
          return;
        }

        // Progressive tools: the session's first iterations use read/meta
        // schemas only (lower prompt tax). Expand to the full set after the
        // first research round OR any implement signal — only at iteration
        // boundaries. The unlock is persisted to the session so this schema
        // flip (a full cache miss) happens ONCE, early, while context is
        // small — never again on later turns.
        if (
          progressive &&
          this.toolPhase !== "all" &&
          (this.sawImplement || iter > 0)
        ) {
          this.toolPhase = "all";
          this.deps.onToolPhaseChange?.("all");
          toolDefs = rebuildTools();
          this.emitStatus("Unlocked full tool set for this session.");
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
            this.emitStatus("Stopped: session budget reached. Raise lunacode.sessionBudgetUsd or start a new session.");
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
          this.emitStatus("Steering message applied to the running task.");
          this.cb.onEvent({ type: "steering" });
        }

        // Hard compaction event: mutates history only when the budget is
        // exceeded; otherwise history stays append-only so the provider prompt
        // cache keeps hitting.
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
          this.emitStatus(
            compaction.summarized
              ? `Compacted context into a checkpoint (~${Math.round(compaction.tokensSaved / 1000)}k tokens saved).`
              : `Compacted older context to fit budget (summarizer unavailable — truncated instead).`
          );
          // Compaction already busts the prompt cache — piggyback a refresh of
          // the volatile system-prompt inputs (repo map, project memory) on
          // this planned miss. (The sticky scratchpad needs no re-injection:
          // it rides in the ephemeral tail, regenerated every render.)
          await this.deps.refreshSystemPrompt?.();
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

        // Dual-model routing: cheap planner for research streaks; primary for
        // implement phases / first turn / after errors.
        // Cache trade-off: provider prompt caches are PER MODEL, so each
        // planner↔primary swap re-reads the whole context uncached on the
        // model being swapped to. The planner's cheaper rate must beat that
        // double cache-warming to win — on very large contexts it may not.
        const planner = (this.deps.plannerModel || "").trim();
        const usePlanner =
          !!planner &&
          !this.sawImplement &&
          this.readOnlyStreak >= 1 &&
          mode !== "plan"; // plan mode already uses primary (or user can set planner=primary)
        // In plan mode, prefer planner when configured (research-heavy).
        const callModel =
          mode === "plan" && planner
            ? planner
            : usePlanner
              ? planner
              : undefined; // undefined = session primary

        // Adaptive reasoning: lower effort on pure tool-follow-up research
        // steps — but ONLY on planner-model calls. The planner is a different
        // model (separate prompt cache), so varying its reasoning costs
        // nothing extra. The primary model's request params must stay
        // byte-stable call-to-call: on Anthropic, any thinking-budget change
        // invalidates the message cache, turning every toggle into a full
        // uncached re-read of the conversation.
        let callReasoning = this.deps.reasoningEffort;
        if (
          this.deps.adaptiveReasoning &&
          callModel &&
          this.readOnlyStreak >= 2 &&
          !this.sawImplement
        ) {
          if (!callReasoning || callReasoning === "high" || callReasoning === "medium") {
            callReasoning = "low";
          }
        }

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
        // Chars this request sends — paired with the usage frame's exact
        // prompt_tokens to self-calibrate the token estimator.
        const sentChars =
          this.deps.context.renderChars() + JSON.stringify(toolDefs).length;
        // The volatile scratchpad tail only rides on cache_control providers;
        // implicit exact-prefix caches (OpenAI GPT-5.6+ especially) would
        // re-cache the entire prompt every call and never read it back.
        const rendered = this.deps.context.render({
          volatileTail: usesCacheControl(callModel ?? this.deps.client.model),
        });
        this.diagnoseCachePrefix(callModel ?? "primary", rendered);
        for await (const ev of this.deps.client.stream({
          messages: rendered,
          tools: toolDefs,
          temperature: this.deps.temperature,
          maxTokens: this.deps.maxTokens,
          signal,
          model: callModel,
          reasoningEffort: callReasoning,
        })) {
          switch (ev.type) {
            case "model":
              servedModel = ev.id;
              this.emitStatus(`Primary model unavailable — served by fallback ${ev.id}.`);
              break;
            case "provider":
              // Cache diagnostics: a provider change between calls means the
              // new provider's prompt cache is cold even with a perfect prefix.
              this.deps.output.appendLine(
                `[cache] ${callModel ?? "primary"}: served by provider=${ev.name}`
              );
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
            case "usage": {
              usageSeen = true;
              // Calibrate only on the session's primary model — the planner /
              // a fallback may tokenize differently. (The clamp inside makes a
              // stray sample safe regardless.)
              if (!callModel && !servedModel) {
                this.deps.context.noteObservedUsage(sentChars, ev.usage.prompt_tokens);
              }
              // Per-call cache accounting. Healthy steady state: read ≈ the
              // whole prior prefix, write ≈ just this call's new content.
              // write>0 with read=0 on every call = the prefix never matches.
              const det = ev.usage.prompt_tokens_details;
              this.deps.output.appendLine(
                `[cache] ${callModel ?? "primary"}: prompt=${ev.usage.prompt_tokens} ` +
                  `read=${det?.cached_tokens ?? 0} write=${det?.cache_write_tokens ?? 0}`
              );
              this.cb.onEvent({
                type: "usage",
                usage: ev.usage,
                cachedTokens:
                  ev.usage.prompt_tokens_details?.cached_tokens ??
                  ev.usage.cache_read_input_tokens ??
                  0,
                // Attribute planner-routed calls to the planner model — booking
                // them under the primary hides dual-model routing in the usage
                // report (exactly what masked the 0%-cache-hit incident).
                model: servedModel ?? callModel ?? undefined,
              });
              break;
            }
            case "retry":
              this.emitStatus(
                `${ev.reason} — retrying (attempt ${ev.attempt + 1} of ${ev.maxAttempts})…`
              );
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

        // Stream finished: start any remaining complete read-only tool calls
        // eagerly so a single-read round overlaps I/O with post-stream work
        // (usage salvage, loop-guard eval) instead of waiting until execute.
        for (const idx of toolCalls.keys()) maybeStartEager(idx);

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
                model: servedModel ?? callModel ?? undefined,
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
          this.emitStatus(
            `Provider stalled mid-turn (${streamError.message}) — continuing with ${completeCalls} completed tool call(s).`
          );
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

        // Track research vs implement for routing / progressive tools.
        const roundImplements = calls.some((c) => IMPLEMENT_SIGNAL.has(c.function.name));
        if (roundImplements) {
          this.sawImplement = true;
          this.readOnlyStreak = 0;
        } else {
          this.readOnlyStreak++;
        }

        // If the model hit the output-token limit, its last tool call's JSON
        // arguments are almost certainly truncated. Flag it so the parse-failure
        // message is actionable instead of a cryptic "invalid JSON".
        const truncated = finishReason === "length";

        // Loop guard: soft-block excess mutations / identical re-issues so the
        // model can adapt. Hard-stop only after consecutive fully-blocked rounds.
        const loop = this.loopGuard.evaluate(calls);
        const blocked = new Map<number, string>(); // entry index → reason
        for (let bi = 0; bi < entries.length; bi++) {
          const d = loop.decisions[bi];
          if (d?.blocked) blocked.set(bi, d.reason);
        }
        if (loop.hardStop) {
          for (let bi = 0; bi < entries.length; bi++) {
            const [idx, call] = entries[bi];
            const pending = eager.get(idx);
            const reason = blocked.get(bi) ?? "Skipped — loop guard stopped this turn.";
            this.deps.context.addToolResult(
              call.id,
              pending ? await pending : reason
            );
          }
          this.emitStatus(loop.hardStopMessage ?? "Stopped: loop guard.");
          this.cb.onEvent({ type: "turn_end", stopReason: "loop" });
          return;
        }

        // Execute tool calls. Eagerly-started calls just get awaited; other
        // consecutive read-only calls run CONCURRENTLY — the model pays a full
        // context pass per round-trip, so ten batched reads must cost one pass,
        // not ten sequential ones. Mutating calls (edits/commands) never race.
        // Every tool_call MUST get a matching tool result or the next request
        // will be rejected — so on abort we backfill the remaining calls.
        // Soft-blocked mutating calls get a reason string instead of executing.
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
          const blockReason = blocked.get(i);
          if (blockReason) {
            // Soft-block: tell the model why and continue the turn.
            let blockedArgs: any = {};
            try {
              blockedArgs = call.function.arguments
                ? JSON.parse(call.function.arguments)
                : {};
            } catch {
              /* leave empty */
            }
            this.cb.onEvent({
              type: "tool_start",
              id: call.id,
              name: call.function.name,
              args: blockedArgs,
            });
            this.cb.onEvent({
              type: "tool_end",
              id: call.id,
              name: call.function.name,
              ok: false,
              summary: blockReason,
            });
            this.deps.context.addToolResult(call.id, blockReason);
            i++;
            continue;
          }
          const pending = eager.get(idx);
          if (pending) {
            this.deps.context.addToolResult(call.id, await pending);
            i++;
            continue;
          }
          const tool = this.toolMap.get(call.function.name);
          if (tool && !tool.mutating) {
            // Maximal run of consecutive non-eager, non-blocked read-only calls → parallel.
            let j = i + 1;
            while (j < entries.length && !eager.has(entries[j][0]) && !blocked.has(j)) {
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
      this.emitStatus(`Reached the ${configuredMaxTurns}-step limit for this turn.`);
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
      // Progressive tools: if the model asked for an edit/exec tool before unlock,
      // mark implement so the next iteration expands the schema.
      if (
        IMPLEMENT_SIGNAL.has(call.function.name) ||
        EDIT_TOOLS.has(call.function.name)
      ) {
        this.sawImplement = true;
      }
      const msg =
        `Unknown tool: ${call.function.name}.` +
        (this.toolPhase === "read"
          ? " Edit/exec tools unlock after the first implement signal — retry next step."
          : "");
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
      log: (m) => this.emitStatus(m),
      emitOutput: (delta) =>
        this.cb.onEvent({ type: "tool_output", id: call.id, delta }),
      context: this.deps.context,
      stickyMemory: this.deps.stickyMemory,
      verifyCache: this.verifyCache,
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
      askUser: this.cb.askUser
        ? (req) => this.cb.askUser!(req)
        : undefined,
      explore: (question) =>
        runSubagent(question, {
          client: this.deps.client,
          model: this.deps.subagentModel || this.deps.plannerModel || undefined,
          tools: toolsForSubagent(),
          workspaceRoot: this.deps.workspaceRoot,
          workspaceOverview: this.getOverview(),
          output: this.deps.output,
          signal,
          maxContextTokens: this.deps.subagentMaxContextTokens,
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
              model: this.deps.subagentModel || this.deps.plannerModel || undefined,
            }),
        }),
      implement:
        allowsMutationFor(mode)
          ? (task) =>
              runSubagent(task, {
                client: this.deps.client,
                model:
                  this.deps.implementerModel ||
                  this.deps.subagentModel ||
                  undefined,
                tools: toolsForImplementer(),
                workspaceRoot: this.deps.workspaceRoot,
                workspaceOverview: this.getOverview(),
                output: this.deps.output,
                signal,
                maxContextTokens: this.deps.subagentMaxContextTokens,
                // Write-capable: use a tighter iteration budget via prompt.
                systemPromptExtra:
                  "You MAY edit files and run safe commands to complete the task. Prefer apply_patch/edit_file. When done, reply with a concise summary: files changed, what you did, and any remaining risks. Do not ask questions.",
                maxIterations: 16,
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
                    model:
                      this.deps.implementerModel ||
                      this.deps.subagentModel ||
                      undefined,
                  }),
              })
          : undefined,
    };

    try {
      // Checkpoint each file's before-state so the user can revert this turn.
      const paths = editPaths(tool.name, args);
      if (this.deps.snapshotFile) {
        for (const p of paths) await this.deps.snapshotFile(p);
      }
      let result = await tool.execute(args, ctx);
      // Auto-retry transient errors on read-only tools and run_command (not writes).
      if (result.isError && (!tool.mutating || tool.name === "run_command")) {
        const transient = /timeout|ECONNRESET|EAGAIN|temporarily|busy|locked|ETIMEDOUT|ENOTFOUND/i.test(result.content ?? "");
        if (transient) {
          await new Promise((r) => setTimeout(r, 400));
          result = await tool.execute(args, ctx);
        }
      }
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
      // Keep sticky memory in sync with edits / memory tool.
      if (!result.isError && paths.length) {
        for (const p of paths) this.dirtySinceVerify.add(p);
        // Invalidate smart-verify skip — code changed since last green run.
        this.verifyCache = undefined;
        if (this.deps.stickyMemory) {
          applyStickyUpdate(this.deps.stickyMemory, { filesTouched: paths });
        }
      }
      // (update_memory needs no prompt rebuild: the scratchpad rides in the
      // ephemeral tail, which re-renders on every API call.)
      // Smart verify cache: remember last successful test/build command.
      if (tool.name === "run_command" && !result.isError && typeof args.command === "string") {
        const cmd = args.command.trim();
        if (/\b(test|check|lint|typecheck|tsc|pytest|jest|vitest|cargo test|go test|npm test|pnpm test|yarn test)\b/i.test(cmd)) {
          this.verifyCache = {
            command: cmd,
            exitCode: 0,
            at: Date.now(),
            pathsHint: [...this.dirtySinceVerify],
          };
          this.dirtySinceVerify.clear();
          if (this.deps.stickyMemory) {
            applyStickyUpdate(this.deps.stickyMemory, {
              commands: { test: cmd },
              clearErrors: true,
            });
          }
        }
      }
      let content = result.content;
      if (!result.isError && paths.length) {
        // NOTE: prior reads of these paths are NOT stubbed here — message
        // history must stay append-only between compaction events or the
        // provider prompt cache misses from the mutated message onward on
        // every subsequent call. compactIfNeeded's supersession pass stubs
        // pre-edit reads at the next planned cache miss instead.
        // Invalidate the in-memory read cache so subsequent reads fetch fresh data.
        for (const p of paths) readCacheInvalidatePath(p);
        // Optional: match project style before checking diagnostics — format
        // stays AHEAD of diagnostics (it can change them); distinct files
        // format concurrently.
        if (this.deps.formatAfterEdit) {
          await Promise.all(
            paths.slice(0, 5).map((p) => formatFile(this.deps.workspaceRoot, p))
          );
        }
        // Auto-verify: surface fresh language-server diagnostics + lint for the
        // edited files in the SAME tool result — saves the model a whole
        // round-trip (a full context pass) discovering its own type errors.
        // Gathered concurrently (each diagnostics pass sleeps 400ms for the
        // language server; overlapping saves ~1-2.5s on multi-file edits),
        // appended in stable path order.
        const diagPaths = paths.slice(0, 3);
        const [diagResults, lintRaw] = await Promise.all([
          Promise.all(
            diagPaths.map((p) => postEditDiagnostics(this.deps.workspaceRoot, p, signal))
          ),
          postEditLint(this.deps.workspaceRoot, paths[0]).catch(() => null),
        ]);
        let appendix = "";
        for (let d = 0; d < diagPaths.length; d++) {
          const diag = diagResults[d];
          if (!diag) {
            this.lastDiagReport.delete(diagPaths[d]);
            continue;
          }
          // Consecutive edits often leave a pre-existing warning list
          // unchanged — repeat it as one line, not the full block again.
          if (this.lastDiagReport.get(diagPaths[d]) === diag) {
            appendix += `\n\nDiagnostics for ${diagPaths[d]} unchanged since the previous edit (see earlier result).`;
          } else {
            this.lastDiagReport.set(diagPaths[d], diag);
            appendix += `\n\n${diag}`;
          }
        }
        if (lintRaw) {
          const lint = filterLintAgainstDiagnostics(lintRaw, paths[0], diagResults[0]);
          if (lint) appendix += `\n\n${lint}`;
        }
        // Cap the combined appendix; head+tail so both the first errors and
        // the trailing summary survive.
        if (appendix) content += truncateHeadTail(appendix, 3500).text;
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

function allowsMutationFor(mode: AgentMode): boolean {
  return MODES[mode].allowsMutation;
}

/**
 * Drop lint lines that duplicate just-reported language-server diagnostics for
 * the same file (eslint-style linters often surface through both channels).
 * Matching is by line number: diagnostics lines are `path:LINE:COL [sev] …`,
 * lint lines carry `:LINE:` or `line LINE, col`. If nothing actionable
 * survives, the whole block (including its `[Lint exit N]` header) is dropped.
 */
function filterLintAgainstDiagnostics(
  lint: string,
  primaryPath: string,
  diagBlock: string | null | undefined
): string {
  if (!diagBlock) return lint;
  const reported = new Set<string>();
  for (const m of diagBlock.matchAll(/:(\d+):\d+ \[/g)) reported.add(m[1]);
  if (!reported.size) return lint;
  const base = primaryPath.split(/[\\/]/).pop() ?? primaryPath;
  const kept = lint.split("\n").filter((ln) => {
    if (!ln.includes(base)) return true; // other files / headers stay
    const m = ln.match(/(?::(\d+):\d+|line (\d+), col)/);
    const lineNo = m?.[1] ?? m?.[2];
    return !(lineNo && reported.has(lineNo));
  });
  // Only the header / summary noise left → skip the block entirely.
  const actionable = kept.some((ln) => /:\d+:\d+|line \d+, col/.test(ln));
  return actionable ? kept.join("\n") : "";
}

function firstLine(s: string): string {
  const line = s.split("\n")[0];
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}
