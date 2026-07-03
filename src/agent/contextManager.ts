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

/** Read-only / re-runnable tools whose repeated identical results are safe to
 * supersede (latest occurrence wins). */
const DEDUPE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "run_command",
  "get_diagnostics",
]);

/** Token headroom reserved for the checkpoint summary that replaces a span. */
const SUMMARY_ALLOWANCE_TOKENS = 800;

/** Stable stringify (sorted keys) so arg order never splits identity keys. */
function canonicalizeArgs(args: any): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args);
  if (Array.isArray(args)) return "[" + args.map(canonicalizeArgs).join(",") + "]";
  return (
    "{" +
    Object.keys(args)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalizeArgs(args[k]))
      .join(",") +
    "}"
  );
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += messageChars(m);
  }
  return Math.ceil(chars / 4);
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
 */
export class ContextManager {
  private systemPrompt = "";
  private messages: ChatMessage[] = [];

  constructor(private cachingEnabled: boolean) {}

  setSystemPrompt(text: string) {
    this.systemPrompt = text;
  }

  setCaching(enabled: boolean) {
    this.cachingEnabled = enabled;
  }

  reset() {
    this.messages = [];
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /** Replace the conversation (used when loading a saved session). */
  loadMessages(messages: ChatMessage[]) {
    this.messages = messages.map((m) => ({ ...m }));
  }

  addUser(text: string, images?: string[]) {
    if (images && images.length) {
      const parts: ContentPart[] = [{ type: "text", text }];
      for (const url of images) {
        parts.push({ type: "image_url", image_url: { url } });
      }
      this.messages.push({ role: "user", content: parts });
      return;
    }
    this.messages.push({ role: "user", content: text });
  }

  addAssistant(msg: AssistantMessage) {
    this.messages.push(msg);
  }

  addToolResult(toolCallId: string, content: string) {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }

  /** Total estimated tokens including the system prompt. */
  estimate(): number {
    const sys: SystemMessage = { role: "system", content: this.systemPrompt };
    return estimateTokens([sys, ...this.messages]);
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

    // Pass A: supersede stale duplicate tool results (latest occurrence wins).
    const deduped = this.dedupeStaleToolResults();

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
          const primary = args.path ?? args.pattern ?? args.command ?? "";
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
        if (m.content.startsWith("[superseded:")) continue;
        const label = callLabel.get(m.tool_call_id) ?? "this call";
        m.content = `[superseded: ${label} was re-run later in this conversation — see the newer result]`;
        stubbed++;
      }
    }
    return stubbed;
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
      spanTokens += Math.ceil(messageChars(this.messages[end]) / 4);
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
    // Truncate big tool outputs first (cheapest loss).
    for (const m of this.messages) {
      if (this.estimate() <= target) break;
      if (m === this.messages[this.lastUserIndex()]) break;
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500) {
        m.content =
          m.content.slice(0, 1200) + `\n…[older tool output truncated to save context]`;
      }
    }
    // Then drop the oldest messages, sweeping orphaned tool results so a tool
    // message never leads the boundary, and never touching the active task.
    let removedCount = 0;
    while (this.estimate() > target && start < this.lastUserIndex()) {
      this.messages.splice(start, 1);
      removedCount++;
      while (start < this.lastUserIndex() && this.messages[start]?.role === "tool") {
        this.messages.splice(start, 1);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      this.messages.splice(start, 0, {
        role: "assistant",
        content: `[Luna Code: ${removedCount} earlier message(s) were dropped to stay within the context budget. Re-read any files if you need their current contents.]`,
      });
    }
  }

  private lastUserIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") return i;
    }
    return -1;
  }

  /** Build the final messages array for an API request, with cache breakpoints. */
  render(): ChatMessage[] {
    const out: ChatMessage[] = [];
    out.push(this.renderSystem());
    const bps = this.cachingEnabled ? this.breakpointIndices() : new Set<number>();
    for (let i = 0; i < this.messages.length; i++) {
      out.push(bps.has(i) ? withCacheControl(this.messages[i]) : this.messages[i]);
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
    const idx = this.lastUserIndex();
    if (idx < 0) return null;
    const m = this.messages[idx];
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
    this.messages.splice(idx);
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
