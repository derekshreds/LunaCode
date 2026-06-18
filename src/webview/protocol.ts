// Message protocol shared between the extension host and the webview UI.
import { AgentMode } from "../modes";

// Structured side-by-side diff (git-style). Computed in the extension, rendered
// with line numbers + syntax highlighting in the webview.
export interface DiffCell {
  n: number;
  text: string;
  type: "del" | "add" | "ctx";
}
export interface DiffRow {
  left?: DiffCell;
  right?: DiffCell;
  gap?: string; // a collapsed-context separator label (e.g. "@@ … @@")
}
export interface DiffData {
  path: string;
  language?: string;
  rows: DiffRow[];
  addCount: number;
  delCount: number;
  truncated?: boolean;
}

export interface ApprovalPayload {
  id: string;
  kind: string;
  title: string;
  subject: string;
  detail?: string;
  diff?: DiffData;
}

export interface UsagePayload {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost?: number;
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
}

// Analytics shapes (kept vscode-free so the webview bundle can use them).
export interface DailyPoint {
  date: string;
  cost: number;
  prompt: number;
  completion: number;
  cached: number;
  linesAdded: number;
  linesRemoved: number;
  /** Per-model breakdown for this day (for stacked charts). */
  models: Record<string, { cost: number; tokens: number; added: number; removed: number }>;
}
export interface ModelPoint {
  model: string;
  cost: number;
  tokens: number;
  count: number;
  linesAdded: number;
  linesRemoved: number;
}
export interface UsageReport {
  days: number;
  totalCost: number;
  totalPrompt: number;
  totalCompletion: number;
  totalCached: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  turns: number;
  daily: DailyPoint[];
  byModel: ModelPoint[];
}

// Extension -> Webview
export type HostToWebview =
  | {
      type: "init";
      hasApiKey: boolean;
      model: string;
      mode: AgentMode;
      modes: { id: AgentMode; label: string; description: string }[];
    }
  | { type: "config"; hasApiKey: boolean; model: string; mode: AgentMode }
  | { type: "turnStart" }
  | { type: "assistantText"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "toolStart"; id: string; name: string; args: any }
  | {
      type: "toolEnd";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      diff?: DiffData;
    }
  | { type: "status"; message: string }
  | { type: "usage"; usage: UsagePayload }
  | { type: "error"; message: string }
  | { type: "turnEnd"; stopReason: string }
  | { type: "approvalRequest"; payload: ApprovalPayload }
  | { type: "sessionReset" }
  | { type: "userEcho"; text: string; queued?: boolean }
  | {
      type: "sessionList";
      sessions: { id: string; title: string; updatedAt: number }[];
      currentId?: string;
    }
  | { type: "sessionUsage"; usage: SessionUsage }
  | { type: "usageReport"; report: UsageReport };

// Webview -> Extension
export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "setMode"; mode: AgentMode }
  | { type: "approvalResponse"; id: string; decision: "approved" | "rejected" | "approved-always" }
  | { type: "newSession" }
  | { type: "setApiKey" }
  | { type: "selectModel" }
  | { type: "listSessions" }
  | { type: "loadSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "getUsage"; days: number };
