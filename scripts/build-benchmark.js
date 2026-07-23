const esbuild = require("esbuild");

esbuild.build({
  entryPoints: ["scripts/benchmark.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/benchmark.js",
  alias: { vscode: "./scripts/vscode-stub.ts" },
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
