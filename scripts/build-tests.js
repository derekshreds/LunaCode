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
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
