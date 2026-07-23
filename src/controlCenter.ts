import type { TurnReceipt } from "./webview/protocol";

export type VerificationPolicy = "advisory" | "standard" | "strict";

export interface VerificationGate {
  id: "edits" | "diagnostics" | "tests" | "failures";
  label: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
}

export interface DurableQueueItem {
  id: string;
  text: string;
  images?: string[];
  createdAt: number;
  status: "queued" | "running";
}

export interface RecoveryRun {
  id: string;
  text: string;
  model: string;
  startedAt: number;
  updatedAt: number;
  lastEvent: string;
  toolCalls: number;
}

export interface AuditEntry {
  id: string;
  at: number;
  kind: "approval" | "command" | "write" | "sandbox" | "security" | "recovery";
  action: string;
  subject: string;
  outcome: "allowed" | "denied" | "completed" | "failed" | "pending";
  detail?: string;
}

export interface AgentGraphNode {
  id: string;
  label: string;
  kind: "turn" | "research" | "implementation" | "verification";
  status: "running" | "success" | "failed";
  cost?: number;
  durationMs?: number;
  parent?: string;
  prompt?: string;
}

export interface RepoIntelligence {
  generatedAt: number;
  languages: string[];
  entrypoints: string[];
  modules: Array<{ name: string; files: number }>;
  dependencies: Array<{ from: string; to: string; count: number }>;
  hotspots: Array<{ path: string; touches: number; churn: number }>;
  testFiles: number;
  sourceFiles: number;
  risk: string[];
}

export interface ToolLabEntry {
  phase: string;
  tools: number;
  estimatedTokens: number;
  largest: Array<{ name: string; estimatedTokens: number }>;
}

export interface ControlCenterSnapshot {
  queue: DurableQueueItem[];
  queuePaused: boolean;
  recovery?: RecoveryRun;
  sandbox?: { branch: string; dir: string; changedFiles: number };
  verificationPolicy: VerificationPolicy;
  gates: VerificationGate[];
  budget: {
    spent: number;
    limit: number;
    remaining?: number;
    projectedNextTurn?: number;
    state: "unlimited" | "healthy" | "warning" | "blocked";
  };
  graph: AgentGraphNode[];
  repo: RepoIntelligence;
  tools: ToolLabEntry[];
  audit: AuditEntry[];
  memory: { path?: string; contents: string; decisions: string[] };
}

const VERIFY_COMMAND = /\b(test|check|lint|build|typecheck|tsc|pytest|jest|vitest|cargo test|go test)\b/i;

export function verificationGates(
  receipt: TurnReceipt | undefined,
  policy: VerificationPolicy
): VerificationGate[] {
  if (!receipt) return [];
  const edited = receipt.files.length > 0;
  const evidence = receipt.evidence.join("\n");
  const cleanDiagnostics = /no diagnostics|diagnostics.*clean|0 (?:errors|problems)/i.test(evidence);
  const badDiagnostics = /(?:error|diagnostic).*(?:failed|found)|[1-9]\d* (?:errors|problems)/i.test(evidence);
  const verificationCommands = receipt.commands.filter((c) => VERIFY_COMMAND.test(c.command));
  const passedCommand = verificationCommands.some((c) => c.ok);
  const failedCommand = verificationCommands.some((c) => !c.ok);

  const diagnostics: VerificationGate = !edited
    ? { id: "diagnostics", label: "Diagnostics", status: "skip", detail: "No files changed." }
    : badDiagnostics
      ? { id: "diagnostics", label: "Diagnostics", status: "fail", detail: "Diagnostics reported actionable problems." }
      : cleanDiagnostics
        ? { id: "diagnostics", label: "Diagnostics", status: "pass", detail: "Changed files are clean." }
        : { id: "diagnostics", label: "Diagnostics", status: policy === "strict" ? "fail" : "warn", detail: "No explicit clean diagnostic evidence was recorded." };

  const tests: VerificationGate = !edited
    ? { id: "tests", label: "Tests/build", status: "skip", detail: "No files changed." }
    : failedCommand
      ? { id: "tests", label: "Tests/build", status: "fail", detail: "A verification command failed." }
      : passedCommand
        ? { id: "tests", label: "Tests/build", status: "pass", detail: "Verification completed successfully." }
        : { id: "tests", label: "Tests/build", status: policy === "strict" ? "fail" : "warn", detail: "No test, lint, typecheck, or build command was recorded." };

  return [
    { id: "edits", label: "Change set", status: edited ? "pass" : "skip", detail: edited ? `${receipt.files.length} changed file(s) captured.` : "This turn did not edit files." },
    diagnostics,
    tests,
    {
      id: "failures",
      label: "Tool failures",
      status: receipt.failures.length ? "fail" : "pass",
      detail: receipt.failures.length ? `${receipt.failures.length} failure(s) recorded.` : "No tool failures recorded.",
    },
  ];
}

export function buildAgentGraph(receipts: TurnReceipt[], active?: RecoveryRun): AgentGraphNode[] {
  const nodes: AgentGraphNode[] = [];
  for (const r of receipts.slice(-20)) {
    const turnId = `turn-${r.id}`;
    nodes.push({
      id: turnId,
      label: `Turn ${r.id}`,
      kind: "turn",
      status: r.failures.length ? "failed" : "success",
      cost: r.usage.cost,
      durationMs: r.endedAt - r.startedAt,
    });
    r.subagents.forEach((s, i) => nodes.push({
      id: `${turnId}-${s.kind}-${i}`,
      label: `${s.kind === "research" ? "Research" : "Implement"} · ${s.agents} agent${s.agents === 1 ? "" : "s"}`,
      kind: s.kind,
      status: s.successful === s.agents ? "success" : "failed",
      cost: s.cost,
      durationMs: s.durationMs,
      parent: turnId,
      prompt: s.task,
    }));
    if (r.files.length) nodes.push({
      id: `${turnId}-verify`,
      label: "Verification",
      kind: "verification",
      status: r.failures.length ? "failed" : "success",
      parent: turnId,
    });
  }
  if (active) nodes.push({
    id: `active-${active.id}`,
    label: "Active turn",
    kind: "turn",
    status: "running",
    durationMs: Date.now() - active.startedAt,
  });
  return nodes;
}

export function budgetState(
  spent: number,
  limit: number,
  recentCosts: number[]
): ControlCenterSnapshot["budget"] {
  const projectedNextTurn = recentCosts.length
    ? recentCosts.reduce((a, b) => a + b, 0) / recentCosts.length
    : undefined;
  if (limit <= 0) return { spent, limit, projectedNextTurn, state: "unlimited" };
  const remaining = Math.max(0, limit - spent);
  const ratio = spent / limit;
  return {
    spent,
    limit,
    remaining,
    projectedNextTurn,
    state: ratio >= 1 ? "blocked" : ratio >= 0.8 || (projectedNextTurn !== undefined && projectedNextTurn > remaining) ? "warning" : "healthy",
  };
}
