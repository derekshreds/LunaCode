import { runSubagent } from "../src/agent/subagent";
import { messagesToEvents } from "../src/webview/replay";
import type { Tool } from "../src/agent/tools/types";
import type { TurnReceipt } from "../src/webview/protocol";
import { OpenRouterClient } from "../src/openrouter/client";

let failures = 0;
function assert(value: boolean, label: string) {
  if (value) console.log("  ✓ " + label);
  else { console.error("  ✗ " + label); failures++; }
}

async function main() {
  console.log("Streaming sub-agent report:");
  let round = 0;
  const client = {
    async *stream() {
      round++;
      if (round === 1) {
        yield { type: "tool_call_start", index: 0, id: "read-1", name: "read_file" };
        yield { type: "tool_call_delta", index: 0, argsDelta: '{"path":"src/' };
        yield { type: "tool_call_delta", index: 0, argsDelta: 'a.ts"}' };
        yield { type: "usage", usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, cost: 0.001, prompt_tokens_details: { cached_tokens: 800 } } };
      } else {
        yield { type: "text", delta: "Found the implementation at src/a.ts:1." };
        yield { type: "usage", usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230, cost: 0.0012, prompt_tokens_details: { cached_tokens: 1000 } } };
      }
    },
  };
  const read: Tool = {
    name: "read_file",
    description: "read",
    parameters: { type: "object" },
    mutating: false,
    execute: async () => ({ content: "1|export const value = 1;" }),
  };
  const result = await runSubagent("Where is value?", {
    client: client as any,
    tools: [read],
    workspaceRoot: "/workspace",
    output: {} as any,
    signal: new AbortController().signal,
  });
  assert(result.summary.includes("src/a.ts:1"), "partial streamed JSON is assembled and executed");
  assert(result.report.toolCalls === 1 && result.report.iterations === 2, "tool calls and iterations are reported");
  assert(result.report.promptTokens === 2200 && result.report.cachedTokens === 1800, "usage and cache tokens are aggregated");
  assert(result.report.sources.includes("src/a.ts"), "source paths are retained");

  console.log("Receipt replay:");
  const receipt: TurnReceipt = {
    id: 7, startedAt: 1, endedAt: 2, model: "test", stopReason: "stop", toolCalls: 0,
    files: [], commands: [], subagents: [], evidence: [], failures: [],
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, cost: 0 },
  };
  const events = messagesToEvents(
    [{ role: "user", content: "hello" }, { role: "assistant", content: "done" }],
    new Map([[0, 7]]),
    new Map([[7, receipt]]),
  );
  assert(events[events.length - 1].type === "turnReceipt", "persisted receipt is restored after its turn");

  const aborted = new AbortController();
  aborted.abort();
  const stopped = await runSubagent("stop", {
    client: client as any, tools: [read], workspaceRoot: "/workspace", output: {} as any, signal: aborted.signal,
  });
  assert(stopped.report.successful === 0 && stopped.report.iterations === 0, "pre-aborted sub-agent exits without a request");

  console.log("Fallback routing contract:");
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    const sse =
      'data: {"id":"g1","model":"vendor/fallback","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const fallbackClient = new OpenRouterClient({
      apiKey: "test", baseUrl: "https://example.test", model: "vendor/primary", fallbackModels: ["vendor/fallback"],
    });
    const events = [];
    for await (const event of fallbackClient.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    assert(requestBody.models?.join(",") === "vendor/primary,vendor/fallback", "fallback model order is sent to the provider");
    assert(events.some((event: any) => event.type === "model" && event.id === "vendor/fallback"), "served fallback is surfaced to the agent");
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (failures) process.exit(1);
  console.log("\nAll sub-agent/replay guarantees hold. ✓");
}

void main();
