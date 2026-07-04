import { OpenRouterClient } from "../openrouter/client";
import { ChatMessage, Usage } from "../openrouter/types";

/**
 * Turns a span of conversation history into a structured "checkpoint" summary
 * during compaction, using a (typically cheap) summarizer model.
 *
 * Failure model: this module NEVER throws and never blocks compaction — any
 * error, timeout, or empty response yields null and the caller falls back to
 * plain truncation.
 */

const SUMMARIZER_SYSTEM_PROMPT = `You are a context-compression specialist for an agentic coding session. You will receive a transcript of the older part of a session. Produce a compact checkpoint that lets the coding agent continue seamlessly without the raw history.

Respond in exactly this structure (plain text, no preamble):
Goal: <the user's original request / current high-level goal>
Key decisions: <bullet list — each decision and WHY, with concrete file names and symbols>
Files touched: <bullet list — path plus one line on what was read or changed>
Errors & tests: <current known failures, test results, unresolved issues; "none known" if none>
Next step: <what the agent was about to do next>

Be specific and terse. Never invent details that are not in the transcript.`;

/** Cap on the serialized transcript sent to the summarizer (~15K tokens). */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Per-tool-result clip in the serialized transcript. */
const TOOL_RESULT_CLIP = 400;
/** Hard wall-clock limit for the summarizer round-trip. */
const SUMMARIZER_TIMEOUT_MS = 30_000;

/** Render a message span as a plain-text transcript for the summarizer. */
export function serializeSpan(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        lines.push(`USER: ${textOf(m.content)}`);
        break;
      case "assistant": {
        const text = textOf(m.content);
        if (text) lines.push(`ASSISTANT: ${text}`);
        if ("tool_calls" in m && m.tool_calls) {
          for (const tc of m.tool_calls) {
            lines.push(`TOOL_CALL ${tc.function.name} ${clip(tc.function.arguments, 300)}`);
          }
        }
        break;
      }
      case "tool":
        lines.push(`TOOL_RESULT: ${clip(textOf(m.content), TOOL_RESULT_CLIP)}`);
        break;
      default:
        break;
    }
  }
  const full = lines.join("\n");
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  // Keep head + tail; the middle is the least load-bearing part of a long span.
  const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
  return (
    full.slice(0, half) +
    "\n…[middle of transcript omitted for length]…\n" +
    full.slice(full.length - half)
  );
}

/**
 * Summarize a history span into a checkpoint. Returns null on ANY failure so
 * the caller can fall back to truncation.
 */
export async function summarizeSpan(
  client: OpenRouterClient,
  model: string,
  span: ChatMessage[],
  signal: AbortSignal | undefined,
  onUsage?: (usage: Usage) => void
): Promise<{ text: string } | null> {
  try {
    const transcript = serializeSpan(span);
    if (!transcript.trim()) return null;
    const timeout = AbortSignal.timeout(SUMMARIZER_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const { text, usage, error } = await client.complete({
      model,
      messages: [
        { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      temperature: 0,
      maxTokens: 1500,
      signal: combined,
    });
    if (usage && onUsage) onUsage(usage);
    if (error || !text.trim()) return null;
    return { text: text.trim() };
  } catch {
    return null;
  }
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

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
