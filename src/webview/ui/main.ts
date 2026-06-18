import {
  HostToWebview,
  WebviewToHost,
  ApprovalPayload,
  SessionUsage,
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
}
const state: UiState = {
  hasApiKey: false,
  model: "",
  mode: "standard",
  modes: [],
  running: false,
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
      <button id="newBtn" class="icon-btn" title="New session"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
  </div>
  <div id="overlay" class="overlay hidden"></div>
  <div id="messages" class="messages"></div>
  <div id="approval" class="approval-slot"></div>
  <div id="activity" class="activity hidden">
    <span class="think-orb"></span>
    <span class="think-label">
      <span class="think-text">Thinking</span>
      <span class="think-dots"><i></i><i></i><i></i></span>
    </span>
  </div>
  <div class="composer">
    <div class="input-shell">
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

const SEND_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 11l18-8-8 18-2.5-7.5L3 11z" fill="currentColor"/></svg>`;
const STOP_ICON = `<svg width="14" height="14" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>`;
sendBtn.innerHTML = SEND_ICON;

// ---------- Events ----------
modelBtn.addEventListener("click", () => post({ type: "selectModel" }));
$("newBtn").addEventListener("click", () => post({ type: "newSession" }));
$("historyBtn").addEventListener("click", () => post({ type: "listSessions" }));
$("usageBtn").addEventListener("click", () => post({ type: "getUsage", days: usageDays }));
overlayEl.addEventListener("click", (e) => {
  if (e.target === overlayEl) hideOverlay();
});
inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (e) => {
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
  if (!text.trim()) return;
  if (!state.hasApiKey) {
    post({ type: "setApiKey" });
    return;
  }
  post({ type: "send", text });
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
function scrollToBottom() {
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
  scrollToBottom();
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
  scrollToBottom();
}

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
  get_diagnostics: ["Checking diagnostics", "Checked diagnostics"],
  write_file: ["Writing", "Wrote"],
  edit_file: ["Editing", "Edited"],
  run_command: ["Running", "Ran"],
};

function friendly(name: string, args: any): { verbs: [string, string]; target: string } {
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
        target = args.path ?? "";
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
      case "run_command":
        target = args.command ?? "";
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
    wrap.appendChild(renderDiff(diff, true));
  } else if (!ok && summary) {
    wrap.appendChild(el("div", "tool-error", summary));
  }
  scrollToBottom();
}

// ---------- Diff (split, git-style) ----------
function renderDiff(diff: DiffData, collapsible: boolean): HTMLElement {
  const root = collapsible ? document.createElement("details") : el("div", "diff");
  if (collapsible) {
    (root as HTMLDetailsElement).open = true;
    root.className = "diff";
  }
  const head = collapsible ? document.createElement("summary") : el("div", "diff-head");
  head.className = "diff-head";
  head.appendChild(el("span", "diff-path", diff.path));
  const stat = el("span", "diff-stat");
  if (diff.addCount) stat.appendChild(el("span", "stat-add", `+${diff.addCount}`));
  if (diff.delCount) stat.appendChild(el("span", "stat-del", `−${diff.delCount}`));
  head.appendChild(stat);
  root.appendChild(head);

  const body = el("div", "diff-body");
  for (const r of diff.rows) {
    if (r.gap !== undefined) {
      const gap = el("div", "diff-gap", r.gap);
      body.appendChild(gap);
      continue;
    }
    const rowEl = el("div", "diff-row");
    rowEl.appendChild(gutter(r.left?.n));
    rowEl.appendChild(codeCell(r.left?.text, r.left?.type, diff.language));
    rowEl.appendChild(gutter(r.right?.n));
    rowEl.appendChild(codeCell(r.right?.text, r.right?.type, diff.language));
    body.appendChild(rowEl);
  }
  root.appendChild(body);
  if (diff.truncated) root.appendChild(el("div", "diff-trunc", "… diff truncated"));
  return root;
}
function gutter(n?: number): HTMLElement {
  return el("span", "diff-gutter", n ? String(n) : "");
}
function codeCell(text: string | undefined, type: string | undefined, lang?: string): HTMLElement {
  const cell = el("span", "diff-code " + (type ? "c-" + type : "c-empty"));
  if (text !== undefined) cell.innerHTML = highlightLine(text, lang) || "&nbsp;";
  return cell;
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
  if (p.diff && p.diff.rows.length) {
    card.appendChild(renderDiff(p.diff, false));
  } else if (p.detail) {
    const pre = el("pre", "approval-detail");
    pre.textContent = p.detail;
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

// ---------- Meter ----------
function updateMeter() {
  const parts: string[] = [];
  parts.push(`<span class="meter-session">◆ ${fmtCost(sessionUsage.cost)}</span>`);
  if (lastTurnUsage) {
    const { promptTokens, completionTokens, cachedTokens } = lastTurnUsage;
    const hit = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
    parts.push(`↑${fmtTokens(promptTokens)} ↓${fmtTokens(completionTokens)}`);
    parts.push(`<span class="meter-cache">cache ${hit}%</span>`);
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
      updateMeter();
      break;
    case "sessionUsage":
      sessionUsage = msg.usage;
      updateMeter();
      break;
    case "usageReport":
      showUsage(msg.report);
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
