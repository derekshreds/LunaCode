import * as vscode from "vscode";
import { AgentMode } from "../../modes";
import { DiffData } from "../../webview/protocol";

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
}

/** Everything a tool needs to do its job. */
export interface ToolContext {
  workspaceRoot: string;
  mode: AgentMode;
  /** Request user approval for a side-effecting action. */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** Emit a streaming status/log line to the UI. */
  log(message: string): void;
  /** Cancellation for the whole agent turn. */
  signal: AbortSignal;
  /** Output channel for verbose diagnostics. */
  output: vscode.OutputChannel;
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
   * In Plan mode, mutating tools are blocked. Read-only tools always run.
   * Returns the result string shown to the model.
   */
  execute(args: any, ctx: ToolContext): Promise<ToolResult>;
}
