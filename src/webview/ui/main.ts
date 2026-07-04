import {
  HostToWebview,
  WebviewToHost,
  ApprovalPayload,
  ContextInfo,
  SessionUsage,
  SettingsPayload,
  TaskItem,
  UsageReport,
  DiffData,
  DailyPoint,
  ModelPoint,
} from "../protocol";
import { renderMarkdown } from "./markdown";
import { highlightLine, escapeHtml } from "./highlight";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();
function post(msg: WebviewToHost) {
  vscode.postMessage(msg);
}

// ---------- State ----------
interface UiState {
  hasApiKey: boolean;
  model: string;
  mode: string;
  modes: { id: string; label: string; description: string }[];
  running: boolean;
  /** Slash commands available (without the slash). */
  commands: string[];
}
const state: UiState = {
  hasApiKey: false,
  model: "",
  mode: "standard",
  modes: [],
  running: false,
  commands: [],
};

let currentAssistant: { el: HTMLElement; raw: string } | null = null;

// Thinking state machine
let thinkStart = 0;
let thinking = false;
let sawReasoning = false;

// Usage
let sessionUsage: SessionUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
let lastTurnUsage: { promptTokens: number; completionTokens: number; cachedTokens: number; cost?: number } | null = null;
let usageDays = 30;
/** True while the user wants the settings sheet open — settingsData messages
 * also arrive unsolicited (config-change broadcasts) and must not open it. */
let settingsWanted = false;
/** Timestamp of the last provider usage event — proxy for "the provider's
 * prompt cache was just written". Typical cache TTL is ~5 minutes. */
let lastUsageAt = 0;
/** Revertible turn checkpoints available on the host. */
let checkpointTurns = 0;
let checkpointFiles = 0;
/** Completed turns this session — gates the retry/edit chips. */
let turnsCompleted = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
// Re-render the meter periodically so the warmth dot flips to cold on its own.
setInterval(() => {
  if (lastUsageAt) updateMeter();
}, 30_000);

// ---------- DOM helpers ----------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

// ---------- Layout ----------
const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="header">
    <div class="brand">
      <span class="logo"></span>
      <span class="brand-name">Luna Code</span>
    </div>
    <div class="header-actions">
      <button id="modelBtn" class="model-chip" title="Change model"></button>
      <button id="usageBtn" class="icon-btn" title="Usage & cost"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 20V10M10 20V4M16 20v-7M20 20H3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button id="historyBtn" class="icon-btn" title="Session history"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button id="settingsBtn" class="icon-btn" title="Settings"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.12-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10.05 3V3a2 2 0 1 1 4 0v.09c0 .68.4 1.29 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01c.27.62.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.29.4-1.56 1.03z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button id="newBtn" class="icon-btn" title="New session"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
  </div>
  <div id="overlay" class="overlay hidden"></div>
  <div id="messages" class="messages"></div>
  <div id="approval" class="approval-slot"></div>
  <div id="tasks" class="tasks hidden"></div>
  <div id="activity" class="activity hidden">
    <span class="think-orb"></span>
    <span class="think-label">
      <span class="think-text">Thinking</span>
      <span class="think-dots"><i></i><i></i><i></i></span>
    </span>
    <span id="thinkCount" class="think-count"></span>
  </div>
  <div class="composer">
    <div id="mention" class="mention hidden"></div>
    <div id="actionsMenu" class="actions-menu hidden"></div>
    <div class="input-shell">
      <div id="attach" class="attach hidden"></div>
      <div class="input-row">
        <textarea id="input" rows="1" placeholder="Ask Luna Code to build, fix, or explain…  (Enter to send · Shift+Enter for newline)"></textarea>
        <button id="sendBtn" class="send-btn" title="Send"></button>
      </div>
      <div class="composer-bar">
        <div id="modeBar" class="mode-bar"></div>
        <div id="meter" class="meter"></div>
      </div>
    </div>
  </div>
`;

const messagesEl = $("messages");
const inputEl = $("input") as HTMLTextAreaElement;
const sendBtn = $("sendBtn") as HTMLButtonElement;
const modeBarEl = $("modeBar");
const modelBtn = $("modelBtn") as HTMLButtonElement;
const meterEl = $("meter");
const approvalEl = $("approval");
const overlayEl = $("overlay");
const activityEl = $("activity");
const tasksEl = $("tasks");
const mentionEl = $("mention");
const actionsMenuEl = $("actionsMenu");
const attachEl = $("attach");
const thinkCountEl = $("thinkCount");

const SEND_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 11l18-8-8 18-2.5-7.5L3 11z" fill="currentColor"/></svg>`;
const STOP_ICON = `<svg width="14" height="14" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>`;
sendBtn.innerHTML = SEND_ICON;

// ---------- Events ----------
modelBtn.addEventListener("click", () => post({ type: "selectModel" }));
$("newBtn").addEventListener("click", () => post({ type: "newSession" }));
$("historyBtn").addEventListener("click", () => post({ type: "listSessions" }));
$("usageBtn").addEventListener("click", () => post({ type: "getUsage", days: usageDays }));
$("settingsBtn").addEventListener("click", () => {
  settingsWanted = true;
  post({ type: "getSettings" });
});
overlayEl.addEventListener("click", (e) => {
  if (e.target === overlayEl) hideOverlay();
});
// The meter is re-rendered via innerHTML, so use delegation for its chips.
meterEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest(".actions-chip")) {
    e.stopPropagation();
    toggleActionsMenu();
  } else if (t.closest(".meter-session")) {
    post({ type: "getContextInfo" });
  }
});
document.addEventListener("click", (e) => {
  if (!actionsMenuEl.classList.contains("hidden") && !actionsMenuEl.contains(e.target as Node)) {
    actionsMenuEl.classList.add("hidden");
  }
});

/** Labeled actions menu (replaces the cryptic one-glyph chips). */
function toggleActionsMenu() {
  if (!actionsMenuEl.classList.contains("hidden")) {
    actionsMenuEl.classList.add("hidden");
    return;
  }
  actionsMenuEl.innerHTML = "";
  const item = (
    icon: string,
    label: string,
    hint: string,
    enabled: boolean,
    action: WebviewToHost
  ) => {
    const row = el("div", "actions-item" + (enabled ? "" : " disabled"));
    row.appendChild(el("span", "actions-icon", icon));
    const meta = el("div", "actions-meta");
    meta.appendChild(el("div", "actions-label", label));
    meta.appendChild(el("div", "actions-hint", hint));
    row.appendChild(meta);
    if (enabled) {
      row.onclick = () => {
        actionsMenuEl.classList.add("hidden");
        post(action);
      };
    }
    actionsMenuEl.appendChild(row);
  };
  const hasEdits = checkpointTurns > 0;
  const hasTurns = turnsCompleted > 0;
  item("±", "Review & commit changes", hasEdits ? `Diff the last turn's ${checkpointFiles} file(s), commit with one click` : "No edits from the last turn", hasEdits, { type: "getTurnDiff" });
  item("↩", "Revert last turn's edits", hasEdits ? `Restore ${checkpointFiles} file(s) (${checkpointTurns} turn(s) revertible)` : "No edits to revert", hasEdits, { type: "revertTurn" });
  item("↻", "Retry last message", hasTurns ? "Roll back and re-send your last message" : "Nothing to retry yet", hasTurns, { type: "retryTurn" });
  item("✎", "Edit last message", hasTurns ? "Roll back and edit before re-sending" : "Nothing to edit yet", hasTurns, { type: "editLastTurn" });
  item("◔", "Context inspector", "What's in the context window and what the next call costs", true, { type: "getContextInfo" });
  item("⬇", "Export session", "Open this conversation as a Markdown document", hasTurns, { type: "exportSession" });
  actionsMenuEl.classList.remove("hidden");
}
inputEl.addEventListener("input", () => {
  autosize();
  updateMention();
});
inputEl.addEventListener("blur", () => setTimeout(closeMention, 150));
inputEl.addEventListener("keydown", (e) => {
  // While the @-mention dropdown is open, the keyboard drives it.
  if (mentionActive) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveMention(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveMention(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickMention(mentionSel);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener("click", () => {
  if (state.running) post({ type: "cancel" });
  else send();
});

function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}
function send() {
  const text = inputEl.value;
  if (!text.trim() && !pendingImages.length) return;
  if (!state.hasApiKey) {
    post({ type: "setApiKey" });
    return;
  }
  post({
    type: "send",
    text,
    images: pendingImages.length ? [...pendingImages] : undefined,
  });
  pendingImages = [];
  renderAttachments();
  inputEl.value = "";
  autosize();
}
function setRunning(running: boolean) {
  state.running = running;
  sendBtn.classList.toggle("stop", running);
  sendBtn.title = running ? "Stop" : "Send";
  sendBtn.innerHTML = running ? STOP_ICON : SEND_ICON;
}

// ---------- Scroll ----------
// Stick-to-bottom: only auto-scroll while the user is already near the bottom.
// Scrolling up to read pauses following; scrolling back down resumes it.
let stickToBottom = true;
messagesEl.addEventListener("scroll", () => {
  stickToBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
});
function scrollToBottom(force = false) {
  if (!force && !stickToBottom) return;
  if (force) stickToBottom = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- Messages ----------
function addUserMessage(text: string, queued?: boolean) {
  const wrap = el("div", "msg user enter");
  const bubble = el("div", "bubble");
  bubble.innerHTML = renderMarkdown(text);
  if (queued) {
    wrap.classList.add("queued");
    bubble.appendChild(el("span", "queued-tag", "Queued"));
  }
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom(true); // the user's own message always snaps down
}
function clearQueuedTags() {
  messagesEl.querySelectorAll(".msg.user.queued").forEach((m) => {
    m.classList.remove("queued");
    m.querySelector(".queued-tag")?.remove();
  });
}

function ensureAssistant(): { el: HTMLElement; raw: string } {
  if (!currentAssistant) {
    const wrap = el("div", "msg assistant enter");
    const body = el("div", "assistant-body");
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    currentAssistant = { el: body, raw: "" };
  }
  return currentAssistant;
}
function appendAssistantText(delta: string) {
  const a = ensureAssistant();
  a.raw += delta;
  a.el.innerHTML = renderMarkdown(a.raw);
  markClippedCode(a.el);
  scrollToBottom();
}

// ---------- Capped code previews ----------
// Code blocks are height-capped (CSS); blocks that actually overflow get a
// "clipped" marker with a fade + hint, and click opens the full code in a sheet.
let markQueued = false;
function markClippedCode(scope: HTMLElement) {
  if (markQueued) return;
  markQueued = true;
  requestAnimationFrame(() => {
    markQueued = false;
    scope.querySelectorAll("pre, .code-block").forEach((n) => {
      const block = n as HTMLElement;
      block.classList.toggle("clipped", block.scrollHeight > block.clientHeight + 2);
    });
  });
}

messagesEl.addEventListener("click", (e) => {
  const block = (e.target as HTMLElement).closest("pre, .code-block") as HTMLElement | null;
  if (!block || !block.classList.contains("clipped")) return;
  const sheet = openSheet();
  sheet.classList.add("sheet-xl");
  sheetHead(sheet, block.getAttribute("data-lang") || "Code");
  const body = el("div", "code-body");
  const clone = block.cloneNode(true) as HTMLElement;
  clone.classList.remove("clipped");
  clone.classList.add("code-full");
  body.appendChild(clone);
  sheet.appendChild(body);
});

// ---------- Activity bar + thinking ----------
const thinkTextEl = activityEl.querySelector(".think-text") as HTMLElement;

// Tongue-in-cheek "working" messages that rotate while Luna Code is thinking.
const FUNNY = [
  "Searching for aliens",
  "Tokenmaxxing",
  "Installing crapware",
  "Bribing the compiler",
  "Consulting the oracle",
  "Summoning daemons",
  "Reticulating splines",
  "Overthinking it",
  "Touching grass",
  "Negotiating with the GPU",
  "Doomscrolling Stack Overflow",
  "Manifesting the solution",
  "Aligning the vibes",
  "Untangling spaghetti",
  "Feeding the hamsters",
  "Dividing by zero",
  "Asking the rubber duck",
  "Buffering enlightenment",
  "Mining context",
  "Caffeinating neurons",
];
let rotateTimer: number | undefined;
let lastPhrase = "";
function pickPhrase(): string {
  let p = FUNNY[Math.floor(Math.random() * FUNNY.length)];
  while (FUNNY.length > 1 && p === lastPhrase) {
    p = FUNNY[Math.floor(Math.random() * FUNNY.length)];
  }
  lastPhrase = p;
  return p;
}

// The bottom bar stays visible the whole time Luna Code is working so it never
// looks hung. While thinking/responding it cycles funny phrases; while a tool
// runs it shows the concrete action ("Writing index.html").
function startRotating() {
  activityEl.classList.remove("hidden");
  if (rotateTimer !== undefined) return; // already cycling
  thinkTextEl.textContent = pickPhrase();
  rotateTimer = window.setInterval(() => {
    thinkTextEl.textContent = pickPhrase();
  }, 2600);
}
function stopRotating() {
  if (rotateTimer !== undefined) {
    clearInterval(rotateTimer);
    rotateTimer = undefined;
  }
}
function showActivity(label: string) {
  stopRotating();
  thinkTextEl.textContent = label;
  activityEl.classList.remove("hidden");
}
function hideActivity() {
  stopRotating();
  activityEl.classList.add("hidden");
}
function startThink() {
  thinking = true;
  thinkStart = Date.now();
  sawReasoning = false;
}
function finishThink() {
  if (!thinking) return;
  thinking = false;
  const secs = Math.round((Date.now() - thinkStart) / 1000);
  if (sawReasoning || secs >= 3) {
    const shown = Math.max(1, secs);
    messagesEl.appendChild(el("div", "thought-line", `Thought for ${shown}s`));
    scrollToBottom();
  }
}
function shortTarget(s: string): string {
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

// ---------- Tools ----------
// [presentTense, pastTense]
const VERBS: Record<string, [string, string]> = {
  read_file: ["Reading", "Read"],
  list_dir: ["Listing", "Listed"],
  glob: ["Finding files", "Found files"],
  grep: ["Searching", "Searched"],
  file_outline: ["Outlining", "Outlined"],
  get_diagnostics: ["Checking diagnostics", "Checked diagnostics"],
  explore: ["Exploring", "Explored"],
  set_tasks: ["Planning", "Updated plan"],
  write_file: ["Writing", "Wrote"],
  edit_file: ["Editing", "Edited"],
  apply_patch: ["Patching", "Patched"],
  run_command: ["Running", "Ran"],
  start_process: ["Starting", "Started"],
  read_process: ["Reading output", "Read output"],
  stop_process: ["Stopping", "Stopped"],
};

function friendly(name: string, args: any): { verbs: [string, string]; target: string } {
  // MCP tools arrive as mcp__server__tool.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    return { verbs: ["Calling MCP", "Called MCP"], target: `${mcp[1]} · ${mcp[2]}` };
  }
  const verbs = VERBS[name] ?? [name, name];
  let target = "";
  try {
    switch (name) {
      case "read_file": {
        target = args.path ?? "";
        if (args.offset || args.limit) {
          const from = args.offset ?? 1;
          target += args.limit
            ? `  (lines ${from}–${from + args.limit - 1})`
            : `  (from line ${from})`;
        }
        break;
      }
      case "list_dir":
        target = args.path ?? ".";
        break;
      case "write_file":
      case "edit_file":
      case "file_outline":
        target = args.path ?? "";
        break;
      case "apply_patch":
        target = Array.isArray(args.changes) ? `${args.changes.length} file(s)` : "";
        break;
      case "glob":
        target = args.pattern ?? "";
        break;
      case "grep":
        target = args.pattern ? `/${args.pattern}/` : "";
        break;
      case "get_diagnostics":
        target = args.path ?? "workspace";
        break;
      case "explore":
        target = typeof args.question === "string" ? args.question.slice(0, 80) : "";
        break;
      case "set_tasks":
        target = Array.isArray(args.tasks) ? `${args.tasks.length} step(s)` : "";
        break;
      case "run_command":
      case "start_process":
        target = args.command ?? "";
        break;
      case "read_process":
      case "stop_process":
        target = args.id ?? "";
        break;
    }
  } catch {
    /* ignore */
  }
  return { verbs, target };
}

const toolCards = new Map<string, HTMLElement>();
function addToolStart(id: string, name: string, args: any) {
  currentAssistant = null;
  thinkCountEl.textContent = ""; // new step — counter restarts at 0
  const { verbs, target } = friendly(name, args);
  const row = el("div", "tool-row running");
  row.appendChild(el("span", "tool-dot"));
  row.appendChild(el("span", "tool-verb", verbs[0]));
  if (target) row.appendChild(el("span", "tool-sub", target));
  const wrap = el("div", "tool-item enter");
  wrap.appendChild(row);
  messagesEl.appendChild(wrap);
  toolCards.set(id, wrap);
  scrollToBottom();
}
function addToolEnd(id: string, name: string, ok: boolean, summary: string, diff?: DiffData) {
  const wrap = toolCards.get(id);
  if (!wrap) return;
  const row = wrap.querySelector(".tool-row") as HTMLElement | null;
  if (row) {
    row.classList.remove("running");
    row.classList.add(ok ? "ok" : "fail");
    const dot = row.querySelector(".tool-dot");
    if (dot) {
      dot.className = "tool-mark " + (ok ? "ok" : "fail");
      dot.textContent = ok ? "✓" : "✕";
    }
    const verb = row.querySelector(".tool-verb");
    if (verb) verb.textContent = (VERBS[name] ?? [name, name])[1];
  }
  if (diff && diff.rows.length) {
    wrap.appendChild(renderDiffPreview(diff));
  } else if (!ok && summary) {
    wrap.appendChild(el("div", "tool-error", summary));
  }
  scrollToBottom();
}

// ---------- Diff (split, git-style) ----------

/** A brand-new file has no left side at all. */
function isNewFileDiff(diff: DiffData): boolean {
  return !diff.rows.some((r) => r.gap === undefined && r.left);
}

/** Nothing was deleted (new file OR pure additions) — one column suffices;
 * an empty left column would just waste half the width. */
function isSingleColumnDiff(diff: DiffData): boolean {
  return diff.delCount === 0;
}

function diffHead(diff: DiffData, tag?: string): HTMLElement {
  const head = el("div", "diff-head");
  head.appendChild(el("span", "diff-path", diff.path));
  const stat = el("span", "diff-stat");
  if (tag) stat.appendChild(el("span", "diff-tag", tag));
  if (diff.addCount) stat.appendChild(el("span", "stat-add", `+${diff.addCount}`));
  if (diff.delCount) stat.appendChild(el("span", "stat-del", `−${diff.delCount}`));
  head.appendChild(stat);
  return head;
}

function diffBody(diff: DiffData, rows: import("../protocol").DiffRow[]): HTMLElement {
  const single = isSingleColumnDiff(diff);
  const body = el("div", "diff-body" + (single ? " single" : ""));
  for (const r of rows) {
    if (r.gap !== undefined) {
      body.appendChild(el("div", "diff-gap", r.gap));
      continue;
    }
    const rowEl = el("div", "diff-row");
    if (!single) {
      rowEl.appendChild(gutter(r.left?.n));
      rowEl.appendChild(codeCell(r.left?.text, r.left?.type, diff.language));
    }
    rowEl.appendChild(gutter(r.right?.n));
    rowEl.appendChild(codeCell(r.right?.text, r.right?.type, diff.language));
    body.appendChild(rowEl);
  }
  return body;
}

/** Full diff (approvals, sheets): scrollable, all rows. */
function renderDiff(diff: DiffData, _collapsible = false): HTMLElement {
  const root = el("div", "diff");
  root.appendChild(diffHead(diff, isNewFileDiff(diff) ? "new file" : undefined));
  root.appendChild(diffBody(diff, diff.rows));
  if (diff.truncated) root.appendChild(el("div", "diff-trunc", "… diff truncated"));
  return root;
}

/** Compact in-chat preview: the first few changed lines, no scrolling —
 * click anywhere to open the full diff in a sheet. */
function renderDiffPreview(diff: DiffData): HTMLElement {
  const PREVIEW_ROWS = 3;
  const changed = diff.rows.filter(
    (r) => r.gap === undefined && (r.left?.type === "del" || r.right?.type === "add")
  );
  const shown = (changed.length ? changed : diff.rows.filter((r) => r.gap === undefined)).slice(
    0,
    PREVIEW_ROWS
  );
  const totalLines = diff.rows.filter((r) => r.gap === undefined).length;

  const root = el("div", "diff diff-preview");
  root.title = "Click to view the full diff";
  root.appendChild(diffHead(diff, isNewFileDiff(diff) ? "new file" : undefined));
  root.appendChild(diffBody(diff, shown));
  const more = totalLines - shown.length;
  root.appendChild(
    el("div", "diff-more", more > 0 ? `+${more} more line${more === 1 ? "" : "s"} — click to expand` : "click to expand")
  );
  root.onclick = () => showDiffSheet(diff);
  return root;
}

function showDiffSheet(diff: DiffData) {
  const sheet = openSheet();
  sheet.classList.add("sheet-xl");
  // One bar only: path, tag, and +/− stats all live in the sheet head.
  const head = sheetHead(sheet, diff.path);
  const stat = el("span", "diff-stat sheet-stat");
  if (isNewFileDiff(diff)) stat.appendChild(el("span", "diff-tag", "new file"));
  if (diff.addCount) stat.appendChild(el("span", "stat-add", `+${diff.addCount}`));
  if (diff.delCount) stat.appendChild(el("span", "stat-del", `−${diff.delCount}`));
  head.insertBefore(stat, head.lastChild);
  const body = el("div", "code-body");
  body.appendChild(diffBody(diff, diff.rows));
  if (diff.truncated) body.appendChild(el("div", "diff-trunc", "… diff truncated"));
  sheet.appendChild(body);
}
function gutter(n?: number): HTMLElement {
  return el("span", "diff-gutter", n ? String(n) : "");
}
function codeCell(text: string | undefined, type: string | undefined, lang?: string): HTMLElement {
  const cell = el("span", "diff-code " + (type ? "c-" + type : "c-empty"));
  if (text !== undefined) cell.innerHTML = highlightLine(text, lang) || "&nbsp;";
  return cell;
}

// ---------- Live tool output (stdout / explore progress) ----------
// Full text lives here; the card shows a non-scrollable tail. Click → sheet.
const toolOutputs = new Map<string, string>();
const OUTPUT_PREVIEW_LINES = 8;
const OUTPUT_KEEP_CHARS = 200_000;

function appendToolOutput(id: string, delta: string) {
  const wrap = toolCards.get(id);
  if (!wrap) return;
  let full = (toolOutputs.get(id) ?? "") + delta;
  if (full.length > OUTPUT_KEEP_CHARS) full = full.slice(-OUTPUT_KEEP_CHARS);
  toolOutputs.set(id, full);
  let box = wrap.querySelector(".tool-output") as HTMLElement | null;
  if (!box) {
    box = el("div", "tool-output");
    box.title = "Click to view the full output";
    box.onclick = () => showOutputSheet(id);
    wrap.appendChild(box);
  }
  const lines = full.replace(/\n+$/, "").split("\n");
  box.textContent = lines.slice(-OUTPUT_PREVIEW_LINES).join("\n");
  box.dataset.more = lines.length > OUTPUT_PREVIEW_LINES ? "1" : "";
  scrollToBottom();
}

function showOutputSheet(id: string) {
  const text = toolOutputs.get(id);
  if (!text) return;
  const sheet = openSheet();
  sheet.classList.add("sheet-xl");
  sheetHead(sheet, "Output");
  const body = el("div", "code-body");
  const pre = el("pre", "code-full output-full");
  pre.textContent = text;
  body.appendChild(pre);
  sheet.appendChild(body);
}

function addStatus(message: string) {
  messagesEl.appendChild(el("div", "status-line", message));
  scrollToBottom();
}
function addError(message: string) {
  currentAssistant = null;
  const e = el("div", "error-line enter");
  e.appendChild(el("span", "error-badge", "Error"));
  e.appendChild(el("span", undefined, message));
  messagesEl.appendChild(e);
  scrollToBottom();
}

// ---------- Approvals ----------
function showApproval(p: ApprovalPayload) {
  approvalEl.innerHTML = "";
  const card = el("div", "approval-card enter");
  const head = el("div", "approval-head");
  head.appendChild(el("span", "approval-title", p.title));
  head.appendChild(el("span", "approval-kind", p.kind));
  card.appendChild(head);
  card.appendChild(el("div", "approval-subject", p.subject));
  if (p.diffs && p.diffs.length) {
    // Multi-file patch: one compact preview per file, each expandable.
    const list = el("div", "approval-diffs");
    for (const d of p.diffs) list.appendChild(renderDiffPreview(d));
    card.appendChild(list);
  } else if (p.diff && p.diff.rows.length) {
    card.appendChild(renderDiffPreview(p.diff));
  } else if (p.detail) {
    const detail = p.detail;
    const pre = el("pre", "approval-detail");
    pre.textContent = detail;
    pre.title = "Click to view in full";
    pre.onclick = () => {
      const sheet = openSheet();
      sheet.classList.add("sheet-xl");
      sheetHead(sheet, p.subject);
      const body = el("div", "code-body");
      const full = el("pre", "code-full output-full");
      full.textContent = detail;
      body.appendChild(full);
      sheet.appendChild(body);
    };
    card.appendChild(pre);
  }
  const actions = el("div", "approval-actions");
  const reject = el("button", "btn btn-reject", "Reject");
  const approve = el("button", "btn btn-approve", "Approve");
  const always = el("button", "btn btn-always", "Always");
  reject.onclick = () => respond(p.id, "rejected");
  approve.onclick = () => respond(p.id, "approved");
  always.onclick = () => respond(p.id, "approved-always");
  actions.appendChild(reject);
  actions.appendChild(always);
  actions.appendChild(approve);
  card.appendChild(actions);
  approvalEl.appendChild(card);
  scrollToBottom();
}
function respond(id: string, decision: "approved" | "rejected" | "approved-always") {
  post({ type: "approvalResponse", id, decision });
  approvalEl.innerHTML = "";
}
// ---------- Overlay: sessions ----------
function hideOverlay() {
  overlayEl.classList.add("hidden");
  overlayEl.innerHTML = "";
  settingsWanted = false;
}
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function openSheet(): HTMLElement {
  overlayEl.innerHTML = "";
  const sheet = el("div", "sheet enter");
  overlayEl.appendChild(sheet);
  overlayEl.classList.remove("hidden");
  return sheet;
}
function sheetHead(sheet: HTMLElement, title: string) {
  const head = el("div", "sheet-head");
  head.appendChild(el("span", "sheet-title", title));
  const close = el("button", "icon-btn", "✕");
  close.onclick = hideOverlay;
  head.appendChild(close);
  sheet.appendChild(head);
  return head;
}
function showSessionList(
  sessions: { id: string; title: string; updatedAt: number }[],
  currentId?: string
) {
  const sheet = openSheet();
  sheetHead(sheet, "Sessions");
  if (sessions.length === 0) {
    sheet.appendChild(el("div", "sheet-empty", "No saved sessions yet."));
    return;
  }
  const list = el("div", "session-list");
  for (const s of sessions) {
    const row = el("div", "session-row" + (s.id === currentId ? " current" : ""));
    const main = el("div", "session-main");
    main.appendChild(el("div", "session-title", s.title || "Untitled"));
    main.appendChild(el("div", "session-time", relativeTime(s.updatedAt)));
    main.onclick = () => {
      post({ type: "loadSession", id: s.id });
      hideOverlay();
    };
    const del = el("button", "session-del", "🗑");
    del.title = "Delete session";
    del.onclick = (e) => {
      e.stopPropagation();
      post({ type: "deleteSession", id: s.id });
    };
    row.appendChild(main);
    row.appendChild(del);
    list.appendChild(row);
  }
  sheet.appendChild(list);
}

// ---------- Overlay: usage analytics ----------
function fmtCost(n: number): string {
  if (n >= 100) return "$" + n.toFixed(2);
  if (n >= 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(4);
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function fmtLines(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

// Distinct, on-theme colors assigned to models by rank (highest cost first).
const MODEL_PALETTE = [
  "#a78bfa",
  "#22d3ee",
  "#f59e0b",
  "#ec4899",
  "#4ade80",
  "#60a5fa",
  "#fb7185",
  "#facc15",
  "#34d399",
  "#c084fc",
];
const OVERFLOW_COLOR = "#6f6790";

function colorMap(models: ModelPoint[]): Map<string, string> {
  const m = new Map<string, string>();
  models.forEach((mp, i) => {
    m.set(mp.model, i < MODEL_PALETTE.length ? MODEL_PALETTE[i] : OVERFLOW_COLOR);
  });
  return m;
}

// Stacked bar chart: each day's column is split into per-model segments, in the
// same (global) model order every day so the bands read consistently over time.
function stackedChart(
  daily: DailyPoint[],
  models: ModelPoint[],
  metric: "cost" | "tokens" | "lines",
  fmt: (n: number) => string,
  colors: Map<string, string>
): string {
  const w = 520;
  const h = 96;
  const n = Math.max(daily.length, 1);
  const bw = w / n;
  const dayTotal = (d: DailyPoint) =>
    metric === "cost" ? d.cost : metric === "tokens" ? d.prompt + d.completion : d.linesAdded;
  const cellVal = (c: { cost: number; tokens: number; added: number }) =>
    metric === "cost" ? c.cost : metric === "tokens" ? c.tokens : c.added;
  const max = Math.max(...daily.map(dayTotal), 1e-9);
  let out = "";
  daily.forEach((d, i) => {
    const x = i * bw;
    // Transparent hit area first (behind segments) → whole-day total tooltip.
    out +=
      `<rect x="${x.toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${h}" fill="transparent">` +
      `<title>${shortDate(d.date)} · ${fmt(dayTotal(d))}</title></rect>`;
    let yTop = h;
    for (const mp of models) {
      const cell = d.models[mp.model];
      if (!cell) continue;
      const v = cellVal(cell);
      if (v <= 0) continue;
      const segH = (v / max) * h;
      yTop -= segH;
      out +=
        `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${Math.max(0.6, bw - 0.8).toFixed(2)}" ` +
        `height="${segH.toFixed(2)}" fill="${colors.get(mp.model) ?? OVERFLOW_COLOR}">` +
        `<title>${shortDate(d.date)} · ${mp.model} · ${fmt(v)}</title></rect>`;
    }
  });
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none">${out}</svg>`;
}

function showUsage(report: UsageReport) {
  // Reuse the open window if present — only swap the body so changing the period
  // doesn't close/reopen (and re-animate) the whole sheet.
  let sheet = overlayEl.querySelector(".usage-sheet") as HTMLElement | null;
  if (!sheet) {
    sheet = openSheet();
    sheet.classList.add("sheet-wide", "usage-sheet");
    const head = sheetHead(sheet, "Usage & Cost");
    const seg = el("div", "seg");
    for (const d of [30, 60, 90]) {
      const b = el("button", "seg-btn", `${d}d`);
      b.dataset.days = String(d);
      b.onclick = () => {
        usageDays = d;
        post({ type: "getUsage", days: d });
      };
      seg.appendChild(b);
    }
    head.insertBefore(seg, head.lastChild);
  }
  // Reflect the active period from the report itself.
  sheet.querySelectorAll(".seg-btn").forEach((b) => {
    const btn = b as HTMLElement;
    btn.classList.toggle("active", Number(btn.dataset.days) === report.days);
  });

  // Swap just the body.
  sheet.querySelector(".usage-body")?.remove();
  const body = el("div", "usage-body");

  // stat cards
  const stats = el("div", "stat-row");
  stats.appendChild(statCard("Total cost", fmtCost(report.totalCost), "accent"));
  stats.appendChild(statCard("Tokens", fmtTokens(report.totalPrompt + report.totalCompletion)));
  const hit =
    report.totalPrompt > 0 ? Math.round((report.totalCached / report.totalPrompt) * 100) : 0;
  stats.appendChild(statCard("Cache hit", hit + "%", "green"));
  stats.appendChild(statCard("Lines written", fmtLines(report.totalLinesAdded), "accent"));
  stats.appendChild(statCard("Turns", String(report.turns)));
  body.appendChild(stats);

  const dates = report.daily.map((d) => d.date);
  const colors = colorMap(report.byModel);
  // daily cost chart (stacked by model)
  body.appendChild(
    chartBlock(
      `Daily cost · last ${report.days} days`,
      stackedChart(report.daily, report.byModel, "cost", fmtCost, colors),
      dates
    )
  );
  // daily tokens chart (stacked by model)
  body.appendChild(
    chartBlock(
      "Daily tokens",
      stackedChart(report.daily, report.byModel, "tokens", fmtTokens, colors),
      dates
    )
  );
  // daily lines-written chart (stacked by model)
  body.appendChild(
    chartBlock(
      "Daily lines written",
      stackedChart(report.daily, report.byModel, "lines", fmtLines, colors),
      dates
    )
  );

  // model breakdown — doubles as the chart legend (color swatches match bands).
  const modelWrap = el("div", "chart-block");
  modelWrap.appendChild(el("div", "block-label", "By model"));
  if (report.byModel.length === 0) {
    modelWrap.appendChild(el("div", "sheet-empty", "No usage recorded yet."));
  } else {
    const maxCost = Math.max(...report.byModel.map((m) => m.cost), 1e-9);
    for (const m of report.byModel) {
      const color = colors.get(m.model) ?? OVERFLOW_COLOR;
      const row = el("div", "model-row");
      const top = el("div", "model-top");
      const nameWrap = el("div", "model-name-wrap");
      const swatch = el("span", "model-swatch");
      swatch.style.background = color;
      nameWrap.appendChild(swatch);
      nameWrap.appendChild(el("span", "model-name", m.model));
      top.appendChild(nameWrap);
      top.appendChild(el("span", "model-cost", fmtCost(m.cost)));
      row.appendChild(top);
      const track = el("div", "model-track");
      const fill = el("div", "model-fill");
      fill.style.width = Math.max(2, (m.cost / maxCost) * 100) + "%";
      fill.style.background = color;
      track.appendChild(fill);
      row.appendChild(track);
      const lines = m.linesAdded || m.linesRemoved
        ? ` · +${fmtLines(m.linesAdded)}/−${fmtLines(m.linesRemoved)} lines`
        : "";
      row.appendChild(
        el("div", "model-sub", `${fmtTokens(m.tokens)} tokens · ${m.count} turns${lines}`)
      );
      modelWrap.appendChild(row);
    }
  }
  body.appendChild(modelWrap);

  sheet.appendChild(body);
}
function statCard(label: string, value: string, accent?: string): HTMLElement {
  const c = el("div", "stat-card");
  c.appendChild(el("div", "stat-value" + (accent ? " " + accent : ""), value));
  c.appendChild(el("div", "stat-label", label));
  return c;
}
function chartBlock(label: string, svg: string, dates: string[], variant?: string): HTMLElement {
  const b = el("div", "chart-block");
  b.appendChild(el("div", "block-label", label));
  const holder = el("div", "chart-holder" + (variant ? " " + variant : ""));
  holder.innerHTML = svg;
  b.appendChild(holder);
  // x-axis: start / middle / end date labels
  if (dates.length) {
    const axis = el("div", "chart-axis");
    const mid = dates[Math.floor(dates.length / 2)];
    axis.appendChild(el("span", undefined, shortDate(dates[0])));
    axis.appendChild(el("span", undefined, shortDate(mid)));
    axis.appendChild(el("span", undefined, shortDate(dates[dates.length - 1])));
    b.appendChild(axis);
  }
  return b;
}

// ---------- Overlay: settings ----------

/** Post a single setting write; the host echoes back validated settingsData. */
function saveSetting<K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]) {
  post({ type: "updateSetting", key, value });
}

function setGroup(title: string): HTMLElement {
  const g = el("div", "set-group");
  g.appendChild(el("div", "set-group-title", title));
  return g;
}

function setRow(label: string, hint: string | undefined, control: HTMLElement): HTMLElement {
  const row = el("div", "set-row");
  const meta = el("div", "set-meta");
  meta.appendChild(el("label", "set-label", label));
  if (hint) meta.appendChild(el("div", "set-hint", hint));
  row.appendChild(meta);
  const ctl = el("div", "set-control");
  ctl.appendChild(control);
  row.appendChild(ctl);
  return row;
}

function textSetting(
  key: keyof SettingsPayload,
  value: string,
  placeholder?: string
): HTMLInputElement {
  const input = el("input", "set-input") as HTMLInputElement;
  input.type = "text";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  input.dataset.setting = key;
  input.onchange = () => saveSetting(key, input.value.trim() as any);
  return input;
}

function numberSetting(
  key: keyof SettingsPayload,
  value: number,
  opts: { min?: number; max?: number; step?: number } = {}
): HTMLInputElement {
  const input = el("input", "set-input set-num") as HTMLInputElement;
  input.type = "number";
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  if (opts.step !== undefined) input.step = String(opts.step);
  input.value = String(value);
  input.dataset.setting = key;
  input.onchange = () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) saveSetting(key, n as any);
  };
  return input;
}

function toggleSetting(key: keyof SettingsPayload, value: boolean): HTMLElement {
  const wrap = el("label", "set-toggle");
  const input = el("input") as HTMLInputElement;
  input.type = "checkbox";
  input.checked = value;
  input.dataset.setting = key;
  input.onchange = () => saveSetting(key, input.checked as any);
  wrap.appendChild(input);
  wrap.appendChild(el("span", "set-toggle-track"));
  return wrap;
}

function selectSetting(
  key: keyof SettingsPayload,
  value: string,
  options: { value: string; label: string }[]
): HTMLSelectElement {
  const sel = el("select", "set-input set-select") as HTMLSelectElement;
  for (const o of options) {
    const opt = el("option", undefined, o.label) as HTMLOptionElement;
    opt.value = o.value;
    sel.appendChild(opt);
  }
  sel.value = value;
  sel.dataset.setting = key;
  sel.onchange = () => saveSetting(key, sel.value as any);
  return sel;
}

function listSetting(key: keyof SettingsPayload, values: string[]): HTMLTextAreaElement {
  const ta = el("textarea", "set-input set-list") as HTMLTextAreaElement;
  ta.rows = Math.min(8, Math.max(3, values.length + 1));
  ta.value = values.join("\n");
  ta.dataset.setting = key;
  ta.onchange = () =>
    saveSetting(
      key,
      ta.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean) as any
    );
  return ta;
}

function sliderSetting(
  key: keyof SettingsPayload,
  value: number,
  min: number,
  max: number,
  step: number,
  fmt: (n: number) => string
): HTMLElement {
  const wrap = el("div", "set-slider");
  const input = el("input") as HTMLInputElement;
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.dataset.setting = key;
  const label = el("span", "set-slider-val", fmt(value));
  input.oninput = () => (label.textContent = fmt(Number(input.value)));
  input.onchange = () => saveSetting(key, Number(input.value) as any);
  wrap.appendChild(input);
  wrap.appendChild(label);
  return wrap;
}

function showSettings(s: SettingsPayload) {
  // If the sheet is already open (host echoed after a save), refresh values in
  // place — but never clobber the control the user is currently editing.
  const existing = overlayEl.querySelector(".settings-sheet") as HTMLElement | null;
  if (existing) {
    existing.querySelectorAll<HTMLElement>("[data-setting]").forEach((elm) => {
      if (elm === document.activeElement) return;
      const key = elm.dataset.setting as keyof SettingsPayload;
      const v = s[key];
      if (elm instanceof HTMLInputElement) {
        if (elm.type === "checkbox") elm.checked = Boolean(v);
        else elm.value = String(v);
      } else if (elm instanceof HTMLSelectElement) {
        elm.value = String(v);
      } else if (elm instanceof HTMLTextAreaElement) {
        elm.value = Array.isArray(v) ? v.join("\n") : String(v);
      }
    });
    return;
  }
  // Unsolicited broadcast (config changed elsewhere) with no sheet open: ignore.
  if (!settingsWanted) return;

  const sheet = openSheet();
  sheet.classList.add("sheet-wide", "settings-sheet");
  sheetHead(sheet, "Settings");
  const body = el("div", "settings-body");

  // --- Models ---
  const models = setGroup("Models");
  const modelInput = textSetting("model", s.model, "vendor/model-id");
  const modelWrap = el("div", "set-inline");
  modelWrap.appendChild(modelInput);
  const browse = el("button", "btn set-browse", "Browse…");
  browse.onclick = () => post({ type: "selectModel" });
  modelWrap.appendChild(browse);
  models.appendChild(setRow("Model", "OpenRouter model id for coding turns.", modelWrap));
  models.appendChild(
    setRow(
      "Summarizer model",
      "Cheap model that writes checkpoint summaries during compaction. Empty = use the main model.",
      textSetting("summarizerModel", s.summarizerModel, "same as model")
    )
  );
  models.appendChild(
    setRow(
      "Explore model",
      "Model for the research sub-agent (explore tool). Fast + cheap works well. Empty = use the main model.",
      textSetting("subagentModel", s.subagentModel, "same as model")
    )
  );
  models.appendChild(
    setRow(
      "Fallback models",
      "One per line, tried in order when the primary model errors or is rate-limited.",
      listSetting("fallbackModels", s.fallbackModels)
    )
  );
  body.appendChild(models);

  // --- Context & cost ---
  const ctx = setGroup("Context & Cost");
  ctx.appendChild(
    setRow(
      "Context budget (tokens)",
      "Compaction trigger. 0 = auto: sized from the model's context window and price.",
      numberSetting("maxContextTokens", s.maxContextTokens, { min: 0, step: 1000 })
    )
  );
  ctx.appendChild(
    setRow(
      "Target carry cost ($/call)",
      "Auto-budget goal: max cost of one fully-cached context pass. Lower = smaller context on expensive models.",
      numberSetting("autoBudgetCarryCostUsd", s.autoBudgetCarryCostUsd, {
        min: 0.01,
        max: 2,
        step: 0.01,
      })
    )
  );
  ctx.appendChild(
    setRow(
      "Compaction floor",
      "Each compaction event shrinks the context to this fraction of the budget. Lower = rarer compactions.",
      sliderSetting("compactionTargetRatio", s.compactionTargetRatio, 0.2, 0.8, 0.05, (n) =>
        Math.round(n * 100) + "%"
      )
    )
  );
  ctx.appendChild(
    setRow(
      "Prompt caching",
      "Cache-control breakpoints on stable prefixes (large cost saver — leave on).",
      toggleSetting("enablePromptCaching", s.enablePromptCaching)
    )
  );
  ctx.appendChild(
    setRow(
      "Pre-warm cache",
      "Write the prompt cache when a session opens so your first message starts warm (one small extra request).",
      toggleSetting("prewarmCache", s.prewarmCache)
    )
  );
  ctx.appendChild(
    setRow(
      "Session budget ($)",
      "Pause and ask when a session's total cost crosses this (even in Auto mode). 0 = off.",
      numberSetting("sessionBudgetUsd", s.sessionBudgetUsd, { min: 0, step: 0.5 })
    )
  );
  body.appendChild(ctx);

  // --- Agent behavior ---
  const beh = setGroup("Agent Behavior");
  beh.appendChild(
    setRow(
      "Include active file",
      "Attach the file (and selection) you're looking at to each message.",
      toggleSetting("includeActiveFile", s.includeActiveFile)
    )
  );
  beh.appendChild(
    setRow(
      "Format after edit",
      "Run the workspace formatter on files the agent edits.",
      toggleSetting("formatAfterEdit", s.formatAfterEdit)
    )
  );
  beh.appendChild(
    setRow(
      "Worktree sandbox",
      "Agent works in a separate git worktree; merge or discard via the command palette. (Dependencies aren't installed there.)",
      toggleSetting("worktreeMode", s.worktreeMode)
    )
  );
  const cmdTa = el("textarea", "set-input set-list set-json") as HTMLTextAreaElement;
  cmdTa.rows = 5;
  cmdTa.value = s.customCommandsJson;
  cmdTa.dataset.setting = "customCommandsJson";
  cmdTa.spellcheck = false;
  cmdTa.onchange = () => saveSetting("customCommandsJson", cmdTa.value);
  beh.appendChild(
    setRow(
      "Custom slash commands (JSON)",
      'e.g. {"deploy": "Run the deploy checklist: …"} makes /deploy expand to that prompt. Built-ins: /commit /review /tests.',
      cmdTa
    )
  );
  body.appendChild(beh);

  // --- Generation ---
  const gen = setGroup("Generation");
  gen.appendChild(
    setRow(
      "Max output tokens",
      "Per-turn generation cap. 0 = model's full output limit (recommended).",
      numberSetting("maxTokens", s.maxTokens, { min: 0, step: 512 })
    )
  );
  gen.appendChild(
    setRow(
      "Temperature",
      "0 is best for deterministic agentic coding.",
      numberSetting("temperature", s.temperature, { min: 0, max: 2, step: 0.1 })
    )
  );
  gen.appendChild(
    setRow(
      "Default mode",
      "Mode new sessions start in.",
      selectSetting("defaultMode", s.defaultMode, [
        { value: "standard", label: "Standard — approve each action" },
        { value: "auto", label: "Auto — fully autonomous" },
        { value: "plan", label: "Plan — read-only" },
      ])
    )
  );
  body.appendChild(gen);

  // --- Privacy ---
  const priv = setGroup("Privacy");
  priv.appendChild(
    setRow(
      "Data collection",
      "Deny routes only to providers that don't store or train on prompts.",
      selectSetting("dataCollection", s.dataCollection, [
        { value: "deny", label: "Deny (recommended)" },
        { value: "allow", label: "Allow all providers" },
      ])
    )
  );
  priv.appendChild(
    setRow(
      "Zero data retention",
      "Stricter: only ZDR endpoints. May reduce provider availability.",
      toggleSetting("zeroDataRetention", s.zeroDataRetention)
    )
  );
  priv.appendChild(
    setRow(
      "Provider sort",
      "Throughput/latency avoid slow providers (fewer upstream idle timeouts) but may cost more per token.",
      selectSetting("providerSort", s.providerSort, [
        { value: "throughput", label: "Throughput — fastest generation (recommended)" },
        { value: "latency", label: "Latency — fastest first token" },
        { value: "price", label: "Price — cheapest provider" },
        { value: "default", label: "Default — load-balanced" },
      ])
    )
  );
  body.appendChild(priv);

  // --- Commands ---
  const cmds = setGroup("Commands");
  cmds.appendChild(
    setRow(
      "Auto-approve prefixes",
      "One per line. Commands starting with these run without prompting, even in Standard mode.",
      listSetting("autoApproveCommands", s.autoApproveCommands)
    )
  );
  cmds.appendChild(
    setRow(
      "Always-deny prefixes",
      "One per line. Hard-blocked in every mode, including Auto.",
      listSetting("alwaysDenyCommands", s.alwaysDenyCommands)
    )
  );
  body.appendChild(cmds);

  // --- MCP servers ---
  const mcp = setGroup("MCP Servers");
  const mcpTa = el("textarea", "set-input set-list set-json") as HTMLTextAreaElement;
  mcpTa.rows = 8;
  mcpTa.value = s.mcpServersJson;
  mcpTa.dataset.setting = "mcpServersJson";
  mcpTa.spellcheck = false;
  mcpTa.onchange = () => saveSetting("mcpServersJson", mcpTa.value);
  mcp.appendChild(
    setRow(
      "Servers (JSON)",
      'stdio MCP servers, e.g. {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": "…"}}}. Their tools appear to the agent as mcp__<server>__<tool>; Standard mode asks before each call.',
      mcpTa
    )
  );
  body.appendChild(mcp);

  // --- Connection ---
  const conn = setGroup("Connection");
  conn.appendChild(
    setRow(
      "API base URL",
      "Override only if you proxy OpenRouter.",
      textSetting("baseUrl", s.baseUrl)
    )
  );
  const keyBtn = el("button", "btn set-browse", "Set API key…");
  keyBtn.onclick = () => post({ type: "setApiKey" });
  conn.appendChild(setRow("OpenRouter API key", "Stored in VS Code secret storage.", keyBtn));
  body.appendChild(conn);

  sheet.appendChild(body);
}

// ---------- Task checklist ----------
let tasksCollapsed = false;
let currentTasks: TaskItem[] = [];
const STATUS_RANK: Record<TaskItem["status"], number> = { pending: 0, active: 1, done: 2 };

/** Guard against status regression: models sometimes re-send the plan with
 * completed steps reset to pending. When the incoming list is mostly the same
 * plan (labels overlap), each task keeps its most-advanced status. A mostly
 * new plan replaces outright. */
function mergeTasks(next: TaskItem[]): TaskItem[] {
  if (!currentTasks.length || !next.length) return next;
  const prev = new Map(currentTasks.map((t) => [t.label, t.status]));
  const overlap = next.filter((t) => prev.has(t.label)).length;
  if (overlap / next.length < 0.6) return next;
  return next.map((t) => {
    const old = prev.get(t.label);
    return old && STATUS_RANK[old] > STATUS_RANK[t.status] ? { ...t, status: old } : t;
  });
}
function renderTasks(tasks: TaskItem[]) {
  if (!tasks.length) {
    tasksEl.classList.add("hidden");
    tasksEl.innerHTML = "";
    return;
  }
  tasksEl.classList.remove("hidden");
  tasksEl.classList.toggle("collapsed", tasksCollapsed);
  tasksEl.innerHTML = "";
  const done = tasks.filter((t) => t.status === "done").length;
  const active = tasks.find((t) => t.status === "active");
  const head = el("div", "tasks-head");
  head.appendChild(el("span", "tasks-chevron", tasksCollapsed ? "▸" : "▾"));
  head.appendChild(
    el(
      "span",
      undefined,
      `Plan · ${done}/${tasks.length}` +
        (tasksCollapsed && active ? ` — ${active.label}` : "")
    )
  );
  head.title = tasksCollapsed ? "Expand plan" : "Collapse plan";
  head.onclick = () => {
    tasksCollapsed = !tasksCollapsed;
    renderTasks(tasks);
  };
  tasksEl.appendChild(head);
  if (!tasksCollapsed) {
    for (const t of tasks) {
      const row = el("div", "task " + t.status);
      row.appendChild(
        el("span", "task-icon", t.status === "done" ? "✓" : t.status === "active" ? "›" : "○")
      );
      row.appendChild(el("span", "task-label", t.label));
      tasksEl.appendChild(row);
    }
  }
}

// ---------- Overlay: turn diff review ----------
function showTurnDiff(diffs: DiffData[]) {
  const sheet = openSheet();
  sheet.classList.add("sheet-wide");
  const head = sheetHead(sheet, "Changes · last turn");
  if (diffs.length) {
    const commit = el("button", "btn set-browse", "Commit these changes");
    commit.title = "git add the changed files and commit with a generated message";
    commit.onclick = () => {
      post({ type: "commitTurn" });
      hideOverlay();
    };
    head.insertBefore(commit, head.lastChild);
  }
  const body = el("div", "usage-body");
  if (!diffs.length) {
    body.appendChild(el("div", "sheet-empty", "No file changes recorded for the last turn."));
  }
  for (const d of diffs) {
    // renderDiff's own header already carries the path and +/− stats.
    const block = el("div", "chart-block");
    block.appendChild(renderDiff(d, false));
    body.appendChild(block);
  }
  sheet.appendChild(body);
}

// ---------- Overlay: context inspector ----------
function showContextInfo(info: ContextInfo) {
  const sheet = openSheet();
  sheet.classList.add("sheet-wide");
  sheetHead(sheet, "Context Window");
  const body = el("div", "usage-body");
  const stats = el("div", "stat-row");
  stats.appendChild(statCard("In context", fmtTokens(info.totalTokens)));
  stats.appendChild(statCard("Budget", fmtTokens(info.budget)));
  const pct = info.budget > 0 ? Math.round((info.totalTokens / info.budget) * 100) : 0;
  stats.appendChild(statCard("Used", pct + "%", pct > 80 ? "accent" : undefined));
  if (info.nextCallCostUsd !== undefined) {
    stats.appendChild(statCard("Next call (cached)", fmtCost(info.nextCallCostUsd), "green"));
  }
  stats.appendChild(statCard("Messages", String(info.messageCount)));
  body.appendChild(stats);
  body.appendChild(
    el(
      "div",
      "block-label",
      `System prompt ~${fmtTokens(info.systemTokens)} tokens${info.hasMemory ? " · includes LUNA.md project memory" : ""}`
    )
  );
  if (info.largest.length) {
    body.appendChild(el("div", "block-label", "Largest items in context"));
    for (const m of info.largest) {
      const row = el("div", "ctx-item");
      row.appendChild(el("span", "ctx-role", m.role));
      row.appendChild(el("span", "ctx-preview", m.preview || "(tool payload)"));
      row.appendChild(el("span", "ctx-tokens", fmtTokens(m.tokens)));
      body.appendChild(row);
    }
    body.appendChild(
      el(
        "div",
        "set-hint",
        "Every API call re-reads everything above (cached reads ≈ 10% of input price). Compaction trims it automatically at the budget."
      )
    );
  }
  sheet.appendChild(body);
}

// ---------- Rollback (retry / edit-and-resend) ----------
function rollbackDom() {
  const users = messagesEl.querySelectorAll(".msg.user");
  const last = users[users.length - 1];
  if (!last) return;
  let node: Element | null = last;
  const toRemove: Element[] = [];
  while (node) {
    toRemove.push(node);
    node = node.nextElementSibling;
  }
  toRemove.forEach((n) => n.remove());
  currentAssistant = null;
  turnsCompleted = Math.max(0, turnsCompleted - 1);
  updateMeter();
}

// ---------- @-file mentions ----------
let mentionToken = 0;
let mentionActive = false;
let mentionItems: string[] = [];
let mentionSel = 0;
let mentionStart = -1; // index of "@" (file mode) — command mode inserts at 0
let mentionMode: "file" | "command" = "file";
let mentionTimer: ReturnType<typeof setTimeout> | undefined;

function updateMention() {
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const upto = inputEl.value.slice(0, caret);

  // Slash commands: "/" at the very start of the message.
  const cmd = /^\/([a-zA-Z0-9_-]*)$/.exec(upto);
  if (cmd && state.commands.length) {
    mentionMode = "command";
    mentionStart = 0;
    const q = cmd[1].toLowerCase();
    renderMention(
      state.commands.filter((c) => c.toLowerCase().startsWith(q)).map((c) => "/" + c)
    );
    return;
  }

  const m = /(^|\s)@([\w./\\-]*)$/.exec(upto);
  if (!m) {
    closeMention();
    return;
  }
  mentionMode = "file";
  mentionStart = caret - m[2].length - 1;
  const query = m[2];
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => {
    post({ type: "queryFiles", query, token: ++mentionToken });
  }, 120);
}

function closeMention() {
  mentionActive = false;
  mentionEl.classList.add("hidden");
  mentionEl.innerHTML = "";
}

function renderMention(files: string[]) {
  mentionItems = files;
  mentionSel = 0;
  if (!files.length) {
    closeMention();
    return;
  }
  mentionActive = true;
  mentionEl.classList.remove("hidden");
  mentionEl.innerHTML = "";
  files.forEach((f, i) => {
    const row = el("div", "mention-item" + (i === mentionSel ? " sel" : ""), f);
    // mousedown (not click) so the textarea doesn't lose focus first.
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickMention(i);
    });
    mentionEl.appendChild(row);
  });
}

function moveMention(delta: number) {
  if (!mentionItems.length) return;
  mentionSel = (mentionSel + delta + mentionItems.length) % mentionItems.length;
  mentionEl.querySelectorAll(".mention-item").forEach((n, i) => {
    n.classList.toggle("sel", i === mentionSel);
    if (i === mentionSel) (n as HTMLElement).scrollIntoView({ block: "nearest" });
  });
}

function pickMention(i: number) {
  const item = mentionItems[i];
  if (item === undefined || mentionStart < 0) return;
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  // Command mode items already include the slash and replace from position 0.
  inputEl.value = inputEl.value.slice(0, mentionStart) + item + " " + inputEl.value.slice(caret);
  const pos = mentionStart + item.length + 1;
  inputEl.setSelectionRange(pos, pos);
  closeMention();
  autosize();
  inputEl.focus();
}

// ---------- Image paste ----------
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
let pendingImages: string[] = []; // data URLs

function renderAttachments() {
  attachEl.innerHTML = "";
  if (!pendingImages.length) {
    attachEl.classList.add("hidden");
    return;
  }
  attachEl.classList.remove("hidden");
  pendingImages.forEach((url, i) => {
    const chip = el("div", "attach-chip");
    const img = el("img") as HTMLImageElement;
    img.src = url;
    chip.appendChild(img);
    const x = el("button", "attach-x", "✕");
    x.title = "Remove image";
    x.onclick = () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    };
    chip.appendChild(x);
    attachEl.appendChild(chip);
  });
}

inputEl.addEventListener("paste", (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    e.preventDefault();
    if (pendingImages.length >= MAX_IMAGES) {
      addStatus(`Up to ${MAX_IMAGES} images per message.`);
      return;
    }
    const file = item.getAsFile();
    if (!file) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      addStatus("Image too large (max 3 MB). Resize and paste again.");
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingImages.push(String(reader.result));
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
});

// ---------- Meter ----------
function updateMeter() {
  const parts: string[] = [];
  parts.push(
    `<span class="meter-session" role="button" title="What's in the context window right now (click)">◆ ${fmtCost(sessionUsage.cost)}</span>`
  );
  if (lastTurnUsage) {
    const { promptTokens, completionTokens, cachedTokens } = lastTurnUsage;
    const hit = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
    parts.push(`↑${fmtTokens(promptTokens)} ↓${fmtTokens(completionTokens)}`);
    parts.push(`<span class="meter-cache">cache ${hit}%</span>`);
  }
  if (sessionUsage.compactions) {
    const saved = sessionUsage.tokensSaved ?? 0;
    parts.push(
      `<span class="meter-cache">⇣${sessionUsage.compactions} compaction${
        sessionUsage.compactions > 1 ? "s" : ""
      }${saved > 0 ? ` · ~${fmtTokens(saved)} saved` : ""}</span>`
    );
  }
  if (lastUsageAt) {
    const warm = Date.now() - lastUsageAt < CACHE_TTL_MS;
    parts.push(
      `<span class="cache-dot ${warm ? "warm" : "cold"}" title="${
        warm
          ? "Prompt cache is warm — your next message reuses it at ~10% of input price."
          : "Prompt cache likely expired (~5 min TTL) — the next message re-writes it at full input price."
      }">●</span>`
    );
  }
  if (!state.running) {
    parts.push(
      `<span class="revert-chip actions-chip" role="button" title="Actions">⋯</span>`
    );
  }
  meterEl.innerHTML = parts.join(" · ");
}

// ---------- Mode bar ----------
function renderModeBar() {
  modeBarEl.innerHTML = "";
  for (const m of state.modes) {
    const btn = el("button", "mode-btn" + (m.id === state.mode ? " active" : ""), m.label);
    btn.title = m.description;
    btn.onclick = () => post({ type: "setMode", mode: m.id as any });
    modeBarEl.appendChild(btn);
  }
}
function renderModel() {
  modelBtn.textContent = state.model || "Select model";
}
function renderApiKeyNotice() {
  const wrap = el("div", "welcome enter");
  wrap.innerHTML = `
    <div class="welcome-logo"></div>
    <h2>Welcome to Luna Code</h2>
    <p>An agentic coding assistant powered by OpenRouter. Add your API key to begin.</p>
  `;
  const btn = el("button", "btn btn-approve big", "Set OpenRouter API Key");
  btn.onclick = () => post({ type: "setApiKey" });
  wrap.appendChild(btn);
  messagesEl.appendChild(wrap);
}

// ---------- Message handling ----------
window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      state.hasApiKey = msg.hasApiKey;
      state.model = msg.model;
      state.mode = msg.mode;
      state.modes = msg.modes;
      state.commands = msg.commands ?? [];
      renderModeBar();
      renderModel();
      updateMeter();
      if (!msg.hasApiKey) {
        messagesEl.innerHTML = "";
        renderApiKeyNotice();
      }
      break;
    case "config":
      state.hasApiKey = msg.hasApiKey;
      state.model = msg.model;
      state.mode = msg.mode;
      state.commands = msg.commands ?? state.commands;
      renderModel();
      renderModeBar();
      if (state.hasApiKey && messagesEl.querySelector(".welcome")) {
        messagesEl.innerHTML = "";
      } else if (!state.hasApiKey && !messagesEl.querySelector(".welcome")) {
        messagesEl.innerHTML = "";
        renderApiKeyNotice();
      }
      break;
    case "sessionReset":
      messagesEl.innerHTML = "";
      currentAssistant = null;
      thinking = false;
      setRunning(false);
      hideActivity();
      lastTurnUsage = null;
      turnsCompleted = 0;
      currentTasks = [];
      toolOutputs.clear();
      renderTasks([]);
      closeMention();
      updateMeter();
      if (!state.hasApiKey) renderApiKeyNotice();
      break;
    case "userEcho":
      // A queued message arrives mid-stream — don't disturb the assistant block
      // currently streaming; just append it below with a Queued tag.
      if (!msg.queued) currentAssistant = null;
      addUserMessage(msg.text, msg.queued);
      break;
    case "turnStart":
      setRunning(true);
      currentAssistant = null;
      clearQueuedTags();
      thinkCountEl.textContent = "";
      // A finished plan is stale clutter on the next turn — clear it. An
      // in-progress plan stays (the follow-up is usually continuing it), and
      // the model re-sets the widget whenever it starts a new plan.
      if (currentTasks.length && currentTasks.every((t) => t.status === "done")) {
        currentTasks = [];
        renderTasks([]);
      }
      startThink();
      startRotating();
      break;
    case "assistantText":
      // The activity bar is driven ONLY by a live turn (running). During a
      // session replay these events fire with no turn, so don't start it.
      if (state.running) {
        finishThink();
        startRotating();
      }
      appendAssistantText(msg.delta);
      break;
    case "reasoning":
      sawReasoning = true;
      break;
    case "toolStart": {
      if (state.running) {
        finishThink();
        const { verbs, target } = friendly(msg.name, msg.args);
        showActivity(target ? `${verbs[0]} ${shortTarget(target)}` : verbs[0]);
      }
      addToolStart(msg.id, msg.name, msg.args);
      break;
    }
    case "toolEnd":
      addToolEnd(msg.id, msg.name, msg.ok, msg.summary, msg.diff);
      // Back to thinking until the next text/tool/turn-end — only during a live turn.
      if (state.running) {
        startThink();
        startRotating();
      }
      break;
    case "status":
      addStatus(msg.message);
      break;
    case "usage":
      lastTurnUsage = msg.usage;
      lastUsageAt = Date.now();
      updateMeter();
      break;
    case "sessionUsage":
      sessionUsage = msg.usage;
      updateMeter();
      break;
    case "usageReport":
      showUsage(msg.report);
      break;
    case "settingsData":
      showSettings(msg.settings);
      break;
    case "checkpointState":
      checkpointTurns = msg.turns;
      checkpointFiles = msg.files;
      updateMeter();
      break;
    case "taskList": {
      const tasks = msg.tasks.length ? mergeTasks(msg.tasks) : [];
      currentTasks = tasks;
      renderTasks(tasks);
      break;
    }
    case "turnDiff":
      showTurnDiff(msg.diffs);
      break;
    case "contextInfo":
      showContextInfo(msg.info);
      break;
    case "fileMatches":
      if (msg.token === mentionToken) renderMention(msg.files);
      break;
    case "rollback":
      rollbackDom();
      break;
    case "composerFill":
      inputEl.value = msg.text;
      autosize();
      inputEl.focus();
      break;
    case "streamProgress":
      // Live counter so long silent generations (big file writes stream through
      // tool args with no visible text) don't look hung.
      if (state.running) {
        thinkCountEl.textContent = `~${fmtTokens(msg.tokens)} tok`;
      }
      break;
    case "toolOutput":
      appendToolOutput(msg.id, msg.delta);
      break;
    case "error":
      thinking = false;
      hideActivity();
      addError(msg.message);
      break;
    case "turnEnd":
      thinking = false;
      hideActivity();
      setRunning(false);
      currentAssistant = null;
      turnsCompleted++;
      thinkCountEl.textContent = "";
      markClippedCode(messagesEl);
      updateMeter();
      break;
    case "approvalRequest":
      showApproval(msg.payload);
      break;
    case "sessionList":
      showSessionList(msg.sessions, msg.currentId);
      break;
  }
});

post({ type: "ready" });
