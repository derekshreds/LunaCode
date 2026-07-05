// Standalone tests for the unified-rewind primitives: the pure
// collapseRestoreSet function and ContextManager's stable-id / rollback API.
// Bundled by esbuild (node) and run directly — no VS Code dependency.
import { collapseRestoreSet } from "../src/agent/checkpoints";
import { reconstructWithReverts } from "../src/diff";
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

function checkInvariants(msgs: ChatMessage[], label: string) {
  const knownCallIds = new Set<string>();
  let prevRole = "";
  for (const m of msgs) {
    if (m.role === "assistant") {
      for (const tc of (m as AssistantMessage).tool_calls ?? []) knownCallIds.add(tc.id);
    }
    if (m.role === "tool") {
      assert(knownCallIds.has(m.tool_call_id), `${label}: tool ${m.tool_call_id} has an owning assistant`);
    }
    if (m.role === "user" && prevRole === "user") assert(false, `${label}: consecutive user messages`);
    prevRole = m.role;
  }
}

type CP = Map<string, string | null> | null;
const cp = (entries: Array<[string, string | null]>): CP => new Map(entries);

console.log("collapseRestoreSet:");
{
  // File edited in turn 0, edited again in turn 2 (untouched in turn 1) —
  // restoring to before turn 0 must recover turn 0's before-state.
  const turns = [
    { checkpoint: cp([["/a", "a-before-0"]]) },
    { checkpoint: null as CP },
    { checkpoint: cp([["/a", "a-after-1"]]) },
  ];
  const r = collapseRestoreSet(turns, 0);
  assert(r.get("/a") === "a-before-0", "earliest before-state wins across turns");
  assert(r.size === 1, "single file collapsed to one entry");
}
{
  // Created in turn 0 (null), edited in turn 1 → rewinding to 0 deletes it.
  const turns = [
    { checkpoint: cp([["/new", null]]) },
    { checkpoint: cp([["/new", "v1"]]) },
  ];
  const r = collapseRestoreSet(turns, 0);
  assert(r.get("/new") === null, "created-then-edited collapses to delete (null)");
}
{
  // Rewinding to a later turn ignores earlier turns entirely.
  const turns = [
    { checkpoint: cp([["/a", "old"]]) },
    { checkpoint: cp([["/b", null]]) },
  ];
  const r = collapseRestoreSet(turns, 1);
  assert(!r.has("/a"), "turns before fromTurn are excluded");
  assert(r.get("/b") === null && r.size === 1, "only discarded turns contribute");
}
{
  // No-edit / trimmed (null) turns contribute nothing.
  const turns = [{ checkpoint: null as CP }, { checkpoint: null as CP }];
  assert(collapseRestoreSet(turns, 0).size === 0, "null-checkpoint turns yield an empty set");
}

console.log("reconstructWithReverts (per-hunk diff review):");
{
  const before = "a\nb\nc\nd";
  const after = "A\nb\nc\nD"; // hunk 0: a→A, hunk 1: d→D
  assert(reconstructWithReverts(before, after, new Set()) === after, "reverting nothing keeps the after text");
  assert(reconstructWithReverts(before, after, new Set([0, 1])) === before, "reverting all hunks restores the before text");
  assert(reconstructWithReverts(before, after, new Set([0])) === "a\nb\nc\nD", "reverting only hunk 0 keeps hunk 1's change");
  assert(reconstructWithReverts(before, after, new Set([1])) === "A\nb\nc\nd", "reverting only hunk 1 keeps hunk 0's change");
  // Pure insertion is a single hunk.
  assert(reconstructWithReverts("x\ny", "x\nNEW\ny", new Set([0])) === "x\ny", "reverting an inserted hunk removes it");
}

console.log("ContextManager stable ids + rollbackToIndex:");
{
  const cm = new ContextManager(true);
  cm.setSystemPrompt("SYS");
  cm.addUser("turn one", undefined, { turnStart: true });
  cm.addAssistant({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  });
  cm.addToolResult("c1", "result");
  cm.addAssistant({ role: "assistant", content: "done one" });
  cm.addUser("turn two", undefined, { turnStart: true });
  cm.addAssistant({ role: "assistant", content: "done two" });

  const starts = cm.getTurnStarts();
  assert(starts.length === 2, "two turn starts tracked");
  assert(starts[0].text === "turn one" && starts[1].text === "turn two", "turn-start texts correct");

  // Rolling back to a non-user index is refused.
  const asstIdx = cm.getMessages().findIndex((m) => m.role === "assistant");
  assert(cm.rollbackToIndex(asstIdx) === null, "rollbackToIndex refuses a non-user boundary");

  // Roll back to the second turn start: removes it and everything after.
  const rolled = cm.rollbackToId(starts[1].id);
  assert(rolled?.text === "turn two", "rollbackToId returns the target user text");
  const msgs = cm.getMessages();
  assert(msgs[msgs.length - 1].content === "done one", "history truncated to before the target turn");
  checkInvariants([{ role: "system", content: "SYS" }, ...msgs], "after rollback");
  assert(cm.getTurnStarts().length === 1, "the discarded turn start is gone");
  assert(cm.indexOfId(starts[1].id) === -1, "rolled-away id no longer resolves");
}

console.log("Steering messages are not rewind targets:");
{
  const cm = new ContextManager(true);
  cm.setSystemPrompt("SYS");
  cm.addUser("real turn", undefined, { turnStart: true });
  cm.addAssistant({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }],
  });
  cm.addToolResult("c1", "hits");
  cm.addUser("steer me", undefined); // steering — no turnStart
  cm.addAssistant({ role: "assistant", content: "ok" });
  const starts = cm.getTurnStarts();
  assert(starts.length === 1 && starts[0].text === "real turn", "steering user message is not a turn start");
}

async function compactionSurvivalTest() {
  console.log("Turn-start ids survive a compaction event; middle turns drop out:");
  const cm = new ContextManager(true);
  cm.setSystemPrompt("SYS");
  cm.addUser("u0 first", undefined, { turnStart: true });
  for (let i = 0; i < 4; i++) {
    cm.addAssistant({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `x${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"f${i}.ts"}` } }],
    });
    cm.addToolResult(`x${i}`, "X".repeat(2000));
  }
  cm.addUser("u1 middle", undefined, { turnStart: true });
  for (let i = 4; i < 24; i++) {
    cm.addAssistant({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `x${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"f${i}.ts"}` } }],
    });
    cm.addToolResult(`x${i}`, "X".repeat(2000));
  }
  cm.addUser("u2 last", undefined, { turnStart: true });

  const before = cm.getTurnStarts();
  const u0 = before.find((s) => s.text === "u0 first")!;
  const u1 = before.find((s) => s.text === "u1 middle")!;
  const u2 = before.find((s) => s.text === "u2 last")!;

  const result = await cm.compactIfNeeded(3000, {
    targetRatio: 0.45,
    summarize: async () => ({ text: "Goal: test\nNext step: continue" }),
  });
  assert(result !== null && result.summarized, "a summarization compaction event ran");

  assert(cm.indexOfId(u0.id) >= 0, "the first turn start is preserved");
  assert(cm.indexOfId(u2.id) >= 0, "the last (active) turn start is preserved");
  assert(cm.indexOfId(u1.id) === -1, "a summarized-away middle turn start no longer resolves");
  const startTexts = cm.getTurnStarts().map((s) => s.text);
  assert(!startTexts.includes("u1 middle"), "compacted-away turn is not offered as a rewind target");
  checkInvariants([{ role: "system", content: "SYS" }, ...cm.getMessages()], "after compaction");
}

compactionSurvivalTest()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} assertion(s) failed.`);
      process.exit(1);
    } else {
      console.log("\nAll rewind primitives hold. ✓");
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
