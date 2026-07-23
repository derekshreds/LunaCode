// Luna Code benchmark/telemetry harness. With no argument it reports fixed
// tool-schema tax. Pass a JSON file containing TurnReceipt[] or {receipts: []}
// to aggregate real session cost, latency, cache, failures, and throughput.
import * as fs from "fs";
import { toolsForImplementer, toolsForPhase, toolsForSubagent, toToolDefinitions } from "../src/agent/tools";
import { estimateToolSchemaTokens } from "../src/agent/delegation";
import type { TurnReceipt } from "../src/webview/protocol";

const schemas = {
  readPhase: toToolDefinitions(toolsForPhase(false, "read")),
  fullPhase: toToolDefinitions(toolsForPhase(false, "all")),
  researcher: toToolDefinitions(toolsForSubagent()),
  implementer: toToolDefinitions(toolsForImplementer()),
};

const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  schema: Object.fromEntries(Object.entries(schemas).map(([name, defs]) => [name, {
    tools: defs.length,
    estimatedTokens: estimateToolSchemaTokens(defs),
  }])),
};

const file = process.argv[2];
if (file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const receipts: TurnReceipt[] = Array.isArray(parsed) ? parsed : parsed.receipts ?? [];
  const prompt = receipts.reduce((n, r) => n + r.usage.promptTokens, 0);
  const completion = receipts.reduce((n, r) => n + r.usage.completionTokens, 0);
  const cached = receipts.reduce((n, r) => n + r.usage.cachedTokens, 0);
  const durationMs = receipts.reduce((n, r) => n + Math.max(0, r.endedAt - r.startedAt), 0);
  report.session = {
    turns: receipts.length,
    costUsd: receipts.reduce((n, r) => n + (r.usage.cost ?? 0), 0),
    promptTokens: prompt,
    completionTokens: completion,
    cacheHitPercent: prompt ? Math.round(cached / prompt * 1000) / 10 : 0,
    durationMs,
    avgTurnMs: receipts.length ? Math.round(durationMs / receipts.length) : 0,
    toolCalls: receipts.reduce((n, r) => n + r.toolCalls, 0),
    filesChanged: new Set(receipts.flatMap((r) => r.files.map((f) => f.path))).size,
    failedTools: receipts.reduce((n, r) => n + r.failures.length, 0),
    successfulTurns: receipts.filter((r) => !r.failures.length && r.stopReason !== "error").length,
  };
}

console.log(JSON.stringify(report, null, 2));
