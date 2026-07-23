import type { ToolDefinition } from "../openrouter/types";
import type { ToolReport } from "../webview/protocol";
import type { SubagentRunResult } from "./tools/types";

export interface DelegatedJob {
  task: string;
  paths?: string[];
}

function normalizeScope(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/$/, "");
}

/** Parallel writes are safe only when every job declares a non-overlapping scope. */
export function canRunJobsInParallel(jobs: DelegatedJob[]): boolean {
  if (jobs.length < 2 || jobs.some((job) => !job.paths?.length)) return false;
  return !jobs.some((a, i) => jobs.slice(i + 1).some((b) =>
    a.paths!.some((ap) => b.paths!.some((bp) => {
      const x = normalizeScope(ap);
      const y = normalizeScope(bp);
      return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
    }))
  ));
}

export function combineSubagentReports(
  kind: ToolReport["kind"],
  results: SubagentRunResult[],
): ToolReport {
  const tools = new Map<string, number>();
  const sources = new Set<string>();
  let cost = 0;
  for (const { report } of results) {
    for (const tool of report.tools) tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
    for (const source of report.sources) sources.add(source);
    cost += report.cost ?? 0;
  }
  return {
    kind,
    task: results.map((r) => r.report.task).filter(Boolean).join("\n\n").slice(0, 4000) || undefined,
    agents: results.length,
    successful: results.reduce((n, r) => n + r.report.successful, 0),
    iterations: results.reduce((n, r) => n + r.report.iterations, 0),
    toolCalls: results.reduce((n, r) => n + r.report.toolCalls, 0),
    durationMs: Math.max(0, ...results.map((r) => r.report.durationMs)),
    promptTokens: results.reduce((n, r) => n + r.report.promptTokens, 0),
    completionTokens: results.reduce((n, r) => n + r.report.completionTokens, 0),
    cachedTokens: results.reduce((n, r) => n + r.report.cachedTokens, 0),
    ...(cost > 0 ? { cost } : {}),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    sources: [...sources].slice(0, 30),
  };
}

export function estimateToolSchemaTokens(definitions: ToolDefinition[]): number {
  return Math.ceil(JSON.stringify(definitions).length / 4);
}
