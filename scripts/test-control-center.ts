import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { budgetState, buildAgentGraph, verificationGates } from "../src/controlCenter";
import { buildRepoIntelligence } from "../src/agent/repoIntelligence";
import { canUseIsolatedWorktree, runInIsolatedWorktree } from "../src/agent/isolatedWorktree";
import { isSensitivePath, redactSecrets } from "../src/agent/tools/util";
import { readFileTool } from "../src/agent/tools/readTools";
import type { TurnReceipt } from "../src/webview/protocol";

function receipt(overrides: Partial<TurnReceipt> = {}): TurnReceipt {
  return {
    id: 7,
    startedAt: 100,
    endedAt: 500,
    model: "test/model",
    stopReason: "stop",
    toolCalls: 2,
    files: [{ path: "src/a.ts", added: 3, removed: 1 }],
    commands: [{ command: "npm test", ok: true, summary: "exit 0" }],
    subagents: [],
    evidence: ["Diagnostics clean: 0 errors"],
    failures: [],
    usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2, cost: 0.02 },
    ...overrides,
  };
}

async function main() {
  const strict = verificationGates(receipt(), "strict");
  assert.equal(strict.find((g) => g.id === "diagnostics")?.status, "pass");
  assert.equal(strict.find((g) => g.id === "tests")?.status, "pass");
  const missing = verificationGates(receipt({ commands: [], evidence: [] }), "strict");
  assert.equal(missing.find((g) => g.id === "diagnostics")?.status, "fail");
  assert.equal(missing.find((g) => g.id === "tests")?.status, "fail");
  assert.equal(budgetState(0.9, 1, [0.2]).state, "warning");
  assert.equal(budgetState(1, 1, []).state, "blocked");
  assert.equal(buildAgentGraph([receipt()]).filter((n) => n.kind === "verification").length, 1);
  const graphWithAgent = buildAgentGraph([receipt({ subagents: [{
    kind: "research", agents: 1, successful: 1, iterations: 1, toolCalls: 1,
    durationMs: 10, promptTokens: 10, completionTokens: 5, cachedTokens: 0,
    tools: [], sources: [], task: "inspect auth",
  }] })]);
  assert.equal(graphWithAgent.find((n) => n.kind === "research")?.prompt, "inspect auth");

  assert.equal(isSensitivePath(".env.local"), true);
  assert.equal(isSensitivePath("src/index.ts"), false);
  assert.ok(!redactSecrets("api_key=supersecretvalue").includes("supersecretvalue"));
  assert.ok(!redactSecrets("token sk-abcdefghijklmnopqrstuvwxyz").includes("sk-abcdefghijklmnopqrstuvwxyz"));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunacode-control-test-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "src", "agent"));
    fs.mkdirSync(path.join(root, "src", "webview"));
    fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(root, "src", "agent", "a.ts"), "import '../webview/b';\n");
    fs.writeFileSync(path.join(root, "src", "webview", "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(root, "tests", "index.test.ts"), "test('x', () => {});\n");
    const intel = await buildRepoIntelligence(root, [receipt()]);
    assert.ok(intel.languages.includes("TypeScript"));
    assert.equal(intel.testFiles, 1);
    assert.equal(intel.hotspots[0].path, "src/a.ts");
    assert.ok(intel.dependencies.some((d) => d.from === "src/agent" && d.to === "src/webview"));

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Luna Test"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export const x = 2;\n");
    fs.writeFileSync(path.join(root, "src", "untracked.ts"), "export const y = 1;\n");
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=do-not-read\n");
    let approvalCalls = 0;
    const blockedRead = await readFileTool.execute({ path: ".env" }, {
      workspaceRoot: root,
      mode: "plan",
      delegated: true,
      signal: new AbortController().signal,
      output: {} as any,
      log: () => undefined,
      requestApproval: async () => { approvalCalls++; return "approved"; },
    });
    assert.equal(blockedRead.isError, true);
    assert.equal(approvalCalls, 0);
    assert.equal(await canUseIsolatedWorktree(root), true);
    const snapshotted: string[] = [];
    const isolated = await runInIsolatedWorktree({
      root,
      signal: new AbortController().signal,
      run: async (worktree) => {
        assert.equal(fs.readFileSync(path.join(worktree, "src", "index.ts"), "utf8"), "export const x = 2;\n");
        assert.equal(fs.readFileSync(path.join(worktree, "src", "untracked.ts"), "utf8"), "export const y = 1;\n");
        assert.equal(fs.existsSync(path.join(worktree, ".env")), false);
        fs.writeFileSync(path.join(worktree, "src", "index.ts"), "export const x = 3;\n");
        fs.writeFileSync(path.join(worktree, "src", "untracked.ts"), "export const y = 2;\n");
        return "done";
      },
      beforeApply: async (paths) => snapshotted.push(...paths),
    });
    assert.equal(isolated.result, "done");
    assert.deepEqual(snapshotted.sort(), ["src/index.ts", "src/untracked.ts"]);
    assert.equal(fs.readFileSync(path.join(root, "src", "index.ts"), "utf8"), "export const x = 3;\n");
    assert.equal(fs.readFileSync(path.join(root, "src", "untracked.ts"), "utf8"), "export const y = 2;\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("control center tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
