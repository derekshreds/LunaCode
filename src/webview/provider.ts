import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { HostToWebview, WebviewToHost } from "./protocol";
import { Agent } from "../agent/agent";
import { ContextManager, estimateTokens } from "../agent/contextManager";
import { computeDiff } from "../diff";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { OpenRouterClient } from "../openrouter/client";
import { getConfig, SecretStore } from "../config";
import { AgentMode, MODES } from "../modes";
import { ApprovalDecision, ApprovalRequest } from "../agent/tools/types";
import { IGNORED_DIRS, resolveInWorkspace } from "../agent/tools/util";
import { toolsForMode, toToolDefinitions } from "../agent/tools";
import { SessionStore, StoredSession, deriveTitle } from "../sessions";
import { AssistantMessage, ChatMessage } from "../openrouter/types";
import { UsageStore } from "../usage";
import { SessionUsage, SettingsPayload } from "./protocol";
import { McpManager } from "../mcp/manager";
import { disposeAllProcesses } from "../agent/tools/backgroundProcess";

/** Built-in slash commands (custom ones come from lunacode.customCommands). */
const SLASH_COMMANDS: Record<string, string> = {
  commit:
    "Look at the current git status and diff, stage the appropriate files, and create a commit with a well-written conventional commit message. Show the final commit.",
  review:
    "Review the current working tree changes (git diff plus git diff --staged). Report findings ordered by severity — bugs, then risks, then style — with specific file:line references. Do not change any files.",
  tests:
    "Run the project's test suite, analyze any failures, fix them, and re-run until everything passes.",
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
  private sessionApprovedKinds = new Set<string>();
  private pendingSelections: string[] = [];
  /** User messages waiting to run (queued while a turn is active). */
  private queue: Array<{ text: string; images?: string[] }> = [];

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

  /** Per-turn file checkpoints (before-contents; null = file didn't exist).
   * In-memory stack, newest last — revert pops. */
  private checkpointStack: Array<Map<string, string | null>> = [];
  private activeCheckpoint: Map<string, string | null> | null = null;
  private static MAX_CHECKPOINT_TURNS = 10;
  private static MAX_CHECKPOINT_FILE_BYTES = 2 * 1024 * 1024;

  /** MCP tools frozen at the session's first turn — tools render at position 0
   * of the prompt, so a server connecting mid-session must not change the tool
   * array (it would invalidate the entire prompt cache). */
  private sessionMcpTools: import("../agent/tools/types").Tool[] | null = null;
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
    this.mcp = new McpManager(output, (m) => this.post({ type: "status", message: m }));
    this.mcp.refresh(cfg.mcpServers);
    this.lastEditor = vscode.window.activeTextEditor;
    this.editorTracker = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e && e.document.uri.scheme === "file") this.lastEditor = e;
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
      msg.type === "fileMatches"
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
    this.checkpointStack = [];
    this.activeCheckpoint = null;
    this.sessionMcpTools = null; // pick up newly-connected MCP servers
    this.postCheckpointState();
    this.post({ type: "sessionReset" });
    this.post({ type: "taskList", tasks: [] });
    void this.maybePrewarm();
    this.post({ type: "sessionUsage", usage: this.sessionUsage });
    void this.sendConfig();
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
    });
  }

  /** Called when lunacode.* settings change anywhere (settings editor, model
   * QuickPick, the GUI itself) — refreshes the model chip and any open sheet. */
  onConfigChanged() {
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
      case "newSession":
        this.newSession();
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("lunacode.setApiKey");
        break;
      case "selectModel":
        await vscode.commands.executeCommand("lunacode.selectModel");
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
      case "revertTurn":
        this.revertLastTurn();
        break;
      case "getTurnDiff":
        this.sendTurnDiff();
        break;
      case "commitTurn":
        await this.commitLastTurn();
        break;
      case "getContextInfo":
        void this.sendContextInfo();
        break;
      case "retryTurn":
        await this.retryLastTurn(false);
        break;
      case "editLastTurn":
        await this.retryLastTurn(true);
        break;
      case "exportSession":
        await this.exportSession();
        break;
      case "queryFiles":
        void this.queryFiles(msg.query, msg.token, source);
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
        fallbackModels: cfg.fallbackModels,
        prewarmCache: cfg.prewarmCache,
        maxContextTokens: cfg.maxContextTokens,
        autoBudgetCarryCostUsd: cfg.autoBudgetCarryCostUsd,
        compactionTargetRatio: cfg.compactionTargetRatio,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        enablePromptCaching: cfg.enablePromptCaching,
        defaultMode: cfg.defaultMode,
        dataCollection: cfg.dataCollection,
        zeroDataRetention: cfg.zeroDataRetention,
        providerSort: cfg.providerSort ?? "default",
        sessionBudgetUsd: cfg.sessionBudgetUsd,
        maxTurns: cfg.maxTurns,
        includeActiveFile: cfg.includeActiveFile,
        formatAfterEdit: cfg.formatAfterEdit,
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
    "fallbackModels",
    "prewarmCache",
    "sessionBudgetUsd",
    "maxTurns",
    "includeActiveFile",
    "formatAfterEdit",
    "worktreeMode",
    "maxContextTokens",
    "autoBudgetCarryCostUsd",
    "compactionTargetRatio",
    "maxTokens",
    "temperature",
    "enablePromptCaching",
    "defaultMode",
    "dataCollection",
    "zeroDataRetention",
    "providerSort",
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
    this.checkpointStack = (s.checkpoints ?? []).map((cp) => new Map(cp));
    this.activeCheckpoint = null;
    this.postCheckpointState();
    this.post({ type: "taskList", tasks: [] });
    this.context.loadMessages(s.messages);
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
    this.post({ type: "sessionUsage", usage: this.sessionUsage });
    for (const ev of messagesToEvents(s.messages)) {
      this.post(ev);
    }
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
      checkpoints: this.serializeCheckpoints(),
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
    } satisfies HostToWebview);
    // Replay history so a freshly-attached surface shows the conversation.
    for (const ev of this.transcript) {
      void source.postMessage(ev);
    }
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

  /** Project memory: LUNA.md at the workspace root plus nested LUNA.md files
   * in subdirectories (monorepo packages), capped so memory can't blow up the
   * (cached) system prompt. Re-read each turn — if the agent updates one
   * mid-session, the next turn pays one cache re-write and then the new
   * prefix is stable again. */
  private readProjectMemory(root: string): string | undefined {
    const sections: string[] = [];
    try {
      const rootFile = path.join(root, "LUNA.md");
      if (fs.existsSync(rootFile)) {
        const text = fs.readFileSync(rootFile, "utf8").trim();
        if (text) {
          const MAX = 6000;
          sections.push(text.length > MAX ? text.slice(0, MAX) + "\n…[LUNA.md truncated]" : text);
        }
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

    // Slash commands: /name expands to its template; extra text is appended.
    let userText = trimmed;
    const slash = /^\/([a-zA-Z0-9_-]+)\b\s*([\s\S]*)$/.exec(trimmed);
    if (slash) {
      const cfg = getConfig();
      const template = cfg.customCommands[slash[1]] ?? SLASH_COMMANDS[slash[1]];
      if (template) userText = template + (slash[2] ? `\n\n${slash[2]}` : "");
    }

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
    this.post({
      type: "userEcho",
      text: trimmed + (images?.length ? `\n\n🖼 ${images.length} image(s) attached` : ""),
      queued: this.running,
    });
    this.queue.push({ text: userText, images });
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
      await this.runTurn(next.text, next.images);
    } finally {
      this.running = false;
      await this.persistCurrent();
      if (this.queue.length) void this.pump();
    }
  }

  private async runTurn(userText: string, images?: string[]) {
    const cfg = getConfig();
    const apiKey = await this.secrets.getApiKey();
    let root = this.workspaceRoot();
    if (!apiKey || !root) return; // validated at enqueue; bail defensively
    if (cfg.worktreeMode) root = await this.ensureSandbox(root);

    this.context.setCaching(cfg.enablePromptCaching);
    this.context.setSystemPrompt(
      buildSystemPrompt({
        mode: this.mode,
        workspaceRoot: root,
        os: `${os.type()} ${os.release()} (${os.platform()})`,
        shell: os.platform() === "win32" ? "PowerShell" : "sh",
        workspaceOverview: this.workspaceOverview(root),
        projectMemory: this.readProjectMemory(root),
      })
    );

    this.activeModel = cfg.model;
    const client = new OpenRouterClient({
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dataCollection: cfg.dataCollection,
      zdr: cfg.zeroDataRetention,
      providerSort: cfg.providerSort,
    });

    this.agent = new Agent(
      {
        client,
        context: this.context,
        output: this.output,
        workspaceRoot: root,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        maxContextTokens: await this.effectiveContextBudget(cfg, client),
        summarizerModel: cfg.summarizerModel || cfg.model,
        compactionTargetRatio: cfg.compactionTargetRatio,
        subagentModel: cfg.subagentModel,
        maxTurns: cfg.maxTurns,
        snapshotFile: (relPath) => this.snapshotFile(root, relPath),
        extraTools: (this.sessionMcpTools ??= this.mcp.getTools()),
        // Mid-turn steering: the agent drains queued messages each iteration.
        takeSteering: () => this.queue.splice(0, this.queue.length),
        formatAfterEdit: cfg.formatAfterEdit,
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
      }
    );

    this.activeCheckpoint = new Map();
    try {
      await this.agent.run(userText, this.mode, images);
    } finally {
      if (this.activeCheckpoint && this.activeCheckpoint.size > 0) {
        this.checkpointStack.push(this.activeCheckpoint);
        if (this.checkpointStack.length > LunaCodeController.MAX_CHECKPOINT_TURNS) {
          this.checkpointStack.shift();
        }
      }
      this.activeCheckpoint = null;
      this.postCheckpointState();
    }
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

  private revertLastTurn() {
    if (this.running) {
      this.post({ type: "status", message: "Can't revert while a turn is running." });
      return;
    }
    const checkpoint = this.checkpointStack.pop();
    if (!checkpoint) {
      this.post({ type: "status", message: "Nothing to revert." });
      return;
    }
    let restored = 0;
    let deleted = 0;
    let failed = 0;
    for (const [abs, before] of checkpoint) {
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
    const bits: string[] = [];
    if (restored) bits.push(`${restored} file(s) restored`);
    if (deleted) bits.push(`${deleted} created file(s) removed`);
    if (failed) bits.push(`${failed} failed`);
    this.post({
      type: "status",
      message: `↩ Reverted the last turn's edits — ${bits.join(", ") || "no changes"}. (Command side effects are not reverted.)`,
    });
    this.postCheckpointState();
  }

  /** Serialize checkpoints for persistence with size caps (Memento-friendly). */
  private serializeCheckpoints(): Array<Array<[string, string | null]>> {
    const out: Array<Array<[string, string | null]>> = [];
    let total = 0;
    for (const cp of this.checkpointStack) {
      const entries: Array<[string, string | null]> = [];
      for (const [p, v] of cp) {
        const size = v?.length ?? 0;
        if (size > 256 * 1024) continue;
        total += size;
        if (total > 1_000_000) return out;
        entries.push([p, v]);
      }
      if (entries.length) out.push(entries);
    }
    return out;
  }

  private postCheckpointState() {
    const top = this.checkpointStack[this.checkpointStack.length - 1];
    this.post({
      type: "checkpointState",
      turns: this.checkpointStack.length,
      files: top ? top.size : 0,
    });
  }

  /** Side-by-side diffs of the last turn's edits (checkpoint vs disk). */
  private sendTurnDiff() {
    const checkpoint = this.checkpointStack[this.checkpointStack.length - 1];
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
      const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : abs;
      diffs.push(computeDiff(before ?? "", after ?? "", rel));
    }
    this.post({ type: "turnDiff", diffs });
  }

  /** Stage + commit the last turn's edited files with a generated message. */
  private async commitLastTurn() {
    const checkpoint = this.checkpointStack[this.checkpointStack.length - 1];
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
    const messages = this.context.getMessages();
    const systemTokens = Math.ceil(
      (root
        ? buildSystemPrompt({
            mode: this.mode,
            workspaceRoot: root,
            os: `${os.type()} ${os.release()} (${os.platform()})`,
            shell: os.platform() === "win32" ? "PowerShell" : "sh",
            workspaceOverview: this.workspaceOverview(root),
            projectMemory: this.readProjectMemory(root),
          }).length
        : 0) / 4
    );
    const sized = messages.map((m, i) => ({
      i,
      role: m.role,
      tokens: estimateTokens([m]),
      preview: (typeof m.content === "string" ? m.content : "")
        .replace(/\s+/g, " ")
        .slice(0, 70),
    }));
    const totalTokens = systemTokens + sized.reduce((a, m) => a + m.tokens, 0);
    const client = new OpenRouterClient({
      apiKey: "", // unused — only need the budget calculation
      baseUrl: cfg.baseUrl,
      model: cfg.model,
    });
    const budget = await this.effectiveContextBudget(cfg, client);
    const price = this.lookupModelMeta(cfg.model)?.promptPrice;
    this.post({
      type: "contextInfo",
      info: {
        totalTokens,
        budget,
        systemTokens,
        messageCount: messages.length,
        hasMemory: !!(root && this.readProjectMemory(root)),
        nextCallCostUsd: price ? totalTokens * price * 0.1 : undefined,
        largest: sized
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 6)
          .map(({ role, preview, tokens }) => ({ role, preview, tokens })),
      },
    });
  }

  /** Roll the conversation back to (and including) the last user message.
   * retry=false re-sends it; edit=true puts it in the composer instead. */
  private async retryLastTurn(edit: boolean) {
    if (this.running) {
      this.post({ type: "status", message: "Wait for the current turn to finish (or stop it) first." });
      return;
    }
    const rolled = this.context.rollbackToLastUser();
    if (rolled === null) {
      this.post({ type: "status", message: "Nothing to retry." });
      return;
    }
    // Trim the replayable transcript back to before the last user echo.
    const lastEcho = this.transcript
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.type === "userEcho")
      .pop();
    if (lastEcho) this.transcript.splice(lastEcho.i);
    this.post({ type: "rollback" });
    if (edit) {
      this.post({ type: "composerFill", text: rolled.text });
    } else {
      // Re-queue DIRECTLY: the rolled-back text already carries slash
      // expansion, selections, and the editor note — onSend would add them
      // twice. Images ride along too.
      this.post({ type: "userEcho", text: rolled.text, queued: false });
      this.queue.push({ text: rolled.text, images: rolled.images.length ? rolled.images : undefined });
      void this.pump();
    }
  }

  /** Fuzzy file matches for @-mention completion (cached workspace walk). */
  private async queryFiles(query: string, token: number, source: vscode.Webview) {
    const now = Date.now();
    if (!this.fileListCache || now - this.fileListCache.at > 30_000) {
      const uris = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 5000);
      const root = this.workspaceRoot() ?? "";
      this.fileListCache = {
        at: now,
        files: uris
          .map((u) => (u.fsPath.startsWith(root) ? u.fsPath.slice(root.length + 1) : u.fsPath))
          .sort(),
      };
    }
    const q = query.toLowerCase();
    const scored: Array<{ f: string; s: number }> = [];
    for (const f of this.fileListCache.files) {
      const lower = f.toLowerCase();
      let s = -1;
      if (!q) s = 0;
      else if (lower.includes(q)) s = 100 - lower.indexOf(q) - (lower.length - q.length) * 0.01;
      else if (isSubsequence(q, lower)) s = 10 - lower.length * 0.01;
      if (s >= 0) scored.push({ f, s });
    }
    scored.sort((a, b) => b.s - a.s);
    void source.postMessage({
      type: "fileMatches",
      token,
      files: scored.slice(0, 12).map((x) => x.f),
    } satisfies HostToWebview);
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
    return [...new Set([...Object.keys(SLASH_COMMANDS), ...custom])];
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
    tmp.setSystemPrompt(
      buildSystemPrompt({
        mode: this.mode,
        workspaceRoot: root,
        os: `${os.type()} ${os.release()} (${os.platform()})`,
        shell: os.platform() === "win32" ? "PowerShell" : "sh",
        workspaceOverview: this.workspaceOverview(root),
        projectMemory: this.readProjectMemory(root),
      })
    );
    tmp.addUser("Reply with exactly: ok");
    const client = new OpenRouterClient({
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dataCollection: cfg.dataCollection,
      zdr: cfg.zeroDataRetention,
      providerSort: cfg.providerSort,
    });
    const allowsMutation = MODES[this.mode].allowsMutation;
    const tools = [
      ...toolsForMode(!allowsMutation),
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
    client: OpenRouterClient
  ): Promise<number> {
    if (cfg.maxContextTokens > 0) return cfg.maxContextTokens;
    let meta = this.lookupModelMeta(cfg.model);
    if (!meta) {
      // Wait (briefly) for /models so the first turn of a session already
      // runs with the real window instead of the 180k fallback. A hung
      // fetch never blocks the turn — the load keeps going in the
      // background and later turns pick it up.
      await Promise.race([
        this.loadModelMeta(client, cfg.model),
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

  private forwardEvent(e: import("../agent/agent").AgentEvent) {
    switch (e.type) {
      case "turn_start":
        this.post({ type: "turnStart" });
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
        break;
      case "status":
        this.post({ type: "status", message: e.message });
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

/** Reconstruct UI events from stored messages so a loaded session re-renders. */
function messagesToEvents(messages: ChatMessage[]): HostToWebview[] {
  const events: HostToWebview[] = [];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "user") {
      const t = extractText(m.content);
      if (t.trim()) events.push({ type: "userEcho", text: t });
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
