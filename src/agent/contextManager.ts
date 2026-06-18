import {
  AssistantMessage,
  ChatMessage,
  ContentPart,
  SystemMessage,
  TextPart,
} from "../openrouter/types";

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

  addUser(text: string) {
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
   * Compact the history when it exceeds the budget. Strategy: first shrink large
   * tool results in the older half, then, if still over, drop the oldest
   * turn-pairs and insert a synthetic notice. The first user message is kept so
   * the original intent survives.
   */
  compactIfNeeded(maxTokens: number): boolean {
    if (this.estimate() <= maxTokens) return false;
    let compacted = false;

    // Phase 1: truncate big tool outputs in the older 60% of the conversation.
    const cutoff = Math.floor(this.messages.length * 0.6);
    for (let i = 0; i < cutoff; i++) {
      const m = this.messages[i];
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500) {
        m.content =
          m.content.slice(0, 1200) +
          `\n…[older tool output truncated to save context]`;
        compacted = true;
      }
    }
    if (this.estimate() <= maxTokens) return compacted;

    // Phase 2: drop the oldest messages after the first user message until under
    // budget, then insert ONE synthetic assistant note in their place.
    //
    // Two invariants must hold afterwards or the API will 400:
    //   (a) no `tool` message may lead the dropped region's boundary (a tool
    //       result must always follow the assistant that requested it), and
    //   (b) we must not create two consecutive `user` messages.
    // Removing leading `tool` messages whenever they surface satisfies (a);
    // inserting an assistant note as the replacement satisfies (b).
    const firstUserIdx = this.messages.findIndex((m) => m.role === "user");
    if (firstUserIdx < 0) return compacted;
    const start = firstUserIdx + 1;
    let removedCount = 0;
    while (this.estimate() > maxTokens && this.messages.length > start + 2) {
      this.messages.splice(start, 1);
      removedCount++;
      // Sweep any now-orphaned tool results that bubbled to the boundary.
      while (
        this.messages.length > start + 1 &&
        this.messages[start]?.role === "tool"
      ) {
        this.messages.splice(start, 1);
        removedCount++;
      }
      compacted = true;
    }
    if (removedCount > 0) {
      this.messages.splice(start, 0, {
        role: "assistant",
        content: `[Luna Code: ${removedCount} earlier message(s) were dropped to stay within the context budget. Re-read any files if you need their current contents.]`,
      });
    }
    return compacted;
  }

  /** Build the final messages array for an API request, with cache breakpoints. */
  render(): ChatMessage[] {
    const out: ChatMessage[] = [];
    out.push(this.renderSystem());
    // Find the last message that actually carries text — an assistant message
    // with only tool_calls (content null) cannot hold a breakpoint, so marking
    // it would waste the breakpoint and defeat caching.
    const bpIndex = this.cachingEnabled ? this.lastTextBearingIndex() : -1;
    for (let i = 0; i < this.messages.length; i++) {
      out.push(i === bpIndex ? withCacheControl(this.messages[i]) : this.messages[i]);
    }
    return out;
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
