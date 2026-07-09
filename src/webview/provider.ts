import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { HostToWebview, WebviewToHost } from "./protocol";
import { Agent } from "../agent/agent";
import { ContextManager } from "../agent/contextManager";
import { collapseRestoreSet } from "../agent/checkpoints";
import { computeDiff, reconstructWithReverts } from "../diff";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { OpenRouterClient } from "../openrouter/client";
import { getConfig, SecretStore } from "../config";
import { AgentMode, MODES } from "../modes";
import { ApprovalDecision, ApprovalRequest } from "../agent/tools/types";
import { IGNORED_DIRS, resolveInWorkspace } from "../agent/tools/util";
import { toolsForPhase, toToolDefinitions } from "../agent/tools";
import { SessionStore, StoredSession, deriveTitle } from "../sessions";
import { AssistantMessage, ChatMessage } from "../openrouter/types";
import { UsageStore } from "../usage";
import { SessionUsage, SettingsPayload, MentionItem } from "./protocol";
import { McpManager } from "../mcp/manager";
import { disposeAllProcesses, setProcessExitHandler } from "../agent/tools/backgroundProcess";
import { getRepoMap } from "../agent/repoMap";
import {
  StickyMemory,
  emptyStickyMemory,
  renderStickyMemory,
  stickyIsEmpty,
} from "../agent/stickyMemory";

/** Built-in slash commands. Templates may use $ARGUMENTS (all extra text) and
 * $1..$9 (positional). Custom ones come from lunacode.customCommands and project
 * .luna/commands/*.md files. */
const SLASH_COMMANDS: Record<string, string> = {
  commit:
    "Look at the current git status and diff (prefer git_status and git_diff tools), stage the appropriate files, and create a commit with a well-written conventional commit message. Show the final commit.",
  review:
    "Review the current working tree changes (prefer git_diff with both=true). Report findings ordered by severity — bugs, then risks, then style — with specific file:line references. Do not change any files.",
  tests:
    "Run the project's test suite, analyze any failures, fix them, and re-run until everything passes.",
  pr: "Summarize the changes on the current branch versus the default branch (prefer git_log and git_diff tools), then draft a pull request title and description (what changed, why, and how to test). Do not push or open the PR unless asked.",
  fix: "Investigate and fix the following issue, then verify the fix: $ARGUMENTS",
  explain:
    "Explain how the following code or concept works, concisely and with references to the relevant files: $ARGUMENTS",
  doc: "Add or improve documentation (comments/README/docstrings) for the following, matching the project's existing style: $ARGUMENTS",
  optimize:
    "Profile or reason about the performance of the following and propose the smallest change that meaningfully improves it, then apply it: $ARGUMENTS",
};

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout));
    });
  });
}

/**
 * Owns all session state (conversation, agent, approvals) and can be bound to
 * any number of webviews simultaneously — the sidebar view and/or an editor
 * tab. Outgoing events are broadcast to every attached surface; a lightweight
 * transcript is replayed when a new surface attaches so it shows the history.
 */
export class LunaCodeController {
  private context: ContextManager;
  private agent?: Agent;
  private mode: AgentMode;
  private running = false;
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private approvalSeq = 0;
  private pendingAskUsers = new Map<string, (answer: string) => void>();
  private askUserSeq = 0;
  private sessionApprovedKinds = new Set<string>();
  private pendingSelections: string[] = [];
  /** Session scratchpad that survives compaction. */
  private stickyMemory: StickyMemory = emptyStickyMemory();
  /** Cached repo map for the current workspace root. */
  private repoMapCache: { root: string; text: string; at: number } | null = null;
  /** Frozen per session (like repoMapCache) so the system prompt stays byte-stable. */
  private overviewCache: { root: string; text: string } | null = null;
  /** Project-memory bytes, reused while the underlying files' mtimes are
   * unchanged — replaces a sync depth-4 walk per turn with a handful of stats. */
  private projectMemoryCache: {
    root: string;
    stamps: Array<{ path: string; mtimeMs: number }>;
    result: string | undefined;
  } | null = null;
  /** User messages waiting to run (queued while a turn is active). `echoId` ties
   * a queued message back to its transcript bubble so the rewind button can be
   * attached to it once the turn actually starts. */
  private queue: Array<{ text: string; images?: string[]; echoId?: number }> = [];
  /** Monotonic id for user-message bubbles (rewind bubble handle). */
  private echoSeq = 0;

  private webviews = new Set<vscode.Webview>();
  private transcript: HostToWebview[] = [];
  private static MAX_TRANSCRIPT = 5000;

  private currentSessionId?: string;
  private currentCreatedAt = 0;
  private sessionUsage: SessionUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cost: 0,
  };
  private activeModel = "";
  /** Model metadata (context window + prompt price) for auto context budgets. */
  private modelMeta = new Map<string, { contextLength?: number; promptPrice?: number }>();
  private modelMetaPromise: Promise<void> | null = null;
  private modelMetaFetchedAt = 0;

  /** Turn ledger for the unified rewind (oldest first). One entry per turn,
   * tying its initiating user-message id to that turn's file checkpoint
   * (before-contents; null value = file didn't exist). `checkpoint` is null for
   * a no-edit turn or one trimmed beyond the checkpoint horizon; `hadEdits`
   * records whether it ever captured files (to warn on horizon-limited rewinds).
   * `activeCheckpoint` aliases the current turn's map while it runs. */
  private turns: Array<{
    id: number;
    checkpoint: Map<string, string | null> | null;
    hadEdits: boolean;
  }> = [];
  private activeCheckpoint: Map<string, string | null> | null = null;
  private static MAX_CHECKPOINT_TURNS = 10;
  private static MAX_CHECKPOINT_FILE_BYTES = 2 * 1024 * 1024;

  /** MCP tools frozen at the session's first turn — tools render at position 0
   * of the prompt, so a server connecting mid-session must not change the tool
   * array (it would invalidate the entire prompt cache). */
  private sessionMcpTools: import("../agent/tools/types").Tool[] | null = null;
  /** Progressive-tools phase, carried across turns. The Agent is rebuilt per
   * turn; without this the phase would reset and flip the tool schema (a full
   * prompt-cache miss) twice every turn. */
  private sessionToolPhase: import("../agent/tools").ToolPhase = "read";
  /** Cached workspace file list for @-mention completion. */
  private fileListCache: { files: string[]; at: number } | null = null;
  private prewarmed = "";
  /** Git-worktree sandbox (lunacode.worktreeMode). */
  private sandbox?: { dir: string; branch: string };
  /** Last file-scheme editor — activeTextEditor is undefined while the webview
   * has focus, so we remember the one the user was just in. */
  private lastEditor?: vscode.TextEditor;
  private editorTracker?: vscode.Disposable;

  private readonly mcp: McpManager;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: SecretStore,
    private readonly output: vscode.OutputChannel,
    private readonly sessions: SessionStore,
    private readonly usage: UsageStore
  ) {
    const cfg = getConfig();
    this.mode = cfg.defaultMode;
    this.context = new ContextManager(cfg.enablePromptCaching);
    // Sticky scratchpad rides in the render-time ephemeral tail (past every
    // cache breakpoint) so its constant mutation never busts the cached
    // prefix. The closure reads the live field, so session resets/loads and
    // mid-turn updates are picked up on the next render with no re-wiring.
    this.context.setEphemeralTail(() =>
      stickyIsEmpty(this.stickyMemory) ? "" : renderStickyMemory(this.stickyMemory)
    );
    this.mcp = new McpManager(output, (m) => this.post({ type: "status", message: m }));
    this.mcp.refresh(cfg.mcpServers);
    this.lastEditor = vscode.window.activeTextEditor;
    this.editorTracker = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e && e.document.uri.scheme === "file") this.lastEditor = e;
    });
    // Warm model metadata so the first turn never waits on /models.
    this.preloadModelMeta();
    // Surface background process exits so the agent/user can react without polling.
    setProcessExitHandler((id, name, code) => {
      this.post({
        type: "status",
        message: `Background process ${name} (${id}) exited with code ${code}.`,
      });
    });
  }

  dispose() {
    this.mcp.dispose();
    this.editorTracker?.dispose();
    disposeAllProcesses();
  }

  // --- surface management ---

  attach(webview: vscode.Webview): vscode.Disposable {
    this.webviews.add(webview);
    return webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.handleMessage(msg, webview)
    );
  }

  detach(webview: vscode.Webview) {
    this.webviews.delete(webview);
  }

  private post(msg: HostToWebview) {
    this.record(msg);
    for (const w of this.webviews) {
      void w.postMessage(msg);
    }
  }

  private record(msg: HostToWebview) {
    // Transient/state messages are recomputed on attach; don't replay them.
    // (settingsData/usageReport would pop their sheets open on reload.)
    if (
      msg.type === "init" ||
      msg.type === "config" ||
      msg.type === "sessionList" ||
      msg.type === "settingsData" ||
      msg.type === "usageReport" ||
      msg.type === "streamProgress" ||
      msg.type === "toolOutput" || // live-only; a flood would evict the transcript
      msg.type === "reasoning" || // live-only thinking; not part of stored messages
      msg.type === "steeringApplied" || // transient; queued tags don't exist on replay
      msg.type === "mentionMatches" ||
      msg.type === "rewindState" || // resent fresh on attach (see sendInit)
      msg.type === "rewindAssign" || // the userEcho it targets is mutated to carry rewindId
      msg.type === "rewound" || // transcript is trimmed in place; replay is a no-op
      msg.type === "rewindPreview" // transient response to a user action
    ) {
      return;
    }
    this.transcript.push(msg);
    if (this.transcript.length > LunaCodeController.MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - LunaCodeController.MAX_TRANSCRIPT);
    }
  }

  // --- public commands ---

  newSession() {
    this.context.reset();
    this.sessionApprovedKinds.clear();
    this.pendingSelections = [];
    this.queue = [];
    this.transcript = [];
    this.currentSessionId = undefined;
    this.currentCreatedAt = 0;
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
    this.turns = [];
    this.activeCheckpoint = null;
    this.sessionMcpTools = null; // pick up newly-connected MCP servers
    this.sessionToolPhase = "read";
    this.stickyMemory = emptyStickyMemory();
    // New session = new cache prefix anyway; re-read the volatile prompt inputs.
    this.repoMapCache = null;
    this.overviewCache = null;
    this.projectMemoryCache = null;
    // Reject any in-flight ask_user prompts.
    for (const [, resolve] of this.pendingAskUsers) resolve("");
    this.pendingAskUsers.clear();
    this.postCheckpointState();
    this.postRewindState();
    this.post({ type: "sessionReset" });
    this.post({ type: "taskList", tasks: [] });
    void this.maybePrewarm();
    this.post({ type: "sessionUsage", usage: this.sessionUsage });
    void this.sendConfig();
  }

  /**
   * Build the system prompt. Every input is frozen per session so the prompt
   * is byte-identical turn over turn (a stable cache prefix). `refreshVolatile`
   * re-reads the repo map / overview — pass it only on planned cache misses
   * (compaction) since any prompt change re-processes the whole prefix.
   * Project memory is mtime-guarded: an edit to a known LUNA.md refreshes it
   * (one intentional cache re-write), otherwise the cached bytes are reused.
   */
  private async buildPromptForRoot(
    root: string,
    opts?: { refreshVolatile?: boolean }
  ): Promise<string> {
    let repoMap: string | undefined;
    try {
      if (
        this.repoMapCache &&
        this.repoMapCache.root === root &&
        !opts?.refreshVolatile
      ) {
        repoMap = this.repoMapCache.text;
      } else {
        repoMap = await getRepoMap(root);
        this.repoMapCache = { root, text: repoMap, at: Date.now() };
      }
    } catch {
      // Keep the stale map rather than dropping the section — a prompt that
      // flip-flops between builds costs two extra full cache misses.
      repoMap =
        this.repoMapCache?.root === root ? this.repoMapCache.text : undefined;
    }
    if (
      !this.overviewCache ||
      this.overviewCache.root !== root ||
      opts?.refreshVolatile
    ) {
      this.overviewCache = { root, text: this.workspaceOverview(root) };
    }
    return buildSystemPrompt({
      mode: this.mode,
      workspaceRoot: root,
      os: `${os.type()} ${os.release()} (${os.platform()})`,
      shell: os.platform() === "win32" ? "PowerShell" : "sh",
      workspaceOverview: this.overviewCache.text,
      repoMap,
      projectMemory: this.projectMemory(root, !!opts?.refreshVolatile),
    });
  }

  addSelection(text: string, file: string, startLine: number) {
    const block = "```\n" + text + "\n```";
    this.pendingSelections.push(`Selection from ${file}:${startLine}:\n${block}`);
    this.post({
      type: "status",
      message: `Selection from ${file}:${startLine} added — type what to do with it, then send.`,
    });
  }

  async sendConfig() {
    const cfg = getConfig();
    const key = await this.secrets.getApiKey();
    this.post({
      type: "config",
      hasApiKey: !!key,
      model: cfg.model,
      mode: this.mode,
      commands: this.commandList(),
      fallback: cfg.fallbackModels[0],
    });
  }

  /** Called when lunacode.* settings change anywhere (settings editor, model
   * QuickPick, the GUI itself) — refreshes the model chip and any open sheet. */
  onConfigChanged() {
    // Model may have changed — make sure its metadata is warm before the next turn.
    this.preloadModelMeta();
    void this.sendConfig();
    this.sendSettings();
    this.mcp.refresh(getConfig().mcpServers);
  }

  // --- messaging ---

  private async handleMessage(msg: WebviewToHost, source: vscode.Webview) {
    switch (msg.type) {
      case "ready":
        await this.sendInit(source);
        break;
      case "send":
        await this.onSend(msg.text, msg.images);
        break;
      case "cancel":
        this.agent?.cancel();
        break;
      case "setMode":
        this.mode = msg.mode;
        await this.sendConfig();
        break;
      case "approvalResponse": {
        const resolver = this.pendingApprovals.get(msg.id);
        if (resolver) {
          this.pendingApprovals.delete(msg.id);
          resolver(msg.decision);
        }
        break;
      }
      case "askUserResponse": {
        const resolver = this.pendingAskUsers.get(msg.id);
        if (resolver) {
          this.pendingAskUsers.delete(msg.id);
          resolver(msg.answer ?? "");
        }
        break;
      }
      case "newSession":
        this.newSession();
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("lunacode.setApiKey");
        break;
      case "selectModel":
        await vscode.commands.executeCommand("lunacode.selectModel");
        break;
      case "selectSubagentModel":
        await vscode.commands.executeCommand("lunacode.selectSubagentModel");
        break;
      case "listSessions":
        this.sendSessionList();
        break;
      case "loadSession":
        await this.loadSession(msg.id);
        break;
      case "deleteSession":
        await this.sessions.delete(msg.id);
        if (msg.id === this.currentSessionId) this.currentSessionId = undefined;
        this.sendSessionList();
        break;
      case "getUsage":
        this.post({ type: "usageReport", report: this.usage.aggregate(msg.days) });
        break;
      case "getSettings":
        this.sendSettings();
        break;
      case "updateSetting":
        await this.updateSetting(msg.key, msg.value);
        break;
      case "getTurnDiff":
        this.sendTurnDiff();
        break;
      case "commitTurn":
        await this.commitLastTurn();
        break;
      case "revertFile":
        this.revertReviewedFile(msg.path);
        break;
      case "revertHunks":
        this.revertReviewedHunks(msg.path, msg.hunks);
        break;
      case "openDiff":
        void this.openReviewedDiff(msg.path);
        break;
      case "getContextInfo":
        void this.sendContextInfo();
        break;
      case "retryTurn":
        await this.rewindTo(this.lastTurnId(), "rerun");
        break;
      case "editLastTurn":
        await this.rewindTo(this.lastTurnId(), "edit");
        break;
      case "retryWithModel":
        await this.retryWithModel(msg.model);
        break;
      case "rewindPreview":
        this.buildRewindPreview(msg.id);
        break;
      case "rewindTo":
        await this.rewindTo(msg.id, msg.mode);
        break;
      case "exportSession":
        await this.exportSession();
        break;
      case "createMemory":
        await this.createMemory();
        break;
      case "queryMentions":
        void this.queryMentions(msg.query, msg.token, source);
        break;
      case "resolveMention":
        void this.resolveMention(msg.kind, msg.arg);
        break;
    }
  }

  private sendSettings() {
    const cfg = getConfig();
    this.post({
      type: "settingsData",
      settings: {
        model: cfg.model,
        summarizerModel: cfg.summarizerModel,
        subagentModel: cfg.subagentModel,
        plannerModel: cfg.plannerModel,
        implementerModel: cfg.implementerModel,
        subagentMaxContextTokens: cfg.subagentMaxContextTokens,
        progressiveTools: cfg.progressiveTools,
        adaptiveReasoning: cfg.adaptiveReasoning,
        fallbackModels: cfg.fallbackModels,
        favoriteModels: cfg.favoriteModels,
        prewarmCache: cfg.prewarmCache,
        maxContextTokens: cfg.maxContextTokens,
        autoBudgetCarryCostUsd: cfg.autoBudgetCarryCostUsd,
        compactionTargetRatio: cfg.compactionTargetRatio,
        microcompactRatio: cfg.microcompactRatio,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        enablePromptCaching: cfg.enablePromptCaching,
        defaultMode: cfg.defaultMode,
        dataCollection: cfg.dataCollection,
        zeroDataRetention: cfg.zeroDataRetention,
        providerSort: cfg.providerSort ?? "default",
        quantizations: cfg.quantizations,
        sessionBudgetUsd: cfg.sessionBudgetUsd,
        maxTurns: cfg.maxTurns,
        loopGuardLimit: cfg.loopGuardLimit,
        reasoningEffort: cfg.reasoningEffort,
        includeActiveFile: cfg.includeActiveFile,
        formatAfterEdit: cfg.formatAfterEdit,
        revealEditedFiles: cfg.revealEditedFiles,
        worktreeMode: cfg.worktreeMode,
        autoApproveCommands: cfg.autoApproveCommands,
        alwaysDenyCommands: cfg.alwaysDenyCommands,
        baseUrl: cfg.baseUrl,
        mcpServersJson: JSON.stringify(cfg.mcpServers ?? {}, null, 2),
        customCommandsJson: JSON.stringify(cfg.customCommands ?? {}, null, 2),
      },
    });
  }

  /** Settings keys the GUI is allowed to write. Guards against arbitrary keys
   * arriving from a compromised or stale webview. */
  private static WRITABLE_SETTINGS = new Set<keyof SettingsPayload>([
    "model",
    "summarizerModel",
    "subagentModel",
    "plannerModel",
    "implementerModel",
    "subagentMaxContextTokens",
    "progressiveTools",
    "adaptiveReasoning",
    "fallbackModels",
    "favoriteModels",
    "prewarmCache",
    "sessionBudgetUsd",
    "maxTurns",
    "loopGuardLimit",
    "reasoningEffort",
    "includeActiveFile",
    "formatAfterEdit",
    "revealEditedFiles",
    "worktreeMode",
    "maxContextTokens",
    "autoBudgetCarryCostUsd",
    "compactionTargetRatio",
    "microcompactRatio",
    "maxTokens",
    "temperature",
    "enablePromptCaching",
    "defaultMode",
    "dataCollection",
    "zeroDataRetention",
    "providerSort",
    "quantizations",
    "autoApproveCommands",
    "alwaysDenyCommands",
    "baseUrl",
  ]);

  /** GUI fields edited as JSON text but stored as objects. */
  private static JSON_SETTINGS: Partial<Record<keyof SettingsPayload, string>> = {
    mcpServersJson: "mcpServers",
    customCommandsJson: "customCommands",
  };

  private async updateSetting(key: keyof SettingsPayload, value: unknown) {
    const jsonTarget = LunaCodeController.JSON_SETTINGS[key];
    if (jsonTarget) {
      try {
        const parsed = value ? JSON.parse(String(value)) : {};
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("expected a JSON object");
        }
        await vscode.workspace
          .getConfiguration("lunacode")
          .update(jsonTarget, parsed, vscode.ConfigurationTarget.Global);
      } catch (e: any) {
        this.post({
          type: "error",
          message: `"${jsonTarget}" not saved — invalid JSON: ${e?.message ?? e}`,
        });
      }
      this.sendSettings();
      return;
    }
    if (!LunaCodeController.WRITABLE_SETTINGS.has(key)) return;
    try {
      await vscode.workspace
        .getConfiguration("lunacode")
        .update(key, value, vscode.ConfigurationTarget.Global);
    } catch (e: any) {
      this.post({ type: "error", message: `Could not save setting "${key}": ${e?.message ?? e}` });
    }
    // Echo the (clamped, validated) effective config back so the GUI reflects
    // what will actually be used, and refresh the model chip.
    this.sendSettings();
    await this.sendConfig();
  }

  private sendSessionList() {
    const sessions = this.sessions
      .list()
      .map((m) => ({ id: m.id, title: m.title, updatedAt: m.updatedAt }));
    this.post({ type: "sessionList", sessions, currentId: this.currentSessionId });
  }

  private async loadSession(id: string) {
    if (this.running) {
      this.post({ type: "status", message: "Finish or cancel the current turn first." });
      return;
    }
    const s = this.sessions.get(id);
    if (!s) {
      this.post({ type: "error", message: "That session could not be found." });
      return;
    }
    this.currentSessionId = s.id;
    this.currentCreatedAt = s.createdAt;
    this.mode = s.mode;
    this.sessionMcpTools = null;
    // A resumed session starts from a cold provider cache regardless, so begin
    // at the full tool set — a later mid-session unlock would cost a full
    // cache miss at a much larger context.
    this.sessionToolPhase = s.messages.length > 0 ? "all" : "read";
    this.activeCheckpoint = null;

    // Rebuild the turn ledger from persisted anchors (with a legacy fallback),
    // then pair the freshly-assigned turn-start ids with their checkpoints.
    const stored = this.storedTurns(s);
    this.context.loadMessages(
      s.messages,
      stored.map((t) => t.startIndex)
    );
    const starts = this.context.getTurnStarts();
    this.turns = starts.map((st, i) => {
      const cp = stored[i]?.checkpoint;
      return { id: st.id, checkpoint: cp ? new Map(cp) : null, hadEdits: !!(cp && cp.length) };
    });

    this.postCheckpointState();
    this.post({ type: "taskList", tasks: [] });
    this.sessionApprovedKinds.clear();
    this.pendingSelections = [];
    this.queue = [];
    this.transcript = [];
    this.sessionUsage = s.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    };
    this.post({ type: "sessionReset" });
    await this.sendConfig();
    // Restore sticky memory from the persisted session, falling back to empty.
    this.stickyMemory = s.stickyMemory
      ? { ...emptyStickyMemory(), ...s.stickyMemory, decisions: s.stickyMemory.decisions ?? [], filesTouched: s.stickyMemory.filesTouched ?? [], openErrors: s.stickyMemory.openErrors ?? [], commands: s.stickyMemory.commands ?? {} }
      : emptyStickyMemory();
    // Rebuild the system prompt for the restored session's mode/root. (Sticky
    // memory needs no injection — the ephemeral-tail closure reads the live
    // field restored above.)
    try {
      const root = this.workspaceRoot();
      if (root) this.context.setSystemPrompt(await this.buildPromptForRoot(root));
    } catch {
      /* best-effort */
    }

    this.post({ type: "sessionUsage", usage: this.sessionUsage });
    const rewindIdByIndex = new Map(starts.map((st) => [st.index, st.id]));
    for (const ev of messagesToEvents(s.messages, rewindIdByIndex)) {
      this.post(ev);
    }
    this.postRewindState();
  }

  /** Turn ledger from a stored session, with a best-effort fallback for legacy
   * sessions that only persisted the old edit-turn `checkpoints` stack. */
  private storedTurns(
    s: StoredSession
  ): Array<{ startIndex: number; checkpoint?: Array<[string, string | null]> }> {
    if (s.turns && s.turns.length) return s.turns;
    const userIdx: number[] = [];
    s.messages.forEach((m, i) => {
      if (m.role === "user") userIdx.push(i);
    });
    const cps = s.checkpoints ?? [];
    // Attach the K legacy checkpoints (oldest→newest) to the LAST K user
    // messages, matching how the old stack retained the most-recent edit turns.
    const firstCp = Math.max(0, userIdx.length - cps.length);
    return userIdx.map((startIndex, j) => ({
      startIndex,
      checkpoint: j >= firstCp ? cps[j - firstCp] : undefined,
    }));
  }

  private async persistCurrent() {
    const msgs = this.context.getMessages();
    if (!msgs.some((m) => m.role === "user")) return; // nothing meaningful yet
    if (!this.currentSessionId) {
      this.currentSessionId = this.sessions.newId();
      this.currentCreatedAt = Date.now();
    }
    const now = Date.now();
    const session: StoredSession = {
      id: this.currentSessionId,
      title: deriveTitle(msgs),
      createdAt: this.currentCreatedAt || now,
      updatedAt: now,
      model: getConfig().model,
      mode: this.mode,
      messages: msgs,
      usage: this.sessionUsage,
      turns: this.serializeTurns(),
      stickyMemory: this.stickyMemory,
    };
    try {
      await this.sessions.save(session);
    } catch (e: any) {
      this.output.appendLine(`Failed to save session: ${e?.message ?? e}`);
    }
  }

  private async sendInit(source: vscode.Webview) {
    const cfg = getConfig();
    const key = await this.secrets.getApiKey();
    void source.postMessage({
      type: "init",
      hasApiKey: !!key,
      model: cfg.model,
      mode: this.mode,
      modes: Object.values(MODES).map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
      })),
      commands: this.commandList(),
      fallback: cfg.fallbackModels[0],
    } satisfies HostToWebview);
    // Replay history so a freshly-attached surface shows the conversation.
    for (const ev of this.transcript) {
      void source.postMessage(ev);
    }
    // rewindState isn't recorded (it churns each turn), so send the current set
    // directly to this surface for correct button enable/disable after replay.
    void source.postMessage({ type: "rewindState", points: this.rewindPoints() } satisfies HostToWebview);
    void this.maybePrewarm();
  }

  /** Index into workspaceFolders for multi-root workspaces. */
  private activeRootIndex = 0;

  private workspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    return (folders[this.activeRootIndex] ?? folders[0]).uri.fsPath;
  }

  /** Multi-root workspaces: pick which folder the agent works in. */
  async pickWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) {
      void vscode.window.showInformationMessage("Luna Code: this workspace has a single folder.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      folders.map((f, i) => ({
        label: f.name,
        description: f.uri.fsPath,
        index: i,
        picked: i === this.activeRootIndex,
      })),
      { title: "Luna Code: which folder should the agent work in?" }
    );
    if (!picked) return;
    this.activeRootIndex = picked.index;
    this.fileListCache = null; // @-mention list is per-root
    this.post({ type: "status", message: `Working folder: ${picked.label}` });
  }

  /** Fixed candidate locations always stamped for project-memory freshness —
   * statting these catches newly CREATED root memory files, not just edits. */
  private memoryStampPaths(root: string): string[] {
    return [
      path.join(os.homedir(), ".lunacode", "LUNA.md"),
      path.join(root, "LUNA.md"),
      path.join(root, "AGENTS.md"),
      path.join(root, "CLAUDE.md"),
      path.join(root, ".cursorrules"),
      path.join(root, ".cursor", "rules"),
    ];
  }

  private mtimeOf(p: string): number {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  }

  /**
   * Project memory with an mtime guard: while every known memory file is
   * unchanged, return the cached bytes (keeps the system prompt byte-stable
   * AND skips the sync directory walk). When the agent edits a LUNA.md the
   * stamp mismatch forces a rebuild — one intentional cache re-write, then
   * the new prefix is stable again. Newly created NESTED memory files are
   * only discovered on `refresh` (session start / compaction) — acceptable
   * staleness for cache stability.
   */
  private projectMemory(root: string, refresh: boolean): string | undefined {
    const cache = this.projectMemoryCache;
    if (
      !refresh &&
      cache &&
      cache.root === root &&
      cache.stamps.every((s) => this.mtimeOf(s.path) === s.mtimeMs)
    ) {
      return cache.result;
    }
    const collected: string[] = [];
    const result = this.readProjectMemory(root, collected);
    const stampPaths = [...new Set([...this.memoryStampPaths(root), ...collected])];
    this.projectMemoryCache = {
      root,
      stamps: stampPaths.map((p) => ({ path: p, mtimeMs: this.mtimeOf(p) })),
      result,
    };
    return result;
  }

  /** Project memory: LUNA.md at the workspace root plus nested LUNA.md files
   * in subdirectories (monorepo packages), capped so memory can't blow up the
   * (cached) system prompt. `collect` receives every file actually read so the
   * caller can mtime-stamp them for cache freshness. */
  private readProjectMemory(root: string, collect?: string[]): string | undefined {
    const sections: string[] = [];
    const clip = (text: string, max: number, label = "") =>
      text.length > max ? text.slice(0, max) + `\n…[${label || "truncated"}]` : text;

    // Global user rules apply across every project (personal conventions).
    try {
      const globalFile = path.join(os.homedir(), ".lunacode", "LUNA.md");
      if (fs.existsSync(globalFile)) {
        collect?.push(globalFile);
        const text = fs.readFileSync(globalFile, "utf8").trim();
        if (text) sections.push("### Global rules (~/.lunacode/LUNA.md)\n" + clip(text, 4000));
      }
    } catch {
      /* global rules are best-effort */
    }

    try {
      // Root project memory: LUNA.md, or a recognized equivalent from another
      // tool so users don't have to duplicate their rules.
      const ROOT_NAMES = ["LUNA.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"];
      const rootName = ROOT_NAMES.find((n) => fs.existsSync(path.join(root, n)));
      if (rootName) {
        collect?.push(path.join(root, rootName));
        const text = fs.readFileSync(path.join(root, rootName), "utf8").trim();
        if (text) {
          const body = clip(text, 6000, `${rootName} truncated`);
          sections.push(rootName === "LUNA.md" ? body : `### ${rootName}\n${body}`);
        }
      }
      // Cursor-style rule files under .cursor/rules/*.md
      try {
        const rulesDir = path.join(root, ".cursor", "rules");
        const files = fs
          .readdirSync(rulesDir)
          .filter((f) => f.endsWith(".md") || f.endsWith(".mdc"))
          .sort()
          .slice(0, 4);
        for (const f of files) {
          collect?.push(path.join(rulesDir, f));
          const text = fs.readFileSync(path.join(rulesDir, f), "utf8").trim();
          if (text) sections.push(`### .cursor/rules/${f}\n` + clip(text, 1500));
        }
      } catch {
        /* no cursor rules */
      }
      // Nested memory files (depth-limited walk, ignored dirs skipped).
      const nested: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || nested.length >= 4) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (nested.length >= 4) return;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".")) walk(abs, depth + 1);
          } else if (e.name === "LUNA.md" && abs !== path.join(root, "LUNA.md")) {
            nested.push(abs);
          }
        }
      };
      walk(root, 0);
      for (const abs of nested) {
        try {
          collect?.push(abs);
          const text = fs.readFileSync(abs, "utf8").trim();
          if (!text) continue;
          const rel = abs.slice(root.length + 1);
          const MAX = 1500;
          sections.push(
            `### ${rel}\n` + (text.length > MAX ? text.slice(0, MAX) + "\n…[truncated]" : text)
          );
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* memory is best-effort */
    }
    return sections.length ? sections.join("\n\n") : undefined;
  }

  private workspaceOverview(root: string): string {
    try {
      const entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
        .slice(0, 60)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return entries.join("  ");
    } catch {
      return "";
    }
  }

  private async onSend(text: string, images?: string[]) {
    const trimmed = text.trim();
    if (!trimmed && !images?.length) return;

    const apiKey = await this.secrets.getApiKey();
    if (!apiKey) {
      this.post({ type: "error", message: "No OpenRouter API key set. Click the key icon to add one." });
      return;
    }
    if (!this.workspaceRoot()) {
      this.post({ type: "error", message: "Open a folder/workspace to use Luna Code." });
      return;
    }

    // Slash commands: /name expands to its template (with argument interpolation).
    let userText = this.expandSlash(trimmed);

    // Fold any queued editor selections into this message now.
    if (this.pendingSelections.length) {
      userText = this.pendingSelections.join("\n\n") + "\n\n" + userText;
      this.pendingSelections = [];
    }

    // Active-editor context: tell the agent what the user is looking at.
    const editorNote = this.activeEditorNote();
    if (editorNote) userText += `\n\n${editorNote}`;

    // Echo immediately. If a turn is already active, this becomes steering for
    // the running task (drained by the agent) or the next queued turn.
    const echoId = this.echoSeq++;
    this.post({
      type: "userEcho",
      text: trimmed + (images?.length ? `\n\n🖼 ${images.length} image(s) attached` : ""),
      queued: this.running,
      echoId,
    });
    this.queue.push({ text: userText, images, echoId });
    void this.pump();
  }

  /** Editor-context note appended to each message (lunacode.includeActiveFile). */
  private activeEditorNote(): string | null {
    if (!getConfig().includeActiveFile) return null;
    const root = this.workspaceRoot();
    if (!root) return null;
    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") editor = this.lastEditor;
    if (!editor || editor.document.isClosed || editor.document.uri.scheme !== "file") {
      return null;
    }
    const abs = editor.document.uri.fsPath;
    if (!abs.startsWith(root + path.sep)) return null;
    const rel = abs.slice(root.length + 1);
    const sel = editor.selection;
    if (sel && !sel.isEmpty) {
      const selText = editor.document.getText(sel).slice(0, 2000);
      return `[Editor context: the user has ${rel} open with lines ${sel.start.line + 1}-${sel.end.line + 1} selected:]\n\`\`\`\n${selText}\n\`\`\``;
    }
    return `[Editor context: the user is currently viewing ${rel}]`;
  }

  /** Run queued turns one at a time, FIFO, until the queue drains. */
  private async pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.running = true;
    try {
      await this.runTurn(next.text, next.images, next.echoId);
    } finally {
      this.running = false;
      await this.persistCurrent();
      if (this.queue.length) void this.pump();
    }
  }

  private async runTurn(userText: string, images?: string[], echoId?: number) {
    const cfg = getConfig();
    const apiKey = await this.secrets.getApiKey();
    let root = this.workspaceRoot();
    if (!apiKey || !root) return; // validated at enqueue; bail defensively
    if (cfg.worktreeMode) root = await this.ensureSandbox(root);

    this.context.setCaching(cfg.enablePromptCaching);
    const applyPrompt = async (opts?: { refreshVolatile?: boolean }) => {
      this.context.setSystemPrompt(await this.buildPromptForRoot(root!, opts));
    };

    this.activeModel = cfg.model;
    const client = new OpenRouterClient({
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dataCollection: cfg.dataCollection,
      zdr: cfg.zeroDataRetention,
      providerSort: cfg.providerSort,
      quantizations: cfg.quantizations,
      reasoningEffort: cfg.reasoningEffort === "default" ? undefined : cfg.reasoningEffort,
    });

    // Prompt build and budget calc are independent — overlap them (the budget
    // may hit /models on a cold cache).
    const [, maxContextTokens] = await Promise.all([
      applyPrompt(),
      this.effectiveContextBudget(cfg, client),
    ]);

    this.agent = new Agent(
      {
        client,
        context: this.context,
        output: this.output,
        workspaceRoot: root,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        maxContextTokens,
        summarizerModel: cfg.summarizerModel || cfg.model,
        compactionTargetRatio: cfg.compactionTargetRatio,
        microcompactRatio: cfg.microcompactRatio,
        subagentModel: cfg.subagentModel,
        plannerModel: cfg.plannerModel || cfg.subagentModel,
        implementerModel: cfg.implementerModel,
        subagentMaxContextTokens: cfg.subagentMaxContextTokens,
        progressiveTools: cfg.progressiveTools,
        initialToolPhase: this.sessionToolPhase,
        onToolPhaseChange: (phase) => {
          this.sessionToolPhase = phase;
        },
        adaptiveReasoning: cfg.adaptiveReasoning,
        reasoningEffort:
          cfg.reasoningEffort === "default" ? undefined : cfg.reasoningEffort,
        maxTurns: cfg.maxTurns,
        loopGuardLimit: cfg.loopGuardLimit,
        snapshotFile: (relPath) => this.snapshotFile(root, relPath),
        extraTools: (this.sessionMcpTools ??= this.mcp.getTools()),
        // Mid-turn steering: the agent drains queued messages each iteration.
        takeSteering: () => this.queue.splice(0, this.queue.length),
        formatAfterEdit: cfg.formatAfterEdit,
        stickyMemory: this.stickyMemory,
        // Called at compaction — a planned cache miss — so refreshing the
        // volatile prompt inputs (repo map, project memory) there is free.
        refreshSystemPrompt: () => applyPrompt({ refreshVolatile: true }),
        checkBudget: () => {
          const limit = getConfig().sessionBudgetUsd;
          return limit > 0 && this.sessionUsage.cost >= limit
            ? { spent: this.sessionUsage.cost, limit }
            : null;
        },
      },
      {
        onEvent: (e) => this.forwardEvent(e),
        requestApproval: (req) => this.askApproval(req),
        askUser: (req) => this.askUser(req),
      }
    );

    this.activeCheckpoint = new Map();
    // The turn-initiating addUser (agent.ts) is the next context mutation, so it
    // will receive exactly this id — deterministic and compaction-proof.
    const turnStartId = this.context.peekIdSeq();
    const entry: (typeof this.turns)[number] = {
      id: turnStartId,
      checkpoint: this.activeCheckpoint,
      hadEdits: false,
    };
    this.turns.push(entry);
    try {
      await this.agent.run(userText, this.mode, images);
    } finally {
      if (this.context.indexOfId(turnStartId) < 0) {
        // The turn never registered its user message (e.g. an early error).
        const i = this.turns.indexOf(entry);
        if (i >= 0) this.turns.splice(i, 1);
      } else {
        entry.hadEdits = !!(this.activeCheckpoint && this.activeCheckpoint.size > 0);
        if (!entry.hadEdits) entry.checkpoint = null;
        this.attachRewind(echoId, turnStartId);
      }
      this.activeCheckpoint = null;
      this.trimCheckpointHorizon();
      this.postCheckpointState();
      this.postRewindState();
    }
  }

  /** After a turn starts, tie its bubble to its rewind id: reflect the id onto
   * the recorded userEcho (so re-attaching surfaces tag it) and tell live
   * surfaces to show the button now. */
  private attachRewind(echoId: number | undefined, rewindId: number) {
    if (echoId === undefined) return;
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const m = this.transcript[i];
      if (m.type === "userEcho" && m.echoId === echoId) {
        m.rewindId = rewindId;
        break;
      }
    }
    this.post({ type: "rewindAssign", echoId, rewindId });
  }

  /** id of the most recent turn (for the menu's Retry/Edit shortcuts), or -1. */
  private lastTurnId(): number {
    return this.turns[this.turns.length - 1]?.id ?? -1;
  }

  /** Switch to a (fallback) model, then rewind + re-run the last turn. */
  private async retryWithModel(model: string) {
    if (model) {
      await vscode.workspace
        .getConfiguration("lunacode")
        .update("model", model, vscode.ConfigurationTarget.Global);
      await this.sendConfig();
      this.post({ type: "status", message: `Switched to ${model} — retrying the last message…` });
    }
    await this.rewindTo(this.lastTurnId(), "rerun");
  }

  /** Create a starter LUNA.md (project memory) if absent, then open it. */
  private async createMemory() {
    const root = this.workspaceRoot();
    if (!root) {
      this.post({ type: "status", message: "Open a folder to create project memory." });
      return;
    }
    const abs = path.join(root, "LUNA.md");
    try {
      if (!fs.existsSync(abs)) {
        const starter = `# Project memory (LUNA.md)

Luna Code reads this file every turn. Keep it terse. Good things to record:

## Commands
- Build:
- Test:
- Lint/format:

## Conventions
- (code style, patterns, naming)

## Architecture
- (key modules and how they fit)

## Gotchas
- (footguns, non-obvious setup)
`;
        fs.writeFileSync(abs, starter, "utf8");
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc);
      this.post({
        type: "status",
        message: "LUNA.md opened — jot down build/test commands, conventions, and gotchas.",
      });
    } catch (e: any) {
      this.post({ type: "error", message: `Couldn't create LUNA.md: ${e?.message ?? e}` });
    }
  }

  /** Most recent turn that still holds a file checkpoint (for review/commit). */
  private topCheckpoint(): Map<string, string | null> | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const cp = this.turns[i].checkpoint;
      if (cp) return cp;
    }
    return undefined;
  }

  /** Keep only the MAX_CHECKPOINT_TURNS most-recent edit-turns' file payloads;
   * older turns keep their ledger entry (still context-rewindable) but drop the
   * checkpoint to free memory. */
  private trimCheckpointHorizon() {
    let editTurns = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (!this.turns[i].checkpoint) continue;
      editTurns++;
      if (editTurns > LunaCodeController.MAX_CHECKPOINT_TURNS) {
        this.turns[i].checkpoint = null;
      }
    }
  }

  /** Rewindable turn-start points (id + restorable file count). Turns compacted
   * out of the live context are omitted so their buttons hide. */
  private rewindPoints(): { id: number; files: number }[] {
    const points: { id: number; files: number }[] = [];
    for (let k = 0; k < this.turns.length; k++) {
      if (this.context.indexOfId(this.turns[k].id) < 0) continue;
      points.push({ id: this.turns[k].id, files: collapseRestoreSet(this.turns, k).size });
    }
    return points;
  }

  private postRewindState() {
    this.post({ type: "rewindState", points: this.rewindPoints() });
  }

  /** Answer a rewindPreview request with the confirm-dialog details. */
  private buildRewindPreview(id: number) {
    const idx = this.context.indexOfId(id);
    if (idx < 0) {
      this.post({ type: "status", message: "That point was compacted and can no longer be rewound." });
      return;
    }
    const k = this.turns.findIndex((t) => t.id === id);
    const restore = k >= 0 ? collapseRestoreSet(this.turns, k) : new Map<string, string | null>();
    let filesRestored = 0;
    let filesDeleted = 0;
    for (const before of restore.values()) before === null ? filesDeleted++ : filesRestored++;
    // Any discarded turn that made edits but no longer has a checkpoint was
    // trimmed beyond the horizon — its files can't be restored.
    let horizonExceeded = false;
    if (k >= 0) {
      for (let t = k; t < this.turns.length; t++) {
        if (this.turns[t].hadEdits && !this.turns[t].checkpoint) horizonExceeded = true;
      }
    }
    const messages = this.context.getMessages();
    const text = extractText(messages[idx]?.content ?? "");
    this.post({
      type: "rewindPreview",
      id,
      messagesDiscarded: messages.length - idx,
      filesRestored,
      filesDeleted,
      horizonExceeded,
      text,
    });
  }

  /** Unified rewind: restore files to their state before turn `id`, truncate the
   * model context and transcript to that point, then either re-run the message
   * (resend) or drop it into the composer to edit. */
  private async rewindTo(id: number, mode: "rollback" | "edit" | "rerun") {
    if (this.running) {
      this.post({ type: "status", message: "Can't rewind while a turn is running — stop it first." });
      return;
    }
    const idx = this.context.indexOfId(id);
    if (idx < 0) {
      this.post({ type: "status", message: "That point was compacted and can no longer be rewound." });
      return;
    }
    const k = this.turns.findIndex((t) => t.id === id);
    // Restore files (earliest before-state across the discarded turns).
    const restore = k >= 0 ? collapseRestoreSet(this.turns, k) : new Map<string, string | null>();
    let restored = 0;
    let deleted = 0;
    let failed = 0;
    for (const [abs, before] of restore) {
      try {
        if (before === null) {
          fs.rmSync(abs, { force: true });
          deleted++;
        } else {
          fs.writeFileSync(abs, before, "utf8");
          restored++;
        }
      } catch {
        failed++;
      }
    }
    // Truncate context + ledger + queue.
    const rolled = this.context.rollbackToIndex(idx);
    if (k >= 0) this.turns.splice(k);
    this.queue = [];
    // Trim the replay transcript from the target bubble onward.
    const cut = this.transcript.findIndex((m) => m.type === "userEcho" && m.rewindId === id);
    if (cut >= 0) this.transcript.splice(cut);
    this.post({ type: "rewound", id });
    const bits: string[] = [];
    if (restored) bits.push(`${restored} file(s) restored`);
    if (deleted) bits.push(`${deleted} created file(s) removed`);
    if (failed) bits.push(`${failed} failed`);
    this.post({
      type: "status",
      message: `⟲ Rewound — ${bits.join(", ") || "no file changes"}. (Command side effects are not undone.)`,
    });
    this.postCheckpointState();
    this.postRewindState();
    if (mode === "rerun" && rolled && rolled.text) {
      // Re-queue DIRECTLY (the rolled text already carries slash expansion,
      // selections, and the editor note). Fresh echoId → a new rewind button.
      const echoId = this.echoSeq++;
      this.post({ type: "userEcho", text: rolled.text, queued: false, echoId });
      this.queue.push({
        text: rolled.text,
        images: rolled.images.length ? rolled.images : undefined,
        echoId,
      });
      void this.pump();
    } else if (mode === "edit" && rolled) {
      this.post({ type: "composerFill", text: rolled.text });
    }
    // mode === "rollback": files restored + context/transcript trimmed; stop here.
    await this.persistCurrent();
  }

  // --- turn checkpoints (revert support) ---

  /** Record a file's before-state the first time it is touched this turn. */
  private async snapshotFile(root: string, relPath: string) {
    if (!this.activeCheckpoint) return;
    let abs: string;
    try {
      abs = resolveInWorkspace(root, relPath);
    } catch {
      return; // outside the workspace — the tool will refuse anyway
    }
    if (this.activeCheckpoint.has(abs)) return; // keep the EARLIEST state
    try {
      const stat = fs.statSync(abs);
      if (stat.size > LunaCodeController.MAX_CHECKPOINT_FILE_BYTES) return; // too big to snapshot
      this.activeCheckpoint.set(abs, fs.readFileSync(abs, "utf8"));
    } catch {
      this.activeCheckpoint.set(abs, null); // file doesn't exist yet
    }
  }

  /** Serialize the turn ledger for persistence with size caps (Memento-friendly).
   * Each entry anchors to its turn-start message index so rewind survives a
   * reload; no-edit turns persist as an anchor with no checkpoint. */
  private serializeTurns(): Array<{ startIndex: number; checkpoint?: Array<[string, string | null]> }> {
    const out: Array<{ startIndex: number; checkpoint?: Array<[string, string | null]> }> = [];
    let total = 0;
    for (const t of this.turns) {
      const startIndex = this.context.indexOfId(t.id);
      if (startIndex < 0) continue; // compacted away — not rewindable
      let checkpoint: Array<[string, string | null]> | undefined;
      if (t.checkpoint) {
        const entries: Array<[string, string | null]> = [];
        for (const [p, v] of t.checkpoint) {
          const size = v?.length ?? 0;
          if (size > 256 * 1024) continue;
          if (total + size > 1_000_000) break;
          total += size;
          entries.push([p, v]);
        }
        if (entries.length) checkpoint = entries;
      }
      out.push({ startIndex, checkpoint });
    }
    return out;
  }

  private postCheckpointState() {
    const top = this.topCheckpoint();
    this.post({
      type: "checkpointState",
      turns: this.turns.filter((t) => t.checkpoint).length,
      files: top ? top.size : 0,
    });
  }

  /** Side-by-side diffs of the last turn's edits (checkpoint vs disk). */
  private sendTurnDiff() {
    const checkpoint = this.topCheckpoint();
    const root = this.workspaceRoot();
    if (!checkpoint || !root) {
      this.post({ type: "status", message: "No turn edits to review." });
      return;
    }
    const diffs: import("./protocol").DiffData[] = [];
    for (const [abs, before] of checkpoint) {
      let after: string | null = null;
      try {
        after = fs.readFileSync(abs, "utf8");
      } catch {
        after = null; // deleted since
      }
      if ((before ?? "") === (after ?? "")) continue; // fully reverted — nothing to show
      const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : abs;
      diffs.push(computeDiff(before ?? "", after ?? "", rel));
    }
    this.post({ type: "turnDiff", diffs });
  }

  private reviewAbs(rel: string): string | undefined {
    const root = this.workspaceRoot();
    if (!root) return undefined;
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
  }

  /** Revert one reviewed file to its pre-turn state (from the top checkpoint). */
  private revertReviewedFile(rel: string) {
    if (this.running) {
      this.post({ type: "status", message: "Finish the current turn before reverting." });
      return;
    }
    const abs = this.reviewAbs(rel);
    const before = abs ? this.topCheckpoint()?.get(abs) : undefined;
    if (!abs || before === undefined) {
      this.post({ type: "status", message: `No recorded pre-turn state for ${rel}.` });
      return;
    }
    try {
      if (before === null) {
        fs.rmSync(abs, { force: true });
        this.post({ type: "status", message: `↩ Removed ${rel} (it was created this turn).` });
      } else {
        fs.writeFileSync(abs, before, "utf8");
        this.post({ type: "status", message: `↩ Reverted ${rel} to its pre-turn state.` });
      }
    } catch (e: any) {
      this.post({ type: "error", message: `Revert failed: ${e?.message ?? e}` });
      return;
    }
    this.sendTurnDiff();
  }

  /** Revert only the selected change blocks of a reviewed file. */
  private revertReviewedHunks(rel: string, hunks: number[]) {
    if (this.running) {
      this.post({ type: "status", message: "Finish the current turn before reverting." });
      return;
    }
    const abs = this.reviewAbs(rel);
    const before = abs ? this.topCheckpoint()?.get(abs) : undefined;
    if (!abs || before === undefined) {
      this.post({ type: "status", message: `No recorded pre-turn state for ${rel}.` });
      return;
    }
    let after = "";
    try {
      after = fs.readFileSync(abs, "utf8");
    } catch {
      after = "";
    }
    const result = reconstructWithReverts(before ?? "", after, new Set(hunks));
    try {
      fs.writeFileSync(abs, result, "utf8");
    } catch (e: any) {
      this.post({ type: "error", message: `Revert failed: ${e?.message ?? e}` });
      return;
    }
    this.post({ type: "status", message: `↩ Reverted ${hunks.length} hunk(s) in ${rel}.` });
    this.sendTurnDiff();
  }

  /** Open a native editor diff (pre-turn ↔ current) for a reviewed file. */
  private async openReviewedDiff(rel: string) {
    const abs = this.reviewAbs(rel);
    if (!abs) return;
    const before = this.topCheckpoint()?.get(abs) ?? "";
    try {
      const tmp = path.join(os.tmpdir(), `lunacode-before-${Date.now()}-${path.basename(rel)}`);
      fs.writeFileSync(tmp, before, "utf8");
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(tmp),
        vscode.Uri.file(abs),
        `${rel} — before ↔ now`
      );
    } catch (e: any) {
      this.post({ type: "error", message: `Couldn't open diff: ${e?.message ?? e}` });
    }
  }

  /** Stage + commit the last turn's edited files with a generated message. */
  private async commitLastTurn() {
    const checkpoint = this.topCheckpoint();
    const root = this.workspaceRoot();
    if (!checkpoint || !root) {
      this.post({ type: "status", message: "No turn edits to commit." });
      return;
    }
    const files = [...checkpoint.keys()].map((abs) =>
      abs.startsWith(root) ? abs.slice(root.length + 1) : abs
    );
    // Generate a commit message with the (cheap) summarizer model.
    const cfg = getConfig();
    const apiKey = await this.secrets.getApiKey();
    let message = `lunacode: update ${files.length} file(s)`;
    if (apiKey) {
      const client = new OpenRouterClient({
        apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.summarizerModel || cfg.model,
        dataCollection: cfg.dataCollection,
        zdr: cfg.zeroDataRetention,
        providerSort: cfg.providerSort,
      });
      const recent = this.context
        .getMessages()
        .filter((m) => m.role === "user")
        .slice(-2)
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      const { text } = await client.complete({
        messages: [
          {
            role: "system",
            content:
              "Write a single-line conventional commit message (max 72 chars) for the described change. Respond with ONLY the message, no quotes.",
          },
          { role: "user", content: `Files changed: ${files.join(", ")}\nTask: ${recent.slice(0, 1500)}` },
        ],
        maxTokens: 60,
        temperature: 0,
      });
      const line = text.trim().split("\n")[0]?.trim();
      if (line) message = line.slice(0, 120);
    }
    // Stage exactly the turn's files and commit.
    try {
      await execGit(root, ["add", "--", ...files]);
      await execGit(root, ["commit", "-m", message]);
      this.post({ type: "status", message: `✓ Committed ${files.length} file(s): "${message}"` });
    } catch (e: any) {
      this.post({ type: "error", message: `Commit failed: ${e?.message ?? e}` });
    }
  }

  /** What's in the context window right now — powers the context inspector. */
  private async sendContextInfo() {
    const cfg = getConfig();
    const root = this.workspaceRoot();
    // Ensure the system prompt matches what the next turn would send so the
    // breakdown's systemTokens line is accurate.
    if (root) {
      this.context.setSystemPrompt(await this.buildPromptForRoot(root));
    }
    const bd = this.context.breakdown();
    const budget = await this.effectiveContextBudget(cfg);
    const price = this.lookupModelMeta(cfg.model)?.promptPrice;
    this.post({
      type: "contextInfo",
      info: {
        totalTokens: bd.totalTokens,
        budget,
        systemTokens: bd.systemTokens,
        messageCount: bd.messageCount,
        hasMemory: !!(root && this.projectMemory(root, false)),
        nextCallCostUsd: price ? bd.totalTokens * price * 0.1 : undefined,
        largest: bd.largest,
        byRole: bd.byRole,
        stubbedToolResults: bd.stubbedToolResults,
      },
    });
  }

  /** Fuzzy file matches for @-mention completion (cached workspace walk). */
  /** @-mention completions: special context providers, workspace symbols,
   * folders, and files. */
  private async queryMentions(query: string, token: number, source: vscode.Webview) {
    const items: MentionItem[] = [];
    const q = query.toLowerCase();
    const root = this.workspaceRoot() ?? "";
    const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);

    // Special context providers (surface on empty/short query or keyword match).
    const specials: Array<{ kind: "problems" | "git"; label: string; detail: string; key: string }> = [
      { kind: "problems", label: "problems", detail: "attach current diagnostics", key: "problems diagnostics errors" },
      { kind: "git", label: "git", detail: "attach the working-tree diff", key: "git diff changes" },
    ];
    for (const s of specials) {
      if (!q || s.label.startsWith(q) || s.key.includes(q)) {
        items.push({ kind: s.kind, label: s.label, detail: s.detail });
      }
    }

    // Workspace symbols (needs a couple of chars).
    if (query.length >= 2) {
      try {
        const syms =
          (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            "vscode.executeWorkspaceSymbolProvider",
            query
          )) ?? [];
        for (const s of syms.slice(0, 6)) {
          const loc = `${rel(s.location.uri.fsPath)}:${s.location.range.start.line + 1}`;
          items.push({ kind: "symbol", label: s.name, insert: loc, detail: loc });
        }
      } catch {
        /* no symbol provider */
      }
    }

    // Files + folders (cached workspace walk).
    const now = Date.now();
    if (!this.fileListCache || now - this.fileListCache.at > 30_000) {
      const uris = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 5000);
      this.fileListCache = { at: now, files: uris.map((u) => rel(u.fsPath)).sort() };
    }
    const score = (lower: string): number => {
      if (!q) return 0;
      if (lower.includes(q)) return 100 - lower.indexOf(q) - (lower.length - q.length) * 0.01;
      if (isSubsequence(q, lower)) return 10 - lower.length * 0.01;
      return -1;
    };
    const folders = new Set<string>();
    for (const f of this.fileListCache.files) {
      const parts = f.split("/");
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? acc + "/" + parts[i] : parts[i];
        folders.add(acc);
      }
    }
    const rank = (list: string[]) =>
      list
        .map((f) => ({ f, s: score(f.toLowerCase()) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s);
    for (const { f } of rank([...folders]).slice(0, 4)) {
      items.push({ kind: "folder", label: f + "/", insert: f });
    }
    for (const { f } of rank(this.fileListCache.files).slice(0, 10)) {
      items.push({ kind: "file", label: f, insert: f });
    }

    void source.postMessage({ type: "mentionMatches", token, items } satisfies HostToWebview);
  }

  /** Resolve a host-side mention into attached context (folded into the next
   * message like an editor selection). @terminal is intentionally omitted —
   * stable VS Code APIs don't expose terminal buffer contents. */
  private async resolveMention(kind: string, _arg?: string) {
    const root = this.workspaceRoot();
    if (kind === "problems") {
      const lines: string[] = [];
      let count = 0;
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        if (!diags.length) continue;
        const r = root && uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
        for (const d of diags) {
          if (count >= 50) break;
          const sev = ["Error", "Warning", "Info", "Hint"][d.severity] ?? "Info";
          lines.push(`${r}:${d.range.start.line + 1} [${sev}] ${d.message.split("\n")[0]}`);
          count++;
        }
      }
      if (!count) {
        this.post({ type: "status", message: "No diagnostics to attach." });
        return;
      }
      this.pendingSelections.push(`Current diagnostics (${count}):\n${lines.join("\n")}`);
      this.post({ type: "status", message: `Attached ${count} diagnostic(s) — type what to do, then send.` });
      return;
    }
    if (kind === "git") {
      if (!root) {
        this.post({ type: "status", message: "Open a folder to attach a git diff." });
        return;
      }
      try {
        const staged = await execGit(root, ["diff", "--cached"]).catch(() => "");
        const unstaged = await execGit(root, ["diff"]).catch(() => "");
        let diff = [staged && `# staged\n${staged}`, unstaged && `# unstaged\n${unstaged}`]
          .filter(Boolean)
          .join("\n\n");
        if (!diff.trim()) {
          this.post({ type: "status", message: "Working tree is clean — nothing to attach." });
          return;
        }
        const MAX = 12000;
        if (diff.length > MAX) diff = diff.slice(0, MAX) + "\n…[diff truncated]";
        this.pendingSelections.push("Current git diff:\n```diff\n" + diff + "\n```");
        this.post({ type: "status", message: "Attached the working-tree diff — type what to do, then send." });
      } catch (e: any) {
        this.post({ type: "error", message: `git diff failed: ${e?.message ?? e}` });
      }
    }
  }

  // --- worktree sandbox (lunacode.worktreeMode) ---

  /** Create (or reuse) the sandbox worktree; falls back to the real root when
   * the workspace isn't a git repo. */
  private async ensureSandbox(realRoot: string): Promise<string> {
    if (this.sandbox) return this.sandbox.dir;
    try {
      await execGit(realRoot, ["rev-parse", "--is-inside-work-tree"]);
      const ts = Date.now().toString(36);
      const branch = `luna/sandbox-${ts}`;
      const dir = path.join(os.tmpdir(), `lunacode-sandbox-${ts}`);
      await execGit(realRoot, ["worktree", "add", "-b", branch, dir]);
      // Best-effort: link dependency dirs so builds/tests work in the sandbox.
      for (const dep of ["node_modules", ".venv", "vendor"]) {
        const src = path.join(realRoot, dep);
        const dest = path.join(dir, dep);
        try {
          if (fs.existsSync(src) && !fs.existsSync(dest)) {
            fs.symlinkSync(src, dest, os.platform() === "win32" ? "junction" : "dir");
          }
        } catch {
          /* linking is a convenience only */
        }
      }
      this.sandbox = { dir, branch };
      this.post({
        type: "status",
        message: `🏝 Sandbox mode: the agent works in a separate git worktree (branch ${branch}). Use "Luna Code: Merge Sandbox Changes" to apply, "Discard Sandbox" to throw away. Note: dependencies aren't installed there.`,
      });
      return dir;
    } catch (e: any) {
      this.post({
        type: "status",
        message: `Sandbox unavailable (${e?.message ?? e}) — working in your real tree.`,
      });
      return realRoot;
    }
  }

  async mergeSandbox() {
    const real = this.workspaceRoot();
    if (!this.sandbox || !real) {
      this.post({ type: "status", message: "No sandbox is active." });
      return;
    }
    const { dir } = this.sandbox;
    try {
      // Stage everything (captures new files too), take the patch, unstage.
      await execGit(dir, ["add", "-A"]);
      const patch = await execGit(dir, ["diff", "--cached", "--binary"]);
      await execGit(dir, ["reset"]).catch(() => {});
      if (!patch.trim()) {
        this.post({ type: "status", message: "Sandbox has no changes to merge." });
        return;
      }
      const patchFile = path.join(os.tmpdir(), `lunacode-sandbox-${Date.now()}.patch`);
      fs.writeFileSync(patchFile, patch, "utf8");
      try {
        await execGit(real, ["apply", "--binary", "--3way", patchFile]);
      } finally {
        fs.rmSync(patchFile, { force: true });
      }
      this.post({
        type: "status",
        message: `✓ Sandbox changes applied to your working tree. Run "Luna Code: Discard Sandbox" when you're done with it.`,
      });
    } catch (e: any) {
      this.post({ type: "error", message: `Sandbox merge failed: ${e?.message ?? e}` });
    }
  }

  async discardSandbox() {
    const real = this.workspaceRoot();
    if (!this.sandbox || !real) {
      this.post({ type: "status", message: "No sandbox is active." });
      return;
    }
    const { dir, branch } = this.sandbox;
    await execGit(real, ["worktree", "remove", "--force", dir]).catch(() => {});
    await execGit(real, ["branch", "-D", branch]).catch(() => {});
    this.sandbox = undefined;
    this.post({ type: "status", message: "Sandbox discarded." });
  }

  /** Editor commands (fix/refactor/explain) route their prompt through here. */
  async sendExternal(text: string) {
    await vscode.commands.executeCommand("lunacode.openChat");
    await this.onSend(text);
  }

  /** Export the current conversation as a Markdown document. */
  async exportSession() {
    const msgs = this.context.getMessages();
    if (!msgs.length) {
      void vscode.window.showInformationMessage("Luna Code: nothing to export yet.");
      return;
    }
    const lines: string[] = ["# Luna Code session", ""];
    for (const m of msgs) {
      if (m.role === "user") {
        lines.push("## 🧑 You", "", extractText(m.content), "");
      } else if (m.role === "assistant") {
        const text = m.content === null ? "" : extractText(m.content);
        if (text) lines.push("## 🌙 Luna", "", text, "");
        if ("tool_calls" in m && m.tool_calls) {
          for (const tc of m.tool_calls) {
            lines.push(`- 🔧 \`${tc.function.name}\` ${tc.function.arguments.slice(0, 120)}`);
          }
          lines.push("");
        }
      }
    }
    const doc = await vscode.workspace.openTextDocument({
      content: lines.join("\n"),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc);
  }

  /** Available slash commands (builtins + custom), for composer autocomplete. */
  private commandList(): string[] {
    const custom = Object.keys(getConfig().customCommands);
    const project = Object.keys(this.projectCommands());
    return [...new Set([...Object.keys(SLASH_COMMANDS), ...project, ...custom])];
  }

  /** Project-scoped slash commands from .luna/commands/*.md (filename → template). */
  private projectCommands(): Record<string, string> {
    const root = this.workspaceRoot();
    if (!root) return {};
    const out: Record<string, string> = {};
    try {
      const dir = path.join(root, ".luna", "commands");
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const name = f.slice(0, -3);
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
        try {
          const text = fs.readFileSync(path.join(dir, f), "utf8").trim();
          if (text) out[name] = text;
        } catch {
          /* skip unreadable command */
        }
      }
    } catch {
      /* no project commands dir */
    }
    return out;
  }

  /** Resolve `/name args` into its template, interpolating $ARGUMENTS and $1..$9.
   * Precedence: user customCommands > project commands > built-ins. Unknown
   * commands are sent through unchanged. */
  private expandSlash(trimmed: string): string {
    const slash = /^\/([a-zA-Z0-9_-]+)\b\s*([\s\S]*)$/.exec(trimmed);
    if (!slash) return trimmed;
    const name = slash[1];
    const args = slash[2] ?? "";
    const template =
      getConfig().customCommands[name] ?? this.projectCommands()[name] ?? SLASH_COMMANDS[name];
    if (template === undefined) return trimmed;
    if (/\$(ARGUMENTS|[1-9])/.test(template)) {
      const positional = args.split(/\s+/).filter(Boolean);
      return template
        .replace(/\$ARGUMENTS/g, args)
        .replace(/\$([1-9])/g, (_m, d) => positional[Number(d) - 1] ?? "");
    }
    return template + (args ? `\n\n${args}` : "");
  }

  /** Pre-warm the provider prompt cache so the first real message of a session
   * starts from a warm cache. Mirrors the first turn's exact prefix (system
   * prompt + tools); gated behind lunacode.prewarmCache. */
  private async maybePrewarm() {
    const cfg = getConfig();
    if (!cfg.prewarmCache || !cfg.enablePromptCaching) return;
    const root = this.workspaceRoot();
    const apiKey = await this.secrets.getApiKey();
    if (!root || !apiKey) return;
    if (this.context.getMessages().length > 0) return; // session already live
    const key = `${cfg.model}|${this.mode}|${root}`;
    if (this.prewarmed === key) return;
    this.prewarmed = key;
    const tmp = new ContextManager(true);
    tmp.setSystemPrompt(await this.buildPromptForRoot(root));
    tmp.addUser("Reply with exactly: ok");
    const client = new OpenRouterClient({
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dataCollection: cfg.dataCollection,
      zdr: cfg.zeroDataRetention,
      providerSort: cfg.providerSort,
      quantizations: cfg.quantizations,
      reasoningEffort: cfg.reasoningEffort === "default" ? undefined : cfg.reasoningEffort,
    });
    const allowsMutation = MODES[this.mode].allowsMutation;
    // Mirror the first real call's tool set exactly — with progressive tools
    // on, that's the read/meta phase; prewarming the full set would never match.
    const progressive =
      cfg.progressiveTools && allowsMutation && this.mode !== "plan";
    const phase = progressive ? this.sessionToolPhase : "all";
    const tools = [
      ...toolsForPhase(!allowsMutation, phase),
      ...(this.sessionMcpTools ??= this.mcp.getTools()).filter(
        (t) => allowsMutation || !t.mutating
      ),
    ];
    void client
      .complete({ messages: tmp.render(), tools: toToolDefinitions(tools), maxTokens: 1 })
      .then(({ error }) => {
        if (!error) this.output.appendLine("[lunacode] prompt cache pre-warmed");
      });
  }

  /**
   * Context-budget trigger for compaction. Manual setting wins; otherwise the
   * budget is sized from the model's context window AND its price so one
   * fully-cached context pass costs at most ~autoBudgetCarryCostUsd (cache
   * reads bill ~0.1x input price, and EVERY tool-loop API call re-reads the
   * whole context). Cheap models get their full window; expensive models get
   * a smaller, stable, still-cached context.
   */
  private async effectiveContextBudget(
    cfg: ReturnType<typeof getConfig>,
    client?: OpenRouterClient
  ): Promise<number> {
    if (cfg.maxContextTokens > 0) return cfg.maxContextTokens;
    let meta = this.lookupModelMeta(cfg.model);
    if (!meta) {
      // Usually warm already (preloadModelMeta runs at startup / on config
      // change). Cold-cache fallback: wait briefly for /models so the first
      // turn runs with the real window instead of the 180k fallback. A hung
      // fetch never blocks the turn — the load keeps going in the background
      // and later turns pick it up.
      const metaClient =
        client ??
        new OpenRouterClient({ apiKey: "", baseUrl: cfg.baseUrl, model: cfg.model });
      await Promise.race([
        this.loadModelMeta(metaClient, cfg.model),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
      meta = this.lookupModelMeta(cfg.model);
    }
    if (!meta) return 180_000;
    const windowCap = meta.contextLength
      ? Math.floor(meta.contextLength * 0.8)
      : 180_000;
    const priceCap =
      meta.promptPrice && meta.promptPrice > 0
        ? Math.floor(cfg.autoBudgetCarryCostUsd / (meta.promptPrice * 0.1))
        : Number.POSITIVE_INFINITY;
    return Math.max(32_000, Math.min(windowCap, priceCap));
  }

  /** Metadata for a model id, tolerating ":variant" suffixes (e.g. ":free",
   * ":thinking") that the /models list may key differently. */
  private lookupModelMeta(model: string) {
    return this.modelMeta.get(model) ?? this.modelMeta.get(model.split(":")[0]);
  }

  /** Warm the model-metadata cache in the background so the first turn's
   * budget calculation never blocks on /models (it raced up to 2.5s). */
  private preloadModelMeta() {
    const cfg = getConfig();
    const client = new OpenRouterClient({
      apiKey: "", // /models needs no auth; metadata only
      baseUrl: cfg.baseUrl,
      model: cfg.model,
    });
    void this.loadModelMeta(client, cfg.model).catch(() => {});
  }

  /** Fetch model metadata, deduped across concurrent callers. Re-fetches (at
   * most every 5 minutes) when the requested model is missing from the cached
   * list — newly released or renamed ids would otherwise be stuck on the
   * fallback budget forever. */
  private loadModelMeta(client: OpenRouterClient, wantModel?: string): Promise<void> {
    const known = wantModel ? !!this.lookupModelMeta(wantModel) : this.modelMeta.size > 0;
    if (known) return Promise.resolve();
    if (this.modelMetaPromise) return this.modelMetaPromise;
    if (this.modelMeta.size > 0 && Date.now() - this.modelMetaFetchedAt < 300_000) {
      // The model genuinely isn't in the list; don't hammer /models.
      return Promise.resolve();
    }
    this.modelMetaPromise = (async () => {
      try {
        const models = await client.listModels();
        for (const m of models) {
          const promptPrice = Number.parseFloat(m.pricing?.prompt ?? "");
          this.modelMeta.set(m.id, {
            contextLength: m.contextLength,
            promptPrice: Number.isFinite(promptPrice) ? promptPrice : undefined,
          });
        }
        this.modelMetaFetchedAt = Date.now();
      } catch {
        // Offline or API hiccup: stay on the fallback budget.
      } finally {
        this.modelMetaPromise = null;
      }
    })();
    return this.modelMetaPromise;
  }

  private askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.sessionApprovedKinds.has(req.kind)) {
      return Promise.resolve("approved");
    }
    const id = `appr_${this.approvalSeq++}`;
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(id, (decision) => {
        if (decision === "approved-always") {
          this.sessionApprovedKinds.add(req.kind);
          resolve("approved");
        } else {
          resolve(decision);
        }
      });
      this.post({
        type: "approvalRequest",
        payload: {
          id,
          kind: req.kind,
          title: req.title,
          subject: req.subject,
          detail: req.detail,
          diff: req.diff,
          diffs: req.diffs,
        },
      });
    });
  }

  /** Pause the agent for a clarifying question (ask_user tool). */
  private askUser(req: { question: string; options?: string[] }): Promise<string> {
    const id = `ask_${this.askUserSeq++}`;
    return new Promise<string>((resolve) => {
      this.pendingAskUsers.set(id, resolve);
      this.post({
        type: "askUserRequest",
        id,
        question: req.question,
        options: req.options,
      });
    });
  }

  private static EDIT_TOOL_NAMES = new Set(["write_file", "edit_file", "apply_patch"]);

  /** Reveal a just-edited file in a preview tab without stealing focus, so edits
   * are visible as they land. Gated by lunacode.revealEditedFiles. */
  private async revealEditedFile(name: string, diff?: import("./protocol").DiffData) {
    if (!LunaCodeController.EDIT_TOOL_NAMES.has(name) || !diff?.path) return;
    if (!getConfig().revealEditedFiles) return;
    const root = this.workspaceRoot();
    if (!root) return;
    try {
      const abs = path.isAbsolute(diff.path) ? diff.path : path.join(root, diff.path);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    } catch {
      // File may have been deleted or is binary — ignore.
    }
  }

  private forwardEvent(e: import("../agent/agent").AgentEvent) {
    switch (e.type) {
      case "turn_start":
        this.post({ type: "turnStart", model: this.activeModel || getConfig().model });
        break;
      case "text":
        this.post({ type: "assistantText", delta: e.delta });
        break;
      case "reasoning":
        this.post({ type: "reasoning", delta: e.delta });
        break;
      case "tool_start":
        this.post({ type: "toolStart", id: e.id, name: e.name, args: e.args });
        break;
      case "tool_end":
        this.post({ type: "toolEnd", id: e.id, name: e.name, ok: e.ok, summary: e.summary, diff: e.diff });
        // Attribute code lines written/removed to the active model.
        if (e.ok && e.diff && (e.diff.addCount || e.diff.delCount)) {
          void this.usage.recordCode({
            ts: Date.now(),
            model: this.activeModel || getConfig().model,
            added: e.diff.addCount,
            removed: e.diff.delCount,
          });
        }
        // Reveal the edited file live (non-intrusive: preview tab, focus stays).
        if (e.ok) void this.revealEditedFile(e.name, e.diff);
        break;
      case "status":
        this.post({ type: "status", message: e.message });
        break;
      case "steering":
        this.post({ type: "steeringApplied" });
        break;
      case "usage": {
        const cost = e.usage.cost ?? 0;
        this.post({
          type: "usage",
          usage: {
            promptTokens: e.usage.prompt_tokens,
            completionTokens: e.usage.completion_tokens,
            cachedTokens: e.cachedTokens,
            cost: e.usage.cost,
          },
        });
        // Accumulate into the session total (spread keeps compaction counters).
        this.sessionUsage = {
          ...this.sessionUsage,
          promptTokens: this.sessionUsage.promptTokens + (e.usage.prompt_tokens || 0),
          completionTokens:
            this.sessionUsage.completionTokens + (e.usage.completion_tokens || 0),
          cachedTokens: this.sessionUsage.cachedTokens + (e.cachedTokens || 0),
          cost: this.sessionUsage.cost + cost,
        };
        this.post({ type: "sessionUsage", usage: this.sessionUsage });
        // Persist to the global analytics store, attributed to the model that
        // actually incurred it (summarizer calls carry their own model).
        void this.usage.record({
          ts: Date.now(),
          model: e.model || this.activeModel || getConfig().model,
          prompt: e.usage.prompt_tokens || 0,
          completion: e.usage.completion_tokens || 0,
          cached: e.cachedTokens || 0,
          cost,
        });
        break;
      }
      case "tasks":
        this.post({ type: "taskList", tasks: e.tasks });
        break;
      case "stream_progress":
        this.post({ type: "streamProgress", tokens: e.tokens });
        break;
      case "tool_output":
        this.post({ type: "toolOutput", id: e.id, delta: e.delta });
        break;
      case "compaction":
        this.sessionUsage = {
          ...this.sessionUsage,
          compactions: (this.sessionUsage.compactions ?? 0) + 1,
          tokensSaved: (this.sessionUsage.tokensSaved ?? 0) + e.tokensSaved,
        };
        this.post({ type: "sessionUsage", usage: this.sessionUsage });
        break;
      case "microcompact":
        // Count toward tokensSaved so the meter reflects soft cleanups too.
        this.sessionUsage = {
          ...this.sessionUsage,
          tokensSaved: (this.sessionUsage.tokensSaved ?? 0) + e.tokensSaved,
        };
        this.post({ type: "sessionUsage", usage: this.sessionUsage });
        break;
      case "error":
        this.post({ type: "error", message: e.message });
        break;
      case "turn_end":
        this.post({ type: "turnEnd", stopReason: e.stopReason });
        break;
    }
  }

  // --- HTML ---

  getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.css")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Luna Code</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Thin sidebar view that binds its webview to the shared controller. */
export class LunaCodeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lunacode.chatView";
  public static readonly auxViewType = "lunacode.chatViewAux";

  constructor(
    private readonly controller: LunaCodeController,
    private readonly extensionUri: vscode.Uri
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };
    webviewView.webview.html = this.controller.getHtml(webviewView.webview);
    const sub = this.controller.attach(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.controller.detach(webviewView.webview);
      sub.dispose();
    });
  }
}

/** Singleton editor-area panel (the "tab", like Copilot/Claude Code). */
let editorPanel: vscode.WebviewPanel | undefined;

export function openLunaCodeEditor(
  controller: LunaCodeController,
  extensionUri: vscode.Uri
): vscode.WebviewPanel {
  if (editorPanel) {
    editorPanel.reveal(vscode.ViewColumn.Active);
    return editorPanel;
  }
  const panel = vscode.window.createWebviewPanel(
    "lunacode.editorPanel",
    "Luna Code",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "dist"),
        vscode.Uri.joinPath(extensionUri, "media"),
      ],
    }
  );
  panel.iconPath = {
    light: vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.svg"),
    dark: vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.svg"),
  };
  panel.webview.html = controller.getHtml(panel.webview);
  const sub = controller.attach(panel.webview);
  panel.onDidDispose(() => {
    controller.detach(panel.webview);
    sub.dispose();
    editorPanel = undefined;
  });
  editorPanel = panel;
  return panel;
}

/** True if all chars of `q` appear in order within `s` (fuzzy matching). */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

function extractText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
  return "";
}

/** Reconstruct UI events from stored messages so a loaded session re-renders.
 * `rewindIdByIndex` tags turn-start user bubbles with their rewind id. */
function messagesToEvents(
  messages: ChatMessage[],
  rewindIdByIndex?: Map<number, number>
): HostToWebview[] {
  const events: HostToWebview[] = [];
  const toolNames = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      const t = extractText(m.content);
      if (t.trim()) {
        const rewindId = rewindIdByIndex?.get(i);
        events.push(rewindId !== undefined ? { type: "userEcho", text: t, rewindId } : { type: "userEcho", text: t });
      }
    } else if (m.role === "assistant") {
      const t = extractText(m.content);
      if (t.trim()) events.push({ type: "assistantText", delta: t });
      const a = m as AssistantMessage;
      for (const tc of a.tool_calls ?? []) {
        let args: any = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          /* ignore */
        }
        toolNames.set(tc.id, tc.function.name);
        events.push({ type: "toolStart", id: tc.id, name: tc.function.name, args });
      }
    } else if (m.role === "tool") {
      const summary = (extractText(m.content).split("\n")[0] ?? "").trim();
      const name = toolNames.get(m.tool_call_id) ?? "tool";
      const ok = !/^(Error|User rejected|Blocked|Cannot|Invalid|Command blocked)/i.test(summary);
      events.push({ type: "toolEnd", id: m.tool_call_id, name, ok, summary });
    }
  }
  return events;
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
