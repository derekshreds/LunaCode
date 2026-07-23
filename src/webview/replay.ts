import type { AssistantMessage, ChatMessage } from "../openrouter/types";
import type { HostToWebview, TurnReceipt } from "./protocol";

function text(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.map((part) => part.type === "text" ? part.text : "").join("")
    : "";
}

/** Reconstruct UI events and interleave durable receipts at turn boundaries. */
export function messagesToEvents(
  messages: ChatMessage[],
  rewindIdByIndex?: Map<number, number>,
  receiptById?: Map<number, TurnReceipt>,
): HostToWebview[] {
  const events: HostToWebview[] = [];
  const toolNames = new Map<string, string>();
  let activeTurnId: number | undefined;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "user") {
      const content = text(message.content);
      if (!content.trim()) continue;
      const rewindId = rewindIdByIndex?.get(i);
      if (rewindId !== undefined && activeTurnId !== undefined) {
        const receipt = receiptById?.get(activeTurnId);
        if (receipt) events.push({ type: "turnReceipt", receipt });
      }
      if (rewindId !== undefined) activeTurnId = rewindId;
      events.push(rewindId !== undefined
        ? { type: "userEcho", text: content, rewindId }
        : { type: "userEcho", text: content });
    } else if (message.role === "assistant") {
      const content = text(message.content);
      if (content.trim()) events.push({ type: "assistantText", delta: content });
      for (const call of (message as AssistantMessage).tool_calls ?? []) {
        let args: any = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { /* replay best-effort */ }
        toolNames.set(call.id, call.function.name);
        events.push({ type: "toolStart", id: call.id, name: call.function.name, args });
      }
    } else if (message.role === "tool") {
      const summary = (text(message.content).split("\n")[0] ?? "").trim();
      const name = toolNames.get(message.tool_call_id) ?? "tool";
      const ok = !/^(Error|User rejected|Blocked|Cannot|Invalid|Command blocked)/i.test(summary);
      events.push({ type: "toolEnd", id: message.tool_call_id, name, ok, summary });
    }
  }
  if (activeTurnId !== undefined) {
    const receipt = receiptById?.get(activeTurnId);
    if (receipt) events.push({ type: "turnReceipt", receipt });
  }
  return events;
}
