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

/** Long history: user, then many assistant(tool_calls)+tool exchanges. Distinct
 * args per call unless `sameArgs` — dedupe should only fire on identical calls. */
function buildHistory(cm: ContextManager, n: number, sameArgs = false) {
  cm.addUser("initial request");
  for (let i = 0; i < n; i++) {
    const id = `call_${i}`;
    const args = sameArgs ? `{"path":"a.ts"}` : `{"path":"file_${i}.ts"}`;
    cm.addAssistant({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: args } }],
    });
    cm.addToolResult(id, "X".repeat(2000)); // big result to blow the budget
  }
  cm.addUser("final question");
}

async function compactionTests() {
  console.log("Compaction (legacy fallback — no summarizer):");
  {
    const cm = new ContextManager(true);
    cm.setSystemPrompt("SYS");
    buildHistory(cm, 40);
    const before = cm.estimate();
    const result = await cm.compactIfNeeded(3000, { targetRatio: 0.45 });
    const after = cm.estimate();
    assert(result !== null, "compaction ran");
    assert(after < before, `tokens reduced (${before} -> ${after})`);
    assert(after <= 3000 || cm.getMessages().length <= 4, "within budget or floored");
    assert(!result!.summarized, "fell back to truncation without a summarizer");
    const msgs = cm.getMessages();
    const last = msgs[msgs.length - 1];
    assert(last.role === "user" && last.content === "final question", "active task preserved");
    checkInvariants([{ role: "system", content: "SYS" }, ...msgs], "compacted");
  }

  console.log("Compaction (summarizer checkpoint):");
  {
    const cm = new ContextManager(true);
    cm.setSystemPrompt("SYS");
    buildHistory(cm, 40);
    const result = await cm.compactIfNeeded(3000, {
      targetRatio: 0.45,
      summarize: async () => ({ text: "Goal: test\nNext step: continue" }),
    });
    assert(result !== null && result.summarized, "summarize path taken");
    const msgs = cm.getMessages();
    const checkpoints = msgs.filter(
      (m) =>
        m.role === "assistant" &&
        typeof m.content === "string" &&
        m.content.startsWith("[Luna Code checkpoint")
    );
    assert(checkpoints.length === 1, "exactly one checkpoint message inserted");
    assert(cm.estimate() <= 3000, `driven under budget (${cm.estimate()})`);
    const last = msgs[msgs.length - 1];
    assert(last.role === "user" && last.content === "final question", "active task preserved");
    checkInvariants([{ role: "system", content: "SYS" }, ...msgs], "summarized");
  }

  console.log("Dedupe of repeated identical tool calls:");
  {
    const cm = new ContextManager(true);
    cm.setSystemPrompt("SYS");
    buildHistory(cm, 40, /* sameArgs */ true); // 40 reads of the SAME file
    const result = await cm.compactIfNeeded(3000, {
      targetRatio: 0.45,
      summarize: async () => ({ text: "Goal: test" }),
    });
    assert(result !== null && result.deduped > 0, `stale duplicates stubbed (${result?.deduped})`);
    // The newest surviving duplicate (if still in history) must not be a stub.
    const tools = cm.getMessages().filter((m) => m.role === "tool");
    const lastTool = tools[tools.length - 1];
    if (lastTool && typeof lastTool.content === "string") {
      assert(!lastTool.content.startsWith("[superseded:"), "latest result kept intact");
    }
    checkInvariants([{ role: "system", content: "SYS" }, ...cm.getMessages()], "deduped");
  }

  console.log("Anchor breakpoints & rollback:");
  {
    const cm = new ContextManager(true);
    cm.setSystemPrompt("SYS");
    cm.addUser("start");
    for (let i = 0; i < 40; i++) {
      cm.addAssistant({ role: "assistant", content: `step ${i}` });
    }
    const rendered = cm.render();
    const bps = rendered.filter(
      (m) =>
        Array.isArray((m as any).content) &&
        (m as any).content.some((p: any) => p.cache_control)
    ).length;
    assert(bps >= 3 && bps <= 4, `system + anchors + rolling breakpoints present (${bps})`);

    cm.addUser("question two");
    cm.addAssistant({ role: "assistant", content: "answer two" });
    const rolled = cm.rollbackToLastUser();
    assert(rolled?.text === "question two", "rollback returns the last user text");
    const msgs = cm.getMessages();
    const last = msgs[msgs.length - 1];
    assert(
      last.role === "assistant" && last.content === "step 39",
      "history truncated to before the last user turn"
    );
  }

  console.log("Append-only below budget:");
  {
    const cm = new ContextManager(true);
    cm.setSystemPrompt("SYS");
    buildHistory(cm, 3);
    const snapshot = JSON.stringify(cm.getMessages());
    const result = await cm.compactIfNeeded(1_000_000, { targetRatio: 0.45 });
    assert(result === null, "no compaction under budget");
    assert(JSON.stringify(cm.getMessages()) === snapshot, "history untouched (cache prefix stable)");
  }
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

console.log("Ephemeral tail:");
{
  const cm = new ContextManager(true);
  cm.setSystemPrompt("SYS");
  cm.addUser("hi");
  cm.addAssistant({ role: "assistant", content: "answer" });
  let tail = "# Scratchpad\nGoal: test";
  cm.setEphemeralTail(() => tail);
  const rendered = cm.render();
  const last = rendered[rendered.length - 1];
  assert(
    last.role === "user" && typeof last.content === "string" && last.content.includes("Goal: test"),
    "tail rendered as the final message"
  );
  assert(typeof last.content === "string", "tail carries no cache_control part");
  // The rolling breakpoint stays on the last STORED text-bearing message.
  const assistant = rendered[rendered.length - 2];
  const asstHasBp =
    Array.isArray(assistant.content) && (assistant.content as any[]).some((p) => p.cache_control);
  assert(asstHasBp, "rolling breakpoint stays on the last stored message");
  assert(cm.getMessages().length === 2, "tail never enters stored messages (persistence-safe)");
  // Tail mutations show up on the next render with no prefix change.
  tail = "# Scratchpad\nGoal: changed";
  const rendered2 = cm.render();
  assert(
    (rendered2[rendered2.length - 1].content as string).includes("changed"),
    "tail re-renders fresh each call"
  );
  assert(
    JSON.stringify(rendered2.slice(0, -1)) === JSON.stringify(rendered.slice(0, -1)),
    "prefix bytes identical across tail changes (cache-stable)"
  );
  // Empty tail → no extra message.
  tail = "";
  const rendered3 = cm.render();
  assert(rendered3.length === rendered.length - 1, "empty tail appends nothing");
}

console.log("Self-calibrating estimator:");
{
  const cm = new ContextManager(true);
  cm.setSystemPrompt("S".repeat(4000));
  cm.addUser("U".repeat(31000));
  const heuristic = cm.estimate(); // uncalibrated: 35000 chars @ 3.5 cpt
  cm.noteObservedUsage(35000, 14000); // observed 2.5 chars/token
  const calibrated = cm.estimate();
  assert(calibrated > heuristic, `calibration shifts estimate (${heuristic} -> ${calibrated})`);
  assert(calibrated === Math.ceil(cm.renderChars() / 2.5), "estimate uses observed ratio exactly");
  // Small/noisy samples are ignored.
  cm.noteObservedUsage(400, 100);
  assert(cm.estimate() === calibrated, "sub-4k-token samples ignored");
  // Absurd ratios are clamped, not adopted verbatim.
  cm.noteObservedUsage(35000 * 100, 5000);
  assert(cm.estimate() >= Math.ceil(cm.renderChars() / 5.5), "rogue frame clamped to sane chars/token");
}

compactionTests()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} assertion(s) failed.`);
      process.exit(1);
    } else {
      console.log("\nAll context invariants hold. ✓");
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
