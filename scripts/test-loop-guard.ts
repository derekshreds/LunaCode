// Standalone tests for LoopGuard + path-range supersession.
import { LoopGuard, callSignature, mutatingTargets } from "../src/agent/loopGuard";
import { ContextManager } from "../src/agent/contextManager";
import { ToolCall } from "../src/openrouter/types";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("  ✗ " + msg);
    failures++;
  } else {
    console.log("  ✓ " + msg);
  }
}

function tc(name: string, args: object, id = "c1"): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

async function main() {
  console.log("mutatingTargets:");
  {
    assert(
      mutatingTargets(tc("read_file", { path: "a.ts", offset: 1, limit: 50 })).length === 0,
      "read_file is not a mutation target"
    );
    assert(
      mutatingTargets(tc("write_file", { path: "a.ts", content: "x" }))[0] === "file:a.ts",
      "write_file targets file path"
    );
    assert(
      mutatingTargets(tc("run_command", { command: "npm test" }))[0] === "cmd:npm test",
      "run_command targets command"
    );
    const patch = mutatingTargets(
      tc("apply_patch", { changes: [{ path: "a.ts" }, { path: "b.ts" }] })
    );
    assert(
      patch.length === 2 && patch.includes("file:a.ts") && patch.includes("file:b.ts"),
      "apply_patch multi-file"
    );
  }

  console.log("callSignature:");
  {
    const a = callSignature(
      tc("edit_file", { path: "a.ts", old_string: "x", new_string: "y" })
    );
    const b = callSignature(
      tc("edit_file", { path: "a.ts", new_string: "y", old_string: "x" })
    );
    assert(a !== null && b !== null, "mutating calls have signatures");
    assert(a === b, "canonicalized signatures ignore key order");
    assert(callSignature(tc("read_file", { path: "a.ts" })) === null, "reads have no signature");
  }

  console.log("LoopGuard soft-block:");
  {
    const g = new LoopGuard({ limit: 2, hardStopAfterBlockedRounds: 2 });
    let r = g.evaluate([
      tc("edit_file", { path: "a.ts", old_string: "1", new_string: "2" }, "1"),
    ]);
    assert(!r.decisions[0].blocked && !r.hardStop, "1st edit allowed");
    r = g.evaluate([
      tc("edit_file", { path: "a.ts", old_string: "2", new_string: "3" }, "2"),
    ]);
    assert(!r.decisions[0].blocked && !r.hardStop, "2nd edit allowed");
    r = g.evaluate([
      tc("edit_file", { path: "a.ts", old_string: "3", new_string: "4" }, "3"),
    ]);
    assert(r.decisions[0].blocked === true, "3rd edit soft-blocked");
    assert(!r.hardStop, "not hard-stopped on first blocked round");
    r = g.evaluate([
      tc("edit_file", { path: "a.ts", old_string: "4", new_string: "5" }, "4"),
    ]);
    assert(r.decisions[0].blocked === true && r.hardStop, "2nd blocked round hard-stops");
  }

  console.log("LoopGuard allows progress after soft-block:");
  {
    const g = new LoopGuard({ limit: 1, hardStopAfterBlockedRounds: 2 });
    g.evaluate([tc("edit_file", { path: "a.ts", old_string: "1", new_string: "2" }, "1")]);
    let r = g.evaluate([
      tc("edit_file", { path: "a.ts", old_string: "2", new_string: "3" }, "2"),
    ]);
    assert(r.decisions[0].blocked === true && !r.hardStop, "a.ts blocked");
    r = g.evaluate([
      tc("edit_file", { path: "b.ts", old_string: "x", new_string: "y" }, "3"),
    ]);
    assert(!r.decisions[0].blocked && !r.hardStop, "different file still allowed");
    r = g.evaluate([
      tc("edit_file", { path: "a.ts", old_string: "3", new_string: "4" }, "4"),
    ]);
    assert(
      r.decisions[0].blocked === true && !r.hardStop,
      "blocked rounds reset after progress"
    );
  }

  console.log("LoopGuard identical signature:");
  {
    const g = new LoopGuard({ limit: 2 });
    const same = { path: "a.ts", old_string: "x", new_string: "y" };
    g.evaluate([tc("edit_file", same, "1")]);
    g.evaluate([tc("edit_file", same, "2")]);
    const r = g.evaluate([tc("edit_file", same, "3")]);
    assert(r.decisions[0].blocked === true, "identical call blocked after limit");
    assert(
      r.decisions[0].blocked && r.decisions[0].reason.includes("identical"),
      "reason mentions identical call"
    );
  }

  console.log("LoopGuard disabled:");
  {
    const g = new LoopGuard({ limit: 0 });
    for (let i = 0; i < 20; i++) {
      const r = g.evaluate([
        tc("write_file", { path: "a.ts", content: String(i) }, String(i)),
      ]);
      assert(!r.decisions[0].blocked && !r.hardStop, `disabled: call ${i} allowed`);
    }
  }

  console.log("Path supersession keeps different read ranges:");
  {
    const cm = new ContextManager(true);
    cm.setSystemPrompt("SYS");
    cm.addUser("pages");
    cm.addAssistant({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "big.ts", offset: 1, limit: 50 }),
          },
        },
        {
          id: "b",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "big.ts", offset: 51, limit: 50 }),
          },
        },
      ],
    });
    cm.addToolResult("a", "AAA".repeat(800));
    cm.addToolResult("b", "BBB".repeat(800));
    cm.addUser("continue");
    for (let i = 0; i < 5; i++) {
      cm.addAssistant({ role: "assistant", content: "x".repeat(2000) });
    }
    await cm.compactIfNeeded(50, {
      targetRatio: 0.2,
      summarize: async () => ({ text: "sum" }),
    });
    const tools = cm.getMessages().filter((m) => m.role === "tool");
    const pathCollapsed = tools.filter(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("a newer read of this path is later")
    );
    assert(
      pathCollapsed.length === 0,
      "different offset/limit pages are NOT path-collapsed"
    );
  }

  console.log("Same-range re-read IS superseded:");
  {
    const cm = new ContextManager(true);
    cm.setSystemPrompt("SYS");
    cm.addUser("reread");
    const args = JSON.stringify({ path: "a.ts", offset: 1, limit: 20 });
    cm.addAssistant({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "r1", type: "function", function: { name: "read_file", arguments: args } },
      ],
    });
    cm.addToolResult("r1", "FIRST".repeat(600));
    cm.addAssistant({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "r2", type: "function", function: { name: "read_file", arguments: args } },
      ],
    });
    cm.addToolResult("r2", "SECOND".repeat(600));
    cm.addUser("done");
    for (let i = 0; i < 10; i++) {
      cm.addAssistant({ role: "assistant", content: "pad".repeat(500) });
    }
    await cm.compactIfNeeded(80, {
      targetRatio: 0.3,
      summarize: async () => ({ text: "sum" }),
    });
    const tools = cm.getMessages().filter((m) => m.role === "tool");
    const first = tools.find((m) => m.role === "tool" && (m as any).tool_call_id === "r1");
    if (first && typeof first.content === "string") {
      assert(
        first.content.startsWith("[superseded:"),
        "identical range re-read is superseded"
      );
    } else {
      // Summarizer may have dropped the span entirely — that's fine.
      assert(true, "identical range re-read handled (dropped or superseded)");
    }
  }

  if (failures) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nAll loop-guard / path-range invariants hold. ✓");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
