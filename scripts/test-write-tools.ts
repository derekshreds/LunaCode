// Standalone regression tests for apply_patch's safety and line-range editing.
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { applyPatchTool } from "../src/agent/tools/writeTools";
import type { ToolContext } from "../src/agent/tools/types";
import { editFileTool } from "../src/agent/tools/writeTools";
import { fileRevision } from "../src/agent/tools/util";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log("  ✓ " + msg);
  else {
    console.error("  ✗ " + msg);
    failures++;
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lunacode-write-test-"));
  const ctx = {
    workspaceRoot: root,
    mode: "auto",
    signal: new AbortController().signal,
    output: {} as any,
    log: () => {},
    requestApproval: async () => "approved",
  } satisfies ToolContext;

  try {
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n", "utf8");

    console.log("apply_patch atomic preflight:");
    const atomic = await applyPatchTool.execute({
      changes: [
        { path: "a.txt", edits: [{ old_string: "two", new_string: "TWO" }] },
        { path: "missing.txt", edits: [{ old_string: "x", new_string: "y" }] },
      ],
    }, ctx);
    assert(!!atomic.isError, "invalid member fails the batch");
    assert((await fs.readFile(path.join(root, "a.txt"), "utf8")) === "one\ntwo\nthree\n", "valid member is not written when atomic preflight fails");

    console.log("apply_patch batched line ranges:");
    const ranged = await applyPatchTool.execute({
      changes: [{
        path: "a.txt",
        edits: [
          { start_line: 2, end_line: 2, new_string: "TWO" },
          { old_string: "three", new_string: "THREE" },
        ],
      }],
    }, ctx);
    assert(!ranged.isError, "line-range and exact edits can share one file change");
    assert((await fs.readFile(path.join(root, "a.txt"), "utf8")) === "one\nTWO\nTHREE\n", "both edit forms are applied in order");

    console.log("apply_patch explicit partial mode:");
    const partial = await applyPatchTool.execute({
      atomic: false,
      changes: [
        { path: "a.txt", edits: [{ old_string: "TWO", new_string: "two" }] },
        { path: "still-missing.txt", edits: [{ old_string: "x", new_string: "y" }] },
      ],
    }, ctx);
    assert(!partial.isError, "partial mode succeeds when at least one change is valid");
    assert((await fs.readFile(path.join(root, "a.txt"), "utf8")).includes("\ntwo\n"), "partial mode writes the valid change");

    console.log("revision guards and write scopes:");
    const current = await fs.readFile(path.join(root, "a.txt"), "utf8");
    const stale = await editFileTool.execute({
      path: "a.txt",
      old_string: "two",
      new_string: "TWO",
      expected_revision: fileRevision("older content"),
    }, ctx);
    assert(!!stale.isError, "stale expected_revision rejects an edit");
    assert(await fs.readFile(path.join(root, "a.txt"), "utf8") === current, "stale edit leaves the file unchanged");
    let scopeRejected = false;
    try {
      await editFileTool.execute({ path: "a.txt", old_string: "two", new_string: "TWO" }, { ...ctx, writeScope: ["other.txt"] });
    } catch {
      scopeRejected = true;
    }
    assert(scopeRejected, "scoped implementer cannot write undeclared files");
    const concurrent = await editFileTool.execute(
      { path: "a.txt", old_string: "two", new_string: "TWO", expected_revision: fileRevision(current) },
      {
        ...ctx,
        requestApproval: async () => {
          await fs.writeFile(path.join(root, "a.txt"), current.replace("two", "user-change"), "utf8");
          return "approved";
        },
      },
    );
    assert(!!concurrent.isError, "change made while approval is open is detected");
    assert((await fs.readFile(path.join(root, "a.txt"), "utf8")).includes("user-change"), "concurrent user change is preserved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  if (failures) process.exit(1);
  console.log("\nAll write-tool guarantees hold. ✓");
}

void main();
