import * as vscode from "vscode";
import { AgentMode } from "../../modes";
import { DiffData } from "../../webview/protocol";
import type { ToolReport } from "../../webview/protocol";
import type { StickyMemory } from "../stickyMemory";
import type { ContextManager } from "../contextManager";

/** Outcome of an approval request. */
export type ApprovalDecision = "approved" | "rejected" | "approved-always";

export interface ApprovalRequest {
  /** Stable kind, e.g. "command", "write", "edit". */
  kind: string;
  /** Short human title, e.g. "Run command". */
  title: string;
  /** The thing being approved — a command line, a file path, etc. */
  subject: string;
  /** Optional preview body (command cwd, file path, etc.). */
  detail?: string;
  /** Optional structured diff preview (for edits/writes). */
  diff?: DiffData;
  /** Multi-file patches: one diff per file. */
  diffs?: DiffData[];
}

/** Everything a tool needs to do its job. */
export interface ToolContext {
  workspaceRoot: string;
  mode: AgentMode;
  /** True inside disposable subagents; used to deny interactive-only capabilities. */
  delegated?: boolean;
  /** Request user approval for a side-effecting action. */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** Emit a streaming status/log line to the UI. */
  log(message: string): void;
  /** Cancellation for the whole agent turn. */
  signal: AbortSignal;
  /** Output channel for verbose diagnostics. */
  output: vscode.OutputChannel;
  /**
   * Run a research question through a disposable sub-agent and return its
   * digest. Injected by the main Agent only — absent inside sub-agents, so
   * explore can never recurse.
   */
  explore?(question: string): Promise<SubagentRunResult>;
  /** Run two independent candidate analyses for the parent model to judge. */
  tournament?(question: string): Promise<SubagentRunResult>;
  /**
   * Run a bounded implementation task in a disposable write-capable sub-agent.
   * Absent in Plan mode and inside sub-agents.
   */
  implement?(request: { task: string; paths?: string[] }): Promise<SubagentRunResult>;
  /**
   * Ask the user a clarifying question and wait for their answer.
   * Injected by the main Agent; absent inside sub-agents.
   */
  askUser?(req: { question: string; options?: string[] }): Promise<string>;
  /**
   * Stream live output (stdout, sub-agent progress) to this call's card in
   * the UI while the tool runs. Display-only — never part of the tool result.
   */
  emitOutput?(delta: string): void;
  /** Session scratchpad that survives compaction (shared mutable object). */
  stickyMemory?: StickyMemory;
  /**
   * Live conversation context — used by read tools to short-circuit duplicate
   * lookups that are already present (non-stubbed) in the transcript.
   */
  context?: ContextManager;
  /**
   * Last successful test/build command fingerprint for smart verify skip.
   * Shared mutable object owned by the Agent.
   */
  verifyCache?: {
    command: string;
    exitCode: number;
    at: number;
    pathsHint?: string[];
  };
  /** Optional workspace-relative paths this implementer may modify. Directory
   * scopes end in `/`; omitted means the parent agent owns write safety. */
  writeScope?: string[];
  /** Estimate the upper-bound input cost of delegated work. */
  estimateDelegation?(kind: "research" | "implementation", agents: number): {
    model: string;
    maxContextTokens: number;
    estimatedCost?: number;
  };
}

/** Result returned by a disposable sub-agent. `summary` is model-visible;
 * `report` is rendered only in the UI. */
export interface SubagentRunResult {
  summary: string;
  report: ToolReport;
}

export interface ToolResult {
  /** Text returned to the model as the tool result. */
  content: string;
  /** True if the tool failed (model is told, but the loop continues). */
  isError?: boolean;
  /** Optional structured metadata surfaced in the UI (not sent to model). */
  ui?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the parameters object. */
  parameters: Record<string, unknown>;
  /** True if the tool can modify the workspace or run commands. */
  mutating: boolean;
  /**
   * Tool group for progressive schema loading.
   * - read: always available
   * - edit: file mutations
   * - exec: shell / processes
   * - meta: orchestration (explore, implement, ask_user, tasks, memory)
   */
  group?: "read" | "edit" | "exec" | "meta";
  /**
   * In Plan mode, mutating tools are blocked. Read-only tools always run.
   * Returns the result string shown to the model.
   */
  execute(args: any, ctx: ToolContext): Promise<ToolResult>;
}
