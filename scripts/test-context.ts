// Standalone invariant tests for ContextManager compaction & cache breakpoints.
// Bundled by esbuild (node) and run directly — no VS Code dependency.
import { ContextManager } from "../src/agent/contextManager";
import { AssistantMessage, ChatMessage } from "../src/openrouter/types";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("  ✗ " + msg);
    failures++;
  } else {
    console.log("  ✓ " + msg);
  }
}

// Validate the OpenAI-style invariants on a rendered message list.
function checkInvariants(msgs: ChatMessage[], label: string) {
  // (a) every tool message is preceded by an assistant whose tool_calls include its id
  const knownCallIds = new Set<string>();
  let prevRole = "";
  for (const m of msgs) {
    if (m.role === "assistant") {
      const a = m as AssistantMessage;
      for (const tc of a.tool_calls ?? []) knownCallIds.add(tc.id);
    }
    if (m.role === "tool") {
      assert(knownCallIds.has(m.tool_call_id), `${label}: tool ${m.tool_call_id} has an owning assistant`);
    }
    // (b) no two consecutive user messages
    if (m.role === "user" && prevRole === "user") {
      assert(false, `${label}: consecutive user messages`);
    }
    prevRole = m.role;
  }
}

console.log("ContextManager compaction:");
{
  const cm = new ContextManager(true);
  cm.setSystemPrompt("SYS");
  // Build a long history: user, then many assistant(tool_calls)+tool exchanges.
  cm.addUser("initial request");
  for (let i = 0; i < 40; i++) {
    const id = `call_${i}`;
    cm.addAssistant({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    cm.addToolResult(id, "X".repeat(2000)); // big result to blow the budget
  }
  cm.addUser("final question");

  const before = cm.estimate();
  const didCompact = cm.compactIfNeeded(3000);
  const after = cm.estimate();
  assert(didCompact, "compaction ran");
  assert(after < before, `tokens reduced (${before} -> ${after})`);
  assert(after <= 3000 || cm.getMessages().length <= 4, "within budget or floored");
  checkInvariants([{ role: "system", content: "SYS" }, ...cm.getMessages()], "compacted");
}

console.log("Cache breakpoint placement:");
{
  const cm = new ContextManager(true);
  cm.setSystemPrompt("SYS");
  cm.addUser("hi");
  // Last message is an assistant with only tool_calls (null content).
  cm.addAssistant({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: "{}" } }],
  });
  const rendered = cm.render();
  // System should carry a breakpoint.
  const sys = rendered[0];
  const sysHasBp = Array.isArray(sys.content) && (sys.content[0] as any).cache_control;
  assert(!!sysHasBp, "system prompt has cache_control");
  // The null-content assistant must NOT have been turned into a text array.
  const last = rendered[rendered.length - 1] as AssistantMessage;
  assert(last.content === null, "null-content assistant left intact (no invalid text part)");
  // The breakpoint should land on the user message instead.
  const user = rendered[1];
  const userHasBp = Array.isArray(user.content) && (user.content as any[]).some((p) => p.cache_control);
  assert(userHasBp, "breakpoint placed on last text-bearing (user) message");
}

console.log("No-caching mode:");
{
  const cm = new ContextManager(false);
  cm.setSystemPrompt("SYS");
  cm.addUser("hi");
  const rendered = cm.render();
  assert(typeof rendered[0].content === "string", "system is plain string when caching disabled");
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll context invariants hold. ✓");
}
