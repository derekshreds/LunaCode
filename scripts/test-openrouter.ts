import { useProgressiveTools } from "../src/modes";
import { OpenRouterClient } from "../src/openrouter/client";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("  ✗ " + msg);
    failures++;
  } else {
    console.log("  ✓ " + msg);
  }
}

async function main() {
  console.log("Mode tool policy:");
  assert(useProgressiveTools("standard", true), "Standard may use progressive schemas");
  assert(!useProgressiveTools("auto", true), "Auto exposes the full tool set immediately");
  assert(!useProgressiveTools("plan", true), "Plan uses its complete read-only tool set");

  console.log("\nCancelled-stream accounting:");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Generation-Id": "gen-from-header",
        },
      })) as typeof fetch;

    const client = new OpenRouterClient({
      apiKey: "test",
      baseUrl: "https://example.test/api/v1",
      model: "test/model",
    });
    for await (const _ of client.stream({ messages: [] })) {
      // Drain the response; it intentionally contains no JSON id frame.
    }
    assert(
      client.generationId === "gen-from-header",
      "generation id is captured from the response header before SSE usage"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (failures) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nMode and OpenRouter checks pass. ✓");
}

main();
