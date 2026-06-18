import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { HostToWebview, WebviewToHost } from "./protocol";
import { Agent } from "../agent/agent";
import { ContextManager } from "../agent/contextManager";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { OpenRouterClient } from "../openrouter/client";
import { getConfig, SecretStore } from "../config";
import { AgentMode, MODES } from "../modes";
import { ApprovalDecision, ApprovalRequest } from "../agent/tools/types";
import { IGNORED_DIRS } from "../agent/tools/util";
import { SessionStore, StoredSession, deriveTitle } from "../sessions";
import { AssistantMessage, ChatMessage } from "../openrouter/types";
import { UsageStore } from "../usage";
import { SessionUsage } from "./protocol";

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
  private queue: string[] = [];

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
    if (msg.type === "init" || msg.type === "config" || msg.type === "sessionList") return;
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
    this.post({ type: "sessionReset" });
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
    this.post({ type: "config", hasApiKey: !!key, model: cfg.model, mode: this.mode });
  }

  // --- messaging ---

  private async handleMessage(msg: WebviewToHost, source: vscode.Webview) {
    switch (msg.type) {
      case "ready":
        await this.sendInit(source);
        break;
      case "send":
        await this.onSend(msg.text);
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
    }
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
    } satisfies HostToWebview);
    // Replay history so a freshly-attached surface shows the conversation.
    for (const ev of this.transcript) {
      void source.postMessage(ev);
    }
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

  private async onSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    const apiKey = await this.secrets.getApiKey();
    if (!apiKey) {
      this.post({ type: "error", message: "No OpenRouter API key set. Click the key icon to add one." });
      return;
    }
    if (!this.workspaceRoot()) {
      this.post({ type: "error", message: "Open a folder/workspace to use Luna Code." });
      return;
    }

    // Fold any queued editor selections into this message now.
    let userText = trimmed;
    if (this.pendingSelections.length) {
      userText = this.pendingSelections.join("\n\n") + "\n\n" + trimmed;
      this.pendingSelections = [];
    }

    // Echo immediately. If a turn is already active, this one is queued and runs
    // when the current turn (and anything ahead of it) finishes.
    this.post({ type: "userEcho", text: trimmed, queued: this.running });
    this.queue.push(userText);
    void this.pump();
  }

  /** Run queued turns one at a time, FIFO, until the queue drains. */
  private async pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.running = true;
    try {
      await this.runTurn(next);
    } finally {
      this.running = false;
      await this.persistCurrent();
      if (this.queue.length) void this.pump();
    }
  }

  private async runTurn(userText: string) {
    const cfg = getConfig();
    const apiKey = await this.secrets.getApiKey();
    const root = this.workspaceRoot();
    if (!apiKey || !root) return; // validated at enqueue; bail defensively

    this.context.setCaching(cfg.enablePromptCaching);
    this.context.setSystemPrompt(
      buildSystemPrompt({
        mode: this.mode,
        workspaceRoot: root,
        os: `${os.type()} ${os.release()} (${os.platform()})`,
        shell: os.platform() === "win32" ? "PowerShell" : "sh",
        workspaceOverview: this.workspaceOverview(root),
      })
    );

    this.activeModel = cfg.model;
    const client = new OpenRouterClient({
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dataCollection: cfg.dataCollection,
      zdr: cfg.zeroDataRetention,
    });

    this.agent = new Agent(
      {
        client,
        context: this.context,
        output: this.output,
        workspaceRoot: root,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        maxContextTokens: cfg.maxContextTokens,
      },
      {
        onEvent: (e) => this.forwardEvent(e),
        requestApproval: (req) => this.askApproval(req),
      }
    );

    await this.agent.run(userText, this.mode);
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
        // Accumulate into the session total.
        this.sessionUsage = {
          promptTokens: this.sessionUsage.promptTokens + (e.usage.prompt_tokens || 0),
          completionTokens:
            this.sessionUsage.completionTokens + (e.usage.completion_tokens || 0),
          cachedTokens: this.sessionUsage.cachedTokens + (e.cachedTokens || 0),
          cost: this.sessionUsage.cost + cost,
        };
        this.post({ type: "sessionUsage", usage: this.sessionUsage });
        // Persist to the global analytics store.
        void this.usage.record({
          ts: Date.now(),
          model: this.activeModel || getConfig().model,
          prompt: e.usage.prompt_tokens || 0,
          completion: e.usage.completion_tokens || 0,
          cached: e.cachedTokens || 0,
          cost,
        });
        break;
      }
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
