// Bundles the standalone test entry points to dist/ for `npm test`.
// Kept as a real file (not an inline `node -e` string) so it's not fragile to
// shell quoting/escaping.
const esbuild = require("esbuild");

async function main() {
  await Promise.all([
    esbuild.build({
      entryPoints: ["scripts/test-context.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-context.js",
    }),
    esbuild.build({
      entryPoints: ["scripts/test-usage.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-usage.js",
      // usage.ts imports 'vscode' at module scope; stub it for Node.
      alias: { vscode: "./scripts/vscode-stub.ts" },
    }),
    esbuild.build({
      entryPoints: ["scripts/test-openrouter.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-openrouter.js",
    }),
    esbuild.build({
      entryPoints: ["scripts/test-checkpoints.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-checkpoints.js",
    }),
    esbuild.build({
      entryPoints: ["scripts/test-loop-guard.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-loop-guard.js",
    }),
    esbuild.build({
      entryPoints: ["scripts/test-write-tools.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-write-tools.js",
      alias: { vscode: "./scripts/vscode-stub.ts" },
    }),
    esbuild.build({
      entryPoints: ["scripts/test-coordination.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-coordination.js",
    }),
    esbuild.build({
      entryPoints: ["scripts/test-subagent.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-subagent.js",
      alias: { vscode: "./scripts/vscode-stub.ts" },
    }),
    esbuild.build({
      entryPoints: ["scripts/test-control-center.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: "dist/test-control-center.js",
      alias: { vscode: "./scripts/vscode-stub.ts" },
    }),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
