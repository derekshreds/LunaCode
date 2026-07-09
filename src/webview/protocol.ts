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
  /** Index of the change block (hunk) this row belongs to — changed rows only.
   * Used for per-hunk revert; matches reconstructWithReverts' numbering. */
  hunk?: number;
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
  /** Multi-file patches: one diff per file (diff holds the largest). */
  diffs?: DiffData[];
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
  /** Compaction events this session (optional for old persisted sessions). */
  compactions?: number;
  /** Estimated tokens removed from context by compaction events. */
  tokensSaved?: number;
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
  /** Prompt tokens sent / prompt tokens served from cache — the per-model
   * cache hit rate (cached/prompt) that catches cache regressions early. */
  prompt: number;
  cached: number;
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

export interface TaskItem {
  label: string;
  status: "pending" | "active" | "done";
}

/** An @-mention completion. `file`/`folder`/`symbol` insert `insert` text into
 * the composer; `problems`/`git` are resolved host-side into attached context. */
export interface MentionItem {
  kind: "file" | "folder" | "symbol" | "problems" | "git";
  label: string;
  /** Text inserted into the composer when picked (files/folders/symbols). */
  insert?: string;
  /** Argument passed to resolveMention for host-resolved kinds. */
  arg?: string;
  /** Secondary label shown dimmed (e.g. a symbol's location). */
  detail?: string;
}

/** What the context window currently holds — for the context inspector. */
export interface ContextInfo {
  totalTokens: number;
  budget: number;
  systemTokens: number;
  messageCount: number;
  hasMemory: boolean;
  /** Estimated $ for the next fully-cached call (undefined if price unknown). */
  nextCallCostUsd?: number;
  largest: { role: string; preview: string; tokens: number }[];
  /** Token totals by message role (system/user/assistant/tool). */
  byRole?: { role: string; tokens: number; count: number }[];
  /** Tool results already stubbed as superseded/stale/truncated. */
  stubbedToolResults?: number;
}

/** All GUI-editable settings, mirroring the lunacode.* configuration keys. */
export interface SettingsPayload {
  model: string;
  summarizerModel: string;
  subagentModel: string;
  plannerModel: string;
  implementerModel: string;
  subagentMaxContextTokens: number;
  progressiveTools: boolean;
  adaptiveReasoning: boolean;
  fallbackModels: string[];
  favoriteModels: string[];
  prewarmCache: boolean;
  maxContextTokens: number;
  autoBudgetCarryCostUsd: number;
  compactionTargetRatio: number;
  maxTokens: number;
  temperature: number;
  enablePromptCaching: boolean;
  defaultMode: AgentMode;
  dataCollection: "deny" | "allow";
  zeroDataRetention: boolean;
  providerSort: "throughput" | "latency" | "price" | "default";
  quantizations: string[];
  sessionBudgetUsd: number;
  maxTurns: number;
  loopGuardLimit: number;
  reasoningEffort: "default" | "off" | "low" | "medium" | "high";
  includeActiveFile: boolean;
  formatAfterEdit: boolean;
  revealEditedFiles: boolean;
  worktreeMode: boolean;
  autoApproveCommands: string[];
  alwaysDenyCommands: string[];
  baseUrl: string;
  /** JSON text of the lunacode.mcpServers object (edited as JSON in the GUI). */
  mcpServersJson: string;
  /** JSON text of lunacode.customCommands (slash commands). */
  customCommandsJson: string;
}

// Extension -> Webview
export type HostToWebview =
  | {
      type: "init";
      hasApiKey: boolean;
      model: string;
      mode: AgentMode;
      modes: { id: AgentMode; label: string; description: string }[];
      /** Available slash commands (builtins + custom), without the slash. */
      commands?: string[];
      /** First configured fallback model (for the error-card retry action). */
      fallback?: string;
    }
  | {
      type: "config";
      hasApiKey: boolean;
      model: string;
      mode: AgentMode;
      commands?: string[];
      fallback?: string;
    }
  | { type: "turnStart"; model?: string }
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
  /** Queued messages were applied as steering — clear their "Queued" tags. */
  | { type: "steeringApplied" }
  | { type: "usage"; usage: UsagePayload }
  | { type: "error"; message: string }
  | { type: "turnEnd"; stopReason: string }
  | { type: "approvalRequest"; payload: ApprovalPayload }
  /** Clarifying question from the ask_user tool. */
  | {
      type: "askUserRequest";
      id: string;
      question: string;
      options?: string[];
    }
  | { type: "sessionReset" }
  | { type: "userEcho"; text: string; queued?: boolean; echoId?: number; rewindId?: number }
  | {
      type: "sessionList";
      sessions: { id: string; title: string; updatedAt: number }[];
      currentId?: string;
    }
  | { type: "sessionUsage"; usage: SessionUsage }
  | { type: "usageReport"; report: UsageReport }
  | { type: "settingsData"; settings: SettingsPayload }
  | { type: "checkpointState"; turns: number; files: number }
  | { type: "taskList"; tasks: TaskItem[] }
  | { type: "turnDiff"; diffs: DiffData[] }
  | { type: "contextInfo"; info: ContextInfo }
  | { type: "mentionMatches"; token: number; items: MentionItem[] }
  /** Remove the last user message and everything after it from the transcript. */
  | { type: "rollback" }
  /** Data for the rewind confirmation dialog (answer to a rewindPreview request). */
  | {
      type: "rewindPreview";
      id: number;
      messagesDiscarded: number;
      filesRestored: number;
      filesDeleted: number;
      horizonExceeded: boolean;
      text: string;
    }
  /** Attach a rewind button to the live bubble with this echoId once its turn
   * has started (the bubble's turn-start id is now known). */
  | { type: "rewindAssign"; echoId: number; rewindId: number }
  /** The set of rewindable turn-start points (id + restorable file count).
   * Broadcast whenever the turn ledger changes. */
  | { type: "rewindState"; points: { id: number; files: number }[] }
  /** Truncate the transcript from the user bubble with this rewindId onward. */
  | { type: "rewound"; id: number }
  /** Put text into the composer (edit-and-resend flow). */
  | { type: "composerFill"; text: string }
  /** Throttled live token counter while the model generates. */
  | { type: "streamProgress"; tokens: number }
  /** Live output (stdout, explore lookups) for a running tool card. */
  | { type: "toolOutput"; id: string; delta: string };

// Webview -> Extension
export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string; images?: string[] }
  | { type: "cancel" }
  | { type: "setMode"; mode: AgentMode }
  | { type: "approvalResponse"; id: string; decision: "approved" | "rejected" | "approved-always" }
  | { type: "askUserResponse"; id: string; answer: string }
  | { type: "newSession" }
  | { type: "setApiKey" }
  | { type: "selectModel" }
  | { type: "selectSubagentModel" }
  | { type: "listSessions" }
  | { type: "loadSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "getUsage"; days: number }
  | { type: "getSettings" }
  | {
      type: "updateSetting";
      key: keyof SettingsPayload;
      value: SettingsPayload[keyof SettingsPayload];
    }
  | { type: "getTurnDiff" }
  | { type: "commitTurn" }
  /** Revert one reviewed file to its pre-turn state. */
  | { type: "revertFile"; path: string }
  /** Revert only the listed change blocks (hunks) of a reviewed file. */
  | { type: "revertHunks"; path: string; hunks: number[] }
  /** Open a native side-by-side editor diff (pre-turn ↔ current) for a file. */
  | { type: "openDiff"; path: string }
  | { type: "getContextInfo" }
  | { type: "retryTurn" }
  | { type: "editLastTurn" }
  /** Retry the last turn after switching to a specific (fallback) model. */
  | { type: "retryWithModel"; model: string }
  /** Ask the host for rewind-confirm details for a turn-start message id. */
  | { type: "rewindPreview"; id: number }
  /** Execute a rewind to a turn-start message id.
   *  - "rollback": restore files + trim context, then stop (composer left as-is)
   *  - "edit": also place the rolled-back message text in the composer
   *  - "rerun": also re-send the message immediately */
  | { type: "rewindTo"; id: number; mode: "rollback" | "edit" | "rerun" }
  | { type: "exportSession" }
  /** Create a starter LUNA.md (project memory) and open it. */
  | { type: "createMemory" }
  | { type: "queryMentions"; query: string; token: number }
  /** Resolve a host-side mention (problems/git) into attached context. */
  | { type: "resolveMention"; kind: string; arg?: string };
