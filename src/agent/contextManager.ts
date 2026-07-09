import {
  AssistantMessage,
  ChatMessage,
  ContentPart,
  SystemMessage,
  TextPart,
} from "../openrouter/types";

export interface CompactionOptions {
  /** Fraction of the budget to compact down to (the "floor"). */
  targetRatio: number;
  /** Summarize a span of messages into a checkpoint; null on any failure. */
  summarize?: (span: ChatMessage[]) => Promise<{ text: string } | null>;
}

export interface CompactionResult {
  tokensSaved: number;
  summarized: boolean;
  deduped: number;
}

/** Per-role / tool-result breakdown for the context inspector. */
export interface ContextBreakdown {
  totalTokens: number;
  systemTokens: number;
  byRole: { role: string; tokens: number; count: number }[];
  /** Largest individual messages (tool results include tool name when known). */
  largest: { role: string; preview: string; tokens: number }[];
  /** Count of tool results already stubbed as superseded/truncated. */
  stubbedToolResults: number;
  messageCount: number;
}

/** Read-only / re-runnable tools whose repeated identical results are safe to
 * supersede (latest occurrence wins). */
const DEDUPE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "run_command",
  "get_diagnostics",
  "file_outline",
  "find_symbol",
  "find_references",
  "read_process",
  "explore",
  "git_status",
  "git_diff",
  "git_log",
]);

/** Tools whose results are keyed by a file path and can be path-superseded. */
const PATH_SCOPED_TOOLS = new Set(["read_file", "file_outline"]);

/** Edit tools that invalidate prior path-scoped reads of the same file. */
const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

/** Token headroom reserved for the checkpoint summary that replaces a span. */
const SUMMARY_ALLOWANCE_TOKENS = 800;

/** Compaction truncation pass: stub older tool results larger than this (chars). */
const STUB_MIN_CHARS = 1500;
/** Compaction truncation pass: chars kept when stubbing a large tool result. */
const STUB_KEEP_CHARS = 400;

/** Stable stringify (sorted keys) so arg order never splits identity keys.
 * Undefined-valued keys are dropped (JSON semantics): callers probing with
 * `{path, offset: undefined}` must match a model call of just `{path}`. */
function canonicalizeArgs(args: any): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args);
  if (Array.isArray(args)) return "[" + args.map(canonicalizeArgs).join(",") + "]";
  return (
    "{" +
    Object.keys(args)
      .filter((k) => args[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalizeArgs(args[k]))
      .join(",") +
    "}"
  );
}

/**
 * Heuristic token estimate used until the session self-calibrates from real
 * usage frames (see ContextManager.noteObservedUsage). ~3.5 chars/token for
 * ASCII-heavy code, denser for CJK-heavy content.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let nonAscii = 0;
  for (const m of messages) {
    const c = messageChars(m);
    chars += c;
    // Sample the string content for non-ASCII density without a second full walk
    // when content is already counted in messageChars — approximate via ratio on
    // short previews only when cheap.
    const preview =
      typeof (m as any).content === "string"
        ? ((m as any).content as string).slice(0, 400)
        : "";
    for (let i = 0; i < preview.length; i++) {
      if (preview.charCodeAt(i) > 127) nonAscii++;
    }
  }
  // More non-ASCII → closer to 2–3 chars/token; pure ASCII ~3.5
  // (code is denser than prose due to punctuation/whitespace).
  const sample = Math.max(1, Math.min(chars, 400 * messages.length));
  const density = nonAscii / sample;
  const charsPerToken = density > 0.3 ? 2.5 : density > 0.1 ? 3.0 : 3.5;
  return Math.ceil(chars / charsPerToken);
}

function messageChars(m: ChatMessage): number {
  let chars = 0;
  if (typeof m.content === "string") chars += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part.type === "text") chars += part.text.length;
      else chars += 1000; // images approximate
    }
  }
  if ("tool_calls" in m && m.tool_calls) {
    for (const tc of m.tool_calls) {
      chars += tc.function.name.length + tc.function.arguments.length;
    }
  }
  return chars;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p?.type === "text" ? p.text : "[image]"))
      .join(" ");
  }
  return "";
}

function isStubbedContent(content: string): boolean {
  return (
    content.startsWith("[superseded:") ||
    content.startsWith("[stale:") ||
    content.includes("[older tool output truncated") ||
    // Legacy marker from 0.3.0's (removed) soft-microcompact — persisted
    // sessions may still contain these stubs.
    content.includes("[microcompact:")
  );
}

/**
 * Holds the conversation and renders the request message array with prompt-cache
 * breakpoints on stable prefixes.
 *
 * Cache strategy (forwarded by OpenRouter to Anthropic/Gemini):
 *  - The system prompt gets a cache_control breakpoint at its end (fully static
 *    across the session).
 *  - A rolling breakpoint is placed on the last message of the prior turn so the
 *    entire accumulated conversation becomes a cached prefix for the next turn.
 * Because the static system prompt never changes and new content is only ever
 * appended, every request after the first reuses the cached prefix.
 *
 * INVARIANT: `messages` is append-only except inside compactIfNeeded (and
 * user-initiated rollback). Every render() must be a prefix-extension of the
 * previous render() between compaction events — providers with implicit
 * caching (OpenAI et al.) match on the longest common prefix, so ANY in-place
 * rewrite of an earlier message re-bills everything after it at the uncached
 * rate on every subsequent call. All lossy mutations (dedupe, path
 * supersession, truncation, summarize) are batched inside the compaction
 * event, whose cache miss is planned and rare.
 */
export class ContextManager {
  private systemPrompt = "";
  private messages: ChatMessage[] = [];
  /** Supplier for a volatile block appended to the RENDERED request after all
   * stored messages (e.g. the sticky scratchpad). It is never stored in
   * `messages` and never holds a cache breakpoint, so it sits past the rolling
   * breakpoint and can change every call without invalidating the cached
   * prefix — unlike volatile text in the system prompt, which busts the whole
   * prefix on every change. */
  private ephemeralTail: (() => string) | null = null;
  // Stable per-message ids, index-aligned with `messages`. `messages` is spliced
  // by compaction and rollback, so positional indices are not stable across
  // turns — ids are. `turnStartIds` marks the ids that begin a turn (vs. mid-turn
  // steering); the rewind feature targets turn starts.
  private ids: number[] = [];
  private idSeq = 0;
  private turnStartIds = new Set<number>();

  constructor(private cachingEnabled: boolean) {}

  /** The id the NEXT added message will receive. Captured at turn start so the
   * controller can tie a turn to its initiating user message deterministically. */
  peekIdSeq(): number {
    return this.idSeq;
  }

  /** Live index of a message id, or -1 if it was compacted/rolled away. */
  indexOfId(id: number): number {
    return this.ids.indexOf(id);
  }

  /** Turn-initiating user messages still present, oldest first — the rewind
   * targets. */
  getTurnStarts(): Array<{ id: number; index: number; text: string }> {
    const out: Array<{ id: number; index: number; text: string }> = [];
    for (let i = 0; i < this.messages.length; i++) {
      const id = this.ids[i];
      if (!this.turnStartIds.has(id)) continue;
      out.push({ id, index: i, text: this.userTextAndImages(this.messages[i]).text });
    }
    return out;
  }

  /** Keep `ids` aligned with a splice on `messages`: drop the removed ids from
   * `turnStartIds` and insert `insertCount` fresh (non-turn-start) ids. */
  private spliceIds(start: number, deleteCount: number, insertCount: number) {
    const fresh: number[] = [];
    for (let i = 0; i < insertCount; i++) fresh.push(this.idSeq++);
    const removed = this.ids.splice(start, deleteCount, ...fresh);
    for (const rid of removed) this.turnStartIds.delete(rid);
  }

  setSystemPrompt(text: string) {
    this.systemPrompt = text;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  setCaching(enabled: boolean) {
    this.cachingEnabled = enabled;
  }

  setEphemeralTail(fn: (() => string) | null) {
    this.ephemeralTail = fn;
  }

  /** The ephemeral tail as a message, or null when empty. Shared by render()
   * and estimate() so budget math counts what is actually sent. */
  private renderTail(): ChatMessage | null {
    const tail = this.ephemeralTail?.() ?? "";
    if (!tail) return null;
    return {
      role: "user",
      content: `[Session scratchpad — auto-maintained state, not a user message]\n${tail}`,
    };
  }

  reset() {
    this.messages = [];
    this.ids = [];
    this.turnStartIds.clear();
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /** Replace the conversation (used when loading a saved session).
   * `turnStartIndices` (indices into `messages`) restores which messages begin a
   * turn so rewind targets survive a reload. */
  loadMessages(messages: ChatMessage[], turnStartIndices?: number[]) {
    this.messages = messages.map((m) => ({ ...m }));
    this.ids = this.messages.map(() => this.idSeq++);
    this.turnStartIds = new Set(
      (turnStartIndices ?? []).map((i) => this.ids[i]).filter((id): id is number => id !== undefined)
    );
  }

  addUser(text: string, images?: string[], opts?: { turnStart?: boolean }) {
    const id = this.idSeq++;
    if (opts?.turnStart) this.turnStartIds.add(id);
    if (images && images.length) {
      const parts: ContentPart[] = [{ type: "text", text }];
      for (const url of images) {
        parts.push({ type: "image_url", image_url: { url } });
      }
      this.messages.push({ role: "user", content: parts });
      this.ids.push(id);
      return;
    }
    this.messages.push({ role: "user", content: text });
    this.ids.push(id);
  }

  addAssistant(msg: AssistantMessage) {
    this.messages.push(msg);
    this.ids.push(this.idSeq++);
  }

  addToolResult(toolCallId: string, content: string) {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
    this.ids.push(this.idSeq++);
  }

  /** Observed chars-per-token (EMA over real usage frames); 0 = uncalibrated. */
  private observedCharsPerToken = 0;

  /**
   * Self-calibrate the token estimator from a real usage frame: the exact
   * request chars are known (renderChars + tool schema) and the provider
   * returns exact prompt_tokens on every call. No tokenizer dependency; the
   * clamp keeps a rogue frame (e.g. a fallback model with a different
   * tokenizer) from distorting the budget, and the EMA recovers regardless.
   */
  noteObservedUsage(sentChars: number, promptTokens: number) {
    if (!promptTokens || promptTokens < 4000 || sentChars <= 0) return;
    const ratio = Math.min(5.5, Math.max(2.0, sentChars / promptTokens));
    this.observedCharsPerToken = this.observedCharsPerToken
      ? 0.7 * this.observedCharsPerToken + 0.3 * ratio
      : ratio;
  }

  /** Chars → tokens with the calibrated ratio (3.5 until first observation).
   * The single divisor for ALL budget math — estimate, breakdown, and
   * compaction-span sizing must agree or spans get mis-sized. */
  private toTokens(chars: number): number {
    return Math.ceil(chars / (this.observedCharsPerToken || 3.5));
  }

  /** Chars that render() would send (system + messages + ephemeral tail),
   * excluding tool schemas — the caller adds those. */
  renderChars(): number {
    let chars = this.systemPrompt.length;
    for (const m of this.messages) chars += messageChars(m);
    const tail = this.renderTail();
    if (tail) chars += messageChars(tail);
    return chars;
  }

  /** Total estimated tokens including the system prompt and ephemeral tail. */
  estimate(): number {
    if (this.observedCharsPerToken) return this.toTokens(this.renderChars());
    // Uncalibrated: fall back to the non-ASCII-density heuristic.
    const sys: SystemMessage = { role: "system", content: this.systemPrompt };
    const tail = this.renderTail();
    return estimateTokens(tail ? [sys, ...this.messages, tail] : [sys, ...this.messages]);
  }

  /**
   * Compact the history when it exceeds the budget.
   *
   * This is an EVENT, not a steady-state trimmer: between events the history is
   * append-only so the provider's prompt cache stays valid (reads at ~0.1x input
   * price). When the estimate crosses `maxTokens` we pay one cache miss and
   * drive the context all the way down to `maxTokens * targetRatio`, so the
   * next event is many turns away. All lossy operations (dedup, summarize,
   * truncate) are batched inside the event because the cache is invalidated at
   * that moment anyway.
   */
  async compactIfNeeded(
    maxTokens: number,
    opts: CompactionOptions
  ): Promise<CompactionResult | null> {
    if (this.estimate() <= maxTokens) return null;
    const before = this.estimate();
    const target = Math.floor(maxTokens * opts.targetRatio);

    // Pass A: supersede stale duplicate tool results + path-scoped reads, and
    // truncate large tool results from turns before the current one. All
    // content-only mutations ride this event — the cache is already being
    // invalidated, so batching them here keeps every non-event call a pure
    // prefix-extension (100% cache read).
    let deduped = this.dedupeStaleToolResults();
    deduped += this.supersedeStalePathReads();
    deduped += this.truncateLargeOlderToolResults(STUB_MIN_CHARS, STUB_KEEP_CHARS);

    // Pass B: summarize-and-replace the oldest span down to the target floor.
    // Run it even if Pass A already got under maxTokens — stopping just under
    // the trigger would fire another (cache-missing) event a few turns later.
    let summarized = false;
    const span = this.selectCompactionSpan(target);
    if (span) {
      const spanMessages = this.messages.slice(span.start, span.end);
      const summary = opts.summarize ? await opts.summarize(spanMessages) : null;
      if (summary && summary.text.trim().length > 0) {
        this.messages.splice(span.start, span.end - span.start, {
          role: "assistant",
          content:
            "[Luna Code checkpoint — earlier conversation summarized]\n" +
            summary.text.trim(),
        });
        this.spliceIds(span.start, span.end - span.start, 1);
        summarized = true;
      } else {
        this.legacyCompact(span.start, target);
      }
    }

    // Emergency: giant tool results in the protected tail can keep us over the
    // hard budget. Truncate tail tool outputs oldest-first until under.
    if (this.estimate() > maxTokens) {
      for (const m of this.messages) {
        if (this.estimate() <= maxTokens) break;
        if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500) {
          m.content =
            m.content.slice(0, 1200) + `\n…[older tool output truncated to save context]`;
        }
      }
    }

    return {
      tokensSaved: Math.max(0, before - this.estimate()),
      summarized,
      deduped,
    };
  }

  /** Breakdown of what's in the context window (for the inspector UI). */
  breakdown(): ContextBreakdown {
    const systemTokens = this.toTokens(this.systemPrompt.length);
    const byRoleMap = new Map<string, { tokens: number; count: number }>();
    byRoleMap.set("system", { tokens: systemTokens, count: 1 });

    const callMeta = this.indexToolCalls();
    let stubbedToolResults = 0;
    const sized: { role: string; preview: string; tokens: number }[] = [];
    let messageTokens = 0;

    for (const m of this.messages) {
      const tokens = this.toTokens(messageChars(m));
      messageTokens += tokens;
      const cur = byRoleMap.get(m.role) ?? { tokens: 0, count: 0 };
      cur.tokens += tokens;
      cur.count += 1;
      byRoleMap.set(m.role, cur);

      if (m.role === "tool") {
        const meta = callMeta.get(m.tool_call_id);
        const label = meta
          ? `tool:${meta.name}${meta.path ? " " + meta.path : ""}`
          : "tool";
        const content = typeof m.content === "string" ? m.content : "";
        if (isStubbedContent(content)) stubbedToolResults++;
        sized.push({
          role: label,
          preview: content.replace(/\s+/g, " ").slice(0, 70),
          tokens,
        });
      } else {
        const preview = textOf(m.content).replace(/\s+/g, " ").slice(0, 70);
        let roleLabel: string = m.role;
        if (m.role === "assistant" && "tool_calls" in m && m.tool_calls?.length && !preview) {
          roleLabel = `assistant→${m.tool_calls.map((tc) => tc.function.name).join(",")}`;
        }
        sized.push({ role: roleLabel, preview, tokens });
      }
    }

    return {
      totalTokens: systemTokens + messageTokens,
      systemTokens,
      byRole: [...byRoleMap.entries()]
        .map(([role, v]) => ({ role, tokens: v.tokens, count: v.count }))
        .sort((a, b) => b.tokens - a.tokens),
      largest: sized.sort((a, b) => b.tokens - a.tokens).slice(0, 8),
      stubbedToolResults,
      messageCount: this.messages.length,
    };
  }

  /**
   * Replace all-but-the-latest results of repeated identical read-only tool
   * calls with a one-line stub. Identity is derived from the paired assistant
   * `tool_calls` (name + canonicalized args), so it works for live and
   * persisted sessions alike. Content-only replacement — message roles and
   * ordering are untouched, so API invariants hold.
   */
  private dedupeStaleToolResults(): number {
    const callInfo = new Map<string, string>(); // tool_call_id -> identity key
    const callLabel = new Map<string, string>(); // tool_call_id -> human label
    for (const m of this.messages) {
      if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls) continue;
      for (const tc of m.tool_calls) {
        if (!DEDUPE_TOOLS.has(tc.function.name)) continue;
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          const key = tc.function.name + "|" + canonicalizeArgs(args);
          callInfo.set(tc.id, key);
          const primary = args.path ?? args.pattern ?? args.command ?? args.question ?? args.id ?? "";
          callLabel.set(tc.id, `${tc.function.name} ${primary}`.trim());
        } catch {
          // Unparsable args: never stub blindly.
        }
      }
    }

    // Group tool-result message indexes by identity key, in order.
    const groups = new Map<string, number[]>();
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role !== "tool") continue;
      const key = callInfo.get(m.tool_call_id);
      if (!key) continue;
      const list = groups.get(key);
      if (list) list.push(i);
      else groups.set(key, [i]);
    }

    let stubbed = 0;
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      for (const i of indexes.slice(0, -1)) {
        const m = this.messages[i];
        if (m.role !== "tool" || typeof m.content !== "string") continue;
        if (isStubbedContent(m.content)) continue;
        const label = callLabel.get(m.tool_call_id) ?? "this call";
        m.content = `[superseded: ${label} was re-run later in this conversation — see the newer result]`;
        stubbed++;
      }
    }
    return stubbed;
  }

  /**
   * Path-scoped supersession for read_file / file_outline.
   *
   * IMPORTANT: different offset/limit pages of the same file are NOT duplicates —
   * the agent pages large files on purpose. We only collapse:
   *  1. Re-reads of the *same* path + range (offset/limit), keeping the latest.
   *  2. Any path-scoped read that precedes an edit of that path (pre-edit contents
   *     are stale regardless of range).
   */
  private supersedeStalePathReads(): number {
    const callMeta = this.indexToolCalls();
    // Same path + same range → true re-read of that page.
    const byPathRange = new Map<string, number[]>();
    // All ranges of a path (for edit invalidation).
    const byPath = new Map<string, number[]>();
    // Track the message index of the first edit of each path.
    const firstEditIdx = new Map<string, number>();

    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (!EDIT_TOOLS.has(tc.function.name)) continue;
          for (const p of editPathsFromCall(tc.function.name, tc.function.arguments)) {
            const key = normalizePathKey(p);
            if (!firstEditIdx.has(key)) firstEditIdx.set(key, i);
          }
        }
      }
      if (m.role !== "tool") continue;
      const meta = callMeta.get(m.tool_call_id);
      if (!meta || !PATH_SCOPED_TOOLS.has(meta.name) || !meta.path) continue;
      const pathKey = normalizePathKey(meta.path);
      const rangeKey = `${pathKey}|${meta.rangeKey ?? ""}`;
      const rangeList = byPathRange.get(rangeKey);
      if (rangeList) rangeList.push(i);
      else byPathRange.set(rangeKey, [i]);
      const pathList = byPath.get(pathKey);
      if (pathList) pathList.push(i);
      else byPath.set(pathKey, [i]);
    }

    let stubbed = 0;
    // (1) Same path+range re-read: keep latest, stub earlier.
    for (const [rangeKey, indexes] of byPathRange) {
      for (const i of indexes.slice(0, -1)) {
        const m = this.messages[i];
        if (m.role !== "tool" || typeof m.content !== "string") continue;
        if (isStubbedContent(m.content)) continue;
        const meta = callMeta.get(m.tool_call_id);
        const pathPart = meta?.path ?? rangeKey.split("|")[0];
        const rangeHint = meta?.rangeKey && meta.rangeKey !== ":" ? ` [${meta.rangeKey}]` : "";
        m.content = `[superseded: ${meta?.name ?? "read"} ${pathPart}${rangeHint} — a newer read of this range is later in the conversation]`;
        stubbed++;
      }
    }
    // (2) Edit invalidation: any pre-edit read of the path is stale (all ranges).
    for (const [pathKey, indexes] of byPath) {
      const editAt = firstEditIdx.get(pathKey);
      if (editAt === undefined) continue;
      for (const i of indexes) {
        if (i >= editAt) continue;
        const m = this.messages[i];
        if (m.role !== "tool" || typeof m.content !== "string") continue;
        if (isStubbedContent(m.content)) continue;
        const meta = callMeta.get(m.tool_call_id);
        m.content = `[stale: ${meta?.name ?? "read"} ${meta?.path ?? pathKey} — file was edited later; re-read if you need current contents]`;
        stubbed++;
      }
    }
    return stubbed;
  }

  /**
   * Truncate large tool results that sit before the last user message (older
   * than the active task). Content-only; keeps a short head for orientation.
   * Only called from inside the compaction event (the planned cache miss).
   */
  private truncateLargeOlderToolResults(minChars: number, keepChars: number): number {
    const lastUser = this.lastUserIndex();
    if (lastUser <= 0) return 0;
    let stubbed = 0;
    for (let i = 0; i < lastUser; i++) {
      const m = this.messages[i];
      if (m.role !== "tool" || typeof m.content !== "string") continue;
      if (m.content.length <= minChars) continue;
      if (isStubbedContent(m.content)) continue;
      m.content =
        m.content.slice(0, keepChars) +
        `\n…[older tool output truncated (${m.content.length} → ${keepChars} chars) to save context]`;
      stubbed++;
    }
    return stubbed;
  }

  /** Map tool_call_id → { name, path?, rangeKey? } from assistant tool_calls.
   * rangeKey is "offset:limit" for paged reads so different pages don't collide. */
  private indexToolCalls(): Map<string, { name: string; path?: string; rangeKey?: string }> {
    const map = new Map<string, { name: string; path?: string; rangeKey?: string }>();
    for (const m of this.messages) {
      if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls) continue;
      for (const tc of m.tool_calls) {
        let path: string | undefined;
        let rangeKey: string | undefined;
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          if (typeof args.path === "string") path = args.path;
          if (PATH_SCOPED_TOOLS.has(tc.function.name)) {
            // Normalize missing offset/limit to empty so full-file reads group together.
            const off = args.offset != null && Number.isFinite(Number(args.offset)) ? Number(args.offset) : "";
            const lim = args.limit != null && Number.isFinite(Number(args.limit)) ? Number(args.limit) : "";
            rangeKey = `${off}:${lim}`;
          }
        } catch {
          /* ignore */
        }
        map.set(tc.id, { name: tc.function.name, path, rangeKey });
      }
    }
    return map;
  }

  /**
   * Find a non-stubbed tool result already in the conversation for the same
   * tool name + canonical args. Used by read tools to short-circuit duplicate
   * lookups (saves tokens on the next model call).
   */
  findLiveToolResult(
    toolName: string,
    args: Record<string, unknown>
  ): { label: string; content: string } | null {
    const key = toolName + "|" + canonicalizeArgs(args ?? {});
    // Walk newest → oldest so we return the latest live result.
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "tool" || typeof m.content !== "string") continue;
      if (isStubbedContent(m.content)) continue;
      // Find the assistant tool_call that produced this result.
      let matched = false;
      let label = toolName;
      for (let j = i - 1; j >= 0; j--) {
        const a = this.messages[j];
        if (a.role !== "assistant" || !("tool_calls" in a) || !a.tool_calls) continue;
        const tc = a.tool_calls.find((t) => t.id === m.tool_call_id);
        if (!tc) continue;
        if (tc.function.name !== toolName) break;
        try {
          const tcArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          if (toolName + "|" + canonicalizeArgs(tcArgs) === key) {
            matched = true;
            const primary =
              tcArgs.path ?? tcArgs.pattern ?? tcArgs.command ?? tcArgs.query ?? tcArgs.question ?? "";
            label = primary ? `${toolName} ${primary}` : toolName;
          }
        } catch {
          /* ignore */
        }
        break;
      }
      if (matched) {
        return { label, content: m.content };
      }
    }
    return null;
  }

  /**
   * Choose the span [start, end) of oldest messages to summarize away. Keeps
   * the first user message (original intent) and everything from the last user
   * message onward (the active task). Extends past orphaned tool results so
   * the first kept message never leads with role "tool".
   */
  private selectCompactionSpan(target: number): { start: number; end: number } | null {
    const firstUserIdx = this.messages.findIndex((m) => m.role === "user");
    if (firstUserIdx < 0) return null;
    const lastUserIdx = this.lastUserIndex();
    const start = firstUserIdx + 1;
    if (lastUserIdx <= start) return null;

    const overage = this.estimate() - target;
    let spanTokens = 0;
    let end = start;
    while (end < lastUserIdx && spanTokens - SUMMARY_ALLOWANCE_TOKENS < overage) {
      // Same divisor as estimate() — a mismatch here mis-sizes the span and
      // systematically over- or under-summarizes.
      spanTokens += this.toTokens(messageChars(this.messages[end]));
      end++;
    }
    // Never strand a tool result at the new boundary.
    while (end < lastUserIdx && this.messages[end]?.role === "tool") end++;

    // Not worth a summarizer round-trip (and the summary could outweigh the
    // removed content) — let the emergency path handle tail-heavy overage.
    if (end - start < 2 || spanTokens < SUMMARY_ALLOWANCE_TOKENS * 2) return null;
    return { start, end };
  }

  /** Fallback when no summary is available: truncate then drop to target. */
  private legacyCompact(start: number, target: number) {
    // Running total instead of re-walking every message per iteration —
    // estimate() per removed message made this O(n²) in message chars.
    let total = this.estimate();
    // Truncate big tool outputs first (cheapest loss).
    for (const m of this.messages) {
      if (total <= target) break;
      if (m === this.messages[this.lastUserIndex()]) break;
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500) {
        const beforeChars = m.content.length;
        m.content =
          m.content.slice(0, 1200) + `\n…[older tool output truncated to save context]`;
        total -= this.toTokens(beforeChars - m.content.length);
      }
    }
    // Then drop the oldest messages, sweeping orphaned tool results so a tool
    // message never leads the boundary, and never touching the active task.
    let removedCount = 0;
    while (total > target && start < this.lastUserIndex()) {
      total -= this.toTokens(messageChars(this.messages[start]));
      this.messages.splice(start, 1);
      this.spliceIds(start, 1, 0);
      removedCount++;
      while (start < this.lastUserIndex() && this.messages[start]?.role === "tool") {
        total -= this.toTokens(messageChars(this.messages[start]));
        this.messages.splice(start, 1);
        this.spliceIds(start, 1, 0);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      this.messages.splice(start, 0, {
        role: "assistant",
        content: `[Luna Code: ${removedCount} earlier message(s) were dropped to stay within the context budget. Re-read any files if you need their current contents.]`,
      });
      this.spliceIds(start, 0, 1);
    }
  }

  private lastUserIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") return i;
    }
    return -1;
  }

  /** Build the final messages array for an API request, with cache breakpoints.
   *
   * `volatileTail: false` omits the ephemeral tail. Required for implicit
   * exact-prefix caching providers (OpenAI et al.): "past the breakpoints" is
   * an Anthropic concept — implicit providers cache the FULL prompt, so a
   * trailing message that changes every call makes every cached entry end in
   * bytes the next request never reproduces (100% write, 0% read). */
  render(opts?: { volatileTail?: boolean }): ChatMessage[] {
    const out: ChatMessage[] = [];
    out.push(this.renderSystem());
    const bps = this.cachingEnabled ? this.breakpointIndices() : new Set<number>();
    for (let i = 0; i < this.messages.length; i++) {
      out.push(bps.has(i) ? withCacheControl(this.messages[i]) : this.messages[i]);
    }
    // Volatile tail goes last, past every breakpoint — cache-free by position
    // (on cache_control providers only; see doc comment).
    if (opts?.volatileTail !== false) {
      const tail = this.renderTail();
      if (tail) out.push(tail);
    }
    return out;
  }

  /**
   * Breakpoint placement: the rolling one on the last text-bearing message
   * (an assistant message with only tool_calls can't hold one), PLUS up to two
   * "anchor" breakpoints at stride positions in the older history. Providers
   * only look back a bounded number of content blocks from a breakpoint when
   * matching the cache — a single tool-heavy turn that appends dozens of
   * messages can jump past the previous rolling breakpoint and silently miss.
   * Anchors are durable read points that cap that risk. (Anthropic allows 4
   * breakpoints total: system + 2 anchors + rolling.)
   */
  private breakpointIndices(): Set<number> {
    const set = new Set<number>();
    const rolling = this.lastTextBearingIndex();
    if (rolling >= 0) set.add(rolling);
    const STRIDE = 15;
    let anchor = Math.floor((rolling - 1) / STRIDE) * STRIDE;
    while (anchor > 0 && set.size < 3) {
      const idx = this.textBearingAtOrBefore(Math.min(anchor, rolling - 1));
      if (idx > 0) set.add(idx);
      anchor -= STRIDE;
    }
    return set;
  }

  private textBearingAtOrBefore(start: number): number {
    for (let i = Math.min(start, this.messages.length - 1); i >= 0; i--) {
      const c = (this.messages[i] as any).content;
      if (typeof c === "string" && c.length > 0) return i;
      if (Array.isArray(c) && c.some((p: any) => p.type === "text" && p.text)) return i;
    }
    return -1;
  }

  /**
   * Remove the last user message and everything after it, returning its text
   * and any attached images. Used by retry / edit-and-resend. Returns null
   * when there is no user message (nothing to roll back).
   */
  rollbackToLastUser(): { text: string; images: string[] } | null {
    return this.rollbackToIndex(this.lastUserIndex());
  }

  /** Roll back to a specific message id (a turn start). */
  rollbackToId(id: number): { text: string; images: string[] } | null {
    return this.rollbackToIndex(this.indexOfId(id));
  }

  /**
   * Remove the message at `idx` (which must be a user message) and everything
   * after it, returning its text and any images. Cutting at a user-message
   * boundary keeps the tool_call/tool-result pairing invariant intact.
   */
  rollbackToIndex(idx: number): { text: string; images: string[] } | null {
    if (idx < 0 || idx >= this.messages.length) return null;
    if (this.messages[idx].role !== "user") return null;
    const payload = this.userTextAndImages(this.messages[idx]);
    this.messages.splice(idx);
    const removed = this.ids.splice(idx);
    for (const rid of removed) this.turnStartIds.delete(rid);
    return payload;
  }

  private userTextAndImages(m: ChatMessage): { text: string; images: string[] } {
    let text = "";
    const images: string[] = [];
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content as any[]) {
        if (p?.type === "text") text += (text ? " " : "") + p.text;
        else if (p?.type === "image_url" && p.image_url?.url) images.push(p.image_url.url);
      }
      text = text.trim();
    }
    return { text, images };
  }

  private lastTextBearingIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const c = (this.messages[i] as any).content;
      if (typeof c === "string" && c.length > 0) return i;
      if (Array.isArray(c) && c.some((p: any) => p.type === "text" && p.text)) return i;
    }
    return -1;
  }

  private renderSystem(): SystemMessage {
    if (!this.cachingEnabled) {
      return { role: "system", content: this.systemPrompt };
    }
    const part: TextPart = {
      type: "text",
      text: this.systemPrompt,
      cache_control: { type: "ephemeral" },
    };
    return { role: "system", content: [part] };
  }
}

/** Attach a cache_control breakpoint to the last text part of a message. */
function withCacheControl(msg: ChatMessage): ChatMessage {
  // Only text-bearing roles benefit; assistant tool_call-only messages have no
  // text content to mark, so leave them as-is.
  const clone: ChatMessage = { ...msg } as ChatMessage;
  const content = (msg as any).content;
  if (typeof content === "string") {
    if (content.length === 0) return msg;
    (clone as any).content = [
      { type: "text", text: content, cache_control: { type: "ephemeral" } } as TextPart,
    ];
    return clone;
  }
  if (Array.isArray(content) && content.length > 0) {
    const parts = content.map((p: ContentPart) => ({ ...p }));
    const last = parts[parts.length - 1];
    if (last.type === "text") {
      (last as TextPart).cache_control = { type: "ephemeral" };
      (clone as any).content = parts;
      return clone;
    }
  }
  return msg;
}

function normalizePathKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function editPathsFromCall(name: string, argsJson: string): string[] {
  try {
    const args = argsJson ? JSON.parse(argsJson) : {};
    if (name === "apply_patch") {
      return Array.isArray(args?.changes)
        ? args.changes.map((c: any) => c?.path).filter((p: any) => typeof p === "string")
        : [];
    }
    return typeof args?.path === "string" ? [args.path] : [];
  } catch {
    return [];
  }
}
