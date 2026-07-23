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
  MentionItem,
  ToolReport,
  ControlCenterSnapshot,
} from "../protocol";
import { renderMarkdown } from "./markdown";
import { highlightLine, escapeHtml } from "./highlight";
import { appendTurnReceipt } from "./receipt";

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
  /** First configured fallback model (for the error-card retry action). */
  fallback: string;
}
const state: UiState = {
  hasApiKey: false,
  model: "",
  mode: "standard",
  modes: [],
  running: false,
  commands: [],
  fallback: "",
};

let currentAssistant: { el: HTMLElement; raw: string; renderQueued?: boolean } | null = null;
/** The live collapsible "thinking" block for the current step, if any. */
let currentReasoning: { details: HTMLDetailsElement; body: HTMLElement; raw: string } | null = null;
/** Model driving the current turn — stamped onto each assistant block as a badge. */
let currentTurnModel = "";
let currentActivityPhase = "";

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
/** Control Center live refresh state. A single timer/request prevents manual
 * refreshes and slow host snapshots from multiplying polling loops. */
let controlCenterRefreshTimer: number | undefined;
let controlCenterRefreshPending = false;
/** Timestamp of the last provider usage event — proxy for "the provider's
 * prompt cache was just written". Typical cache TTL is ~5 minutes. */
let lastUsageAt = 0;
/** Revertible turn checkpoints available on the host. */
let checkpointTurns = 0;
let checkpointFiles = 0;
/** Completed turns this session — gates the retry/edit chips. */
let turnsCompleted = 0;
/** Rewindable turn-start points from the host: rewindId → restorable file count.
 * `rewindLoaded` guards against disabling buttons before the first state arrives. */
let rewindPoints = new Map<number, number>();
let rewindLoaded = false;
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
      <button id="modelBtn" class="model-chip" title="Change model" aria-label="Change model"></button>
      <button id="usageBtn" class="icon-btn" title="Usage & cost" aria-label="Usage and cost"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 20V10M10 20V4M16 20v-7M20 20H3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button id="controlBtn" class="icon-btn" title="Control Center" aria-label="Open Control Center"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2" stroke="currentColor"/><circle cx="8" cy="12" r="2" stroke="currentColor"/><circle cx="13" cy="17" r="2" stroke="currentColor"/></svg></button>
      <button id="historyBtn" class="icon-btn" title="Session history" aria-label="Session history"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button id="settingsBtn" class="icon-btn" title="Settings" aria-label="Settings"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.12-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10.05 3V3a2 2 0 1 1 4 0v.09c0 .68.4 1.29 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01c.27.62.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.29.4-1.56 1.03z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button id="newBtn" class="icon-btn" title="New session" aria-label="New session"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
  </div>
  <div id="overlay" class="overlay hidden"></div>
  <div id="messages" class="messages" role="log" aria-live="polite" aria-relevant="additions"></div>
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
        <textarea id="input" rows="1" aria-label="Message Luna Code" placeholder="Ask Luna Code to build, fix, or explain…  (Enter to send · Shift+Enter for newline)"></textarea>
        <button id="sendBtn" class="send-btn" title="Send" aria-label="Send message"></button>
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
$("controlBtn").addEventListener("click", requestControlCenter);
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
  item("↻", "Retry last message", hasTurns ? "Rewind the last turn (restores its files) and re-send" : "Nothing to retry yet", hasTurns, { type: "retryTurn" });
  item("✎", "Edit last message", hasTurns ? "Rewind the last turn (restores its files) and edit before re-sending" : "Nothing to edit yet", hasTurns, { type: "editLastTurn" });
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

/** Cycle Standard → Auto → Plan → Standard. */
function cycleMode() {
  if (!state.modes.length) return;
  const i = state.modes.findIndex((m) => m.id === state.mode);
  const next = state.modes[(i + 1) % state.modes.length];
  post({ type: "setMode", mode: next.id as any });
}

// Global shortcuts (fire regardless of which webview element has focus).
document.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+. cycles the agent mode.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === ".") {
    e.preventDefault();
    cycleMode();
    return;
  }
  // Esc stops a running turn (unless a dropdown/overlay owns Escape).
  if (
    e.key === "Escape" &&
    state.running &&
    !mentionActive &&
    overlayEl.classList.contains("hidden") &&
    actionsMenuEl.classList.contains("hidden")
  ) {
    e.preventDefault();
    post({ type: "cancel" });
    return;
  }
  // Ctrl/Cmd+Shift+Backspace starts a fresh session.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Backspace") {
    e.preventDefault();
    post({ type: "newSession" });
    return;
  }
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
//
// Important: do NOT use CSS `scroll-behavior: smooth` on #messages. Smooth
// animations lag behind streaming growth, leave us a few px short of the
// bottom, and the scroll handler then clears stickToBottom — so following
// silently dies mid-stream. Instant scrollTop jumps stay glued.
//
// Content growth (thinking rows, markdown, tool cards) does not fire a
// viewport resize. We ResizeObserver each message child so any height change
// re-pins while stickToBottom is set — that covers the "thinking block popped
// in and left a gap under the fold" case.
let stickToBottom = true;
let scrollRaf = 0;
let userScrolling = false;
let userScrollIdleTimer = 0;
const NEAR_BOTTOM_PX = 80;

function nearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < NEAR_BOTTOM_PX;
}

function endUserScroll() {
  userScrolling = false;
  if (nearBottom()) stickToBottom = true;
}

function markUserScroll() {
  userScrolling = true;
  window.clearTimeout(userScrollIdleTimer);
  userScrollIdleTimer = window.setTimeout(endUserScroll, 150);
}

messagesEl.addEventListener("scroll", () => {
  // While the user is actively wheeling/touching, trust nearBottom().
  // Programmatic pins also fire `scroll`; if a pin lands slightly short
  // (layout still settling) we must NOT clear stickToBottom or following dies.
  if (userScrolling) stickToBottom = nearBottom();
  else if (nearBottom()) stickToBottom = true;
});
// scroll is async; during rapid streaming a pin can run before a scroll-up
// registers. Wheel/touch fire with the user's intent, so update stick now.
messagesEl.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    markUserScroll();
    if (e.deltaY < 0) stickToBottom = false;
    else if (e.deltaY > 0 && nearBottom()) stickToBottom = true;
  },
  { passive: true }
);
messagesEl.addEventListener(
  "touchstart",
  () => {
    markUserScroll();
  },
  { passive: true }
);
messagesEl.addEventListener(
  "touchend",
  () => {
    endUserScroll();
  },
  { passive: true }
);
messagesEl.addEventListener(
  "touchmove",
  () => {
    markUserScroll();
    requestAnimationFrame(() => {
      stickToBottom = nearBottom();
    });
  },
  { passive: true }
);

function pinToBottom() {
  // Overscroll assignment clamps to the max; cheaper and more reliable than
  // reading scrollHeight twice across frames when layout is still settling.
  messagesEl.scrollTop = messagesEl.scrollHeight + 1e6;
}

function scrollToBottom(force = false) {
  if (force) stickToBottom = true;
  else if (!stickToBottom) return;
  // Coalesce streaming deltas to one pin per frame, after layout.
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!stickToBottom) return;
    pinToBottom();
    // One more frame: thinking/tool rows often finalize height post-paint
    // (summary text, borders, fonts). If we're still following, pin again.
    requestAnimationFrame(() => {
      if (stickToBottom) pinToBottom();
    });
  });
}

// Re-pin when the viewport resizes (activity bar, approval card, sidebar) OR
// when any message child's border-box grows (thinking block, streamed md…).
if (typeof ResizeObserver !== "undefined") {
  const reflowPin = () => {
    if (stickToBottom) pinToBottom();
  };
  const ro = new ResizeObserver(reflowPin);
  ro.observe(messagesEl);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement) ro.observe(n);
      });
      m.removedNodes.forEach((n) => {
        if (n instanceof HTMLElement) ro.unobserve(n);
      });
    }
  }).observe(messagesEl, { childList: true });
}

// ---------- Messages ----------
function addUserMessage(
  text: string,
  opts?: { queued?: boolean; echoId?: number; rewindId?: number }
) {
  clearWelcome();
  const wrap = el("div", "msg user enter");
  const bubble = el("div", "bubble");
  bubble.innerHTML = renderMarkdown(text);
  if (opts?.queued) {
    wrap.classList.add("queued");
    bubble.appendChild(el("span", "queued-tag", "Queued"));
  }
  wrap.appendChild(bubble);
  if (opts?.echoId !== undefined) wrap.dataset.echoId = String(opts.echoId);
  if (opts?.rewindId !== undefined) attachRewindButton(wrap, opts.rewindId);
  messagesEl.appendChild(wrap);
  scrollToBottom(true); // the user's own message always snaps down
}

// ---------- Rewind (per-message) ----------
/** Attach the hover-revealed rewind button to a turn-start user bubble. */
function attachRewindButton(wrap: HTMLElement, rewindId: number) {
  wrap.dataset.rewindId = String(rewindId);
  if (wrap.querySelector(".rewind-btn")) return;
  const btn = el("button", "rewind-btn", "⟲");
  btn.onclick = () => {
    if (btn.classList.contains("disabled")) return;
    post({ type: "rewindPreview", id: rewindId });
  };
  wrap.appendChild(btn);
  refreshRewindButton(wrap);
}

/** Enable/disable + tooltip a bubble's rewind button from the current state. */
function refreshRewindButton(wrap: HTMLElement) {
  const idStr = wrap.dataset.rewindId;
  const btn = wrap.querySelector(".rewind-btn") as HTMLButtonElement | null;
  if (!btn || idStr === undefined) return;
  const files = rewindPoints.get(Number(idStr));
  if (rewindLoaded && files === undefined) {
    // Compacted out of the live context — no longer rewindable.
    btn.classList.add("disabled");
    btn.classList.remove("has-edits");
    btn.title = "This point was summarized away and can no longer be rewound";
  } else {
    btn.classList.remove("disabled");
    // Mark turns that changed files so restore points are visible inline.
    btn.classList.toggle("has-edits", !!files);
    btn.title = files
      ? `Rewind here — restores ${files} file(s), discards everything below`
      : "Rewind here — discards everything below";
  }
}

function applyRewindState() {
  messagesEl
    .querySelectorAll<HTMLElement>(".msg.user[data-rewind-id]")
    .forEach(refreshRewindButton);
}

/** Truncate the transcript DOM from the bubble with this rewindId onward. */
function rollbackDomFrom(rewindId: number) {
  const target = messagesEl.querySelector<HTMLElement>(
    `.msg.user[data-rewind-id="${rewindId}"]`
  );
  if (!target) return;
  let node: Element | null = target;
  const toRemove: Element[] = [];
  while (node) {
    toRemove.push(node);
    node = node.nextElementSibling;
  }
  toRemove.forEach((n) => n.remove());
  currentAssistant = null;
  currentReasoning = null;
  turnsCompleted = messagesEl.querySelectorAll(".msg.user[data-rewind-id]").length;
  updateMeter();
}

/** Destructive-rewind confirmation, reusing the sheet + approval-button styles. */
function showRewindConfirm(p: Extract<HostToWebview, { type: "rewindPreview" }>) {
  const sheet = openSheet();
  sheetHead(sheet, "Rewind conversation");
  const body = el("div", "rewind-confirm");
  const preview = (p.text || "").replace(/\s+/g, " ").slice(0, 140);
  body.appendChild(el("div", "rewind-target", preview ? `“${preview}”` : "this message"));
  const summary = [`Discards ${p.messagesDiscarded} message(s) and everything after`];
  if (p.filesRestored) summary.push(`restores ${p.filesRestored} file(s)`);
  if (p.filesDeleted) summary.push(`deletes ${p.filesDeleted} created file(s)`);
  body.appendChild(el("div", "rewind-summary", summary.join(" · ") + "."));
  const warn = ["Command side effects (installs, deletes, git) are not undone."];
  if (p.horizonExceeded)
    warn.push("Some older edits are past the checkpoint horizon and can't be restored.");
  body.appendChild(el("div", "rewind-warn", warn.join(" ")));
  const actions = el("div", "approval-actions");
  const cancel = el("button", "btn btn-reject", "Cancel");
  const rollback = el("button", "btn btn-approve", "Rewind");
  rollback.title = "Restore files and trim the conversation to here, then stop";
  const edit = el("button", "btn btn-always", "Rewind & edit");
  edit.title = "Rewind, then put this message back in the composer to change it";
  const rerun = el("button", "btn btn-always", "Rewind & re-run");
  rerun.title = "Rewind, then re-send this message as-is";
  cancel.onclick = hideOverlay;
  rollback.onclick = () => {
    hideOverlay();
    post({ type: "rewindTo", id: p.id, mode: "rollback" });
  };
  edit.onclick = () => {
    hideOverlay();
    post({ type: "rewindTo", id: p.id, mode: "edit" });
  };
  rerun.onclick = () => {
    hideOverlay();
    post({ type: "rewindTo", id: p.id, mode: "rerun" });
  };
  actions.appendChild(cancel);
  actions.appendChild(rollback);
  actions.appendChild(edit);
  actions.appendChild(rerun);
  body.appendChild(actions);
  sheet.appendChild(body);
}
function clearQueuedTags() {
  messagesEl.querySelectorAll(".msg.user.queued").forEach((m) => {
    m.classList.remove("queued");
    m.querySelector(".queued-tag")?.remove();
  });
}

function ensureAssistant(): NonNullable<typeof currentAssistant> {
  if (!currentAssistant) {
    clearWelcome();
    const wrap = el("div", "msg assistant enter");
    if (currentTurnModel) {
      const badge = el("span", "model-badge", currentTurnModel.split("/").pop() || currentTurnModel);
      badge.title = `Answered by ${currentTurnModel}`;
      wrap.appendChild(badge);
    }
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
  // Re-parsing the WHOLE message per delta is O(n²) over a long stream — one
  // render per frame is visually identical. The rAF captures this message
  // object, so the final delta always paints even if the turn ends (and
  // currentAssistant is cleared) before the frame fires.
  if (a.renderQueued) return;
  a.renderQueued = true;
  requestAnimationFrame(() => {
    a.renderQueued = false;
    a.el.innerHTML = renderMarkdown(a.raw);
    markClippedCode(a.el);
    scrollToBottom();
  });
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
  const secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
  if (currentReasoning) {
    // We streamed the actual reasoning — fold the duration into its summary
    // and collapse it, instead of a separate "Thought for Ns" line.
    finalizeReasoning(secs);
  } else if (sawReasoning || secs >= 3) {
    messagesEl.appendChild(el("div", "thought-line", `Thought for ${secs}s`));
    scrollToBottom();
  }
}

// ---------- Reasoning (collapsible "thinking") ----------
function ensureReasoning(): { details: HTMLDetailsElement; body: HTMLElement; raw: string } {
  if (!currentReasoning) {
    const details = el("details", "reasoning") as HTMLDetailsElement;
    details.open = false; // collapsed by default; expand the summary to watch it stream
    const summary = el("summary", undefined, "Thinking…");
    const body = el("div", "reasoning-body");
    details.appendChild(summary);
    details.appendChild(body);
    messagesEl.appendChild(details);
    currentReasoning = { details, body, raw: "" };
    // The summary row itself takes space even when collapsed — pin so it
    // doesn't land below the fold while the user is following the bottom.
    scrollToBottom();
  }
  return currentReasoning;
}
function appendReasoning(delta: string) {
  const r = ensureReasoning();
  r.raw += delta;
  r.body.textContent = r.raw;
  // Collapsed thinking isn't visible, so don't fight the user's scroll position
  // on every delta — only follow while the block is expanded.
  if (r.details.open) scrollToBottom();
}
/** Collapse the current reasoning block and label it with the think duration. */
function finalizeReasoning(secs?: number) {
  if (!currentReasoning) return;
  const summary = currentReasoning.details.querySelector("summary");
  if (summary) summary.textContent = secs ? `Thought for ${secs}s` : "Thoughts";
  currentReasoning.details.open = false;
  currentReasoning = null;
  // Label text can wrap / change height slightly; keep following if stuck.
  scrollToBottom();
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
  implement: ["Delegating", "Delegated"],
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
        target = Array.isArray(args.questions)
          ? `${args.questions.length} research question(s)`
          : typeof args.question === "string" ? args.question.slice(0, 80) : "";
        break;
      case "implement":
        target = Array.isArray(args.jobs)
          ? `${args.jobs.length} scoped implementation job(s)`
          : Array.isArray(args.tasks)
          ? `${args.tasks.length} implementation task(s)`
          : typeof args.task === "string" ? args.task.slice(0, 80) : "";
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
function activityPhase(name: string): string {
  if (name === "set_tasks") return "Plan";
  if (name === "explore") return "Research delegation";
  if (name === "implement" || name === "write_file" || name === "edit_file" || name === "apply_patch") return "Implementation";
  if (name === "run_command" || name === "get_diagnostics") return "Verification";
  if (name.startsWith("git_")) return "Repository review";
  return "Research";
}
function addToolStart(id: string, name: string, args: any) {
  currentAssistant = null;
  thinkCountEl.textContent = ""; // new step — counter restarts at 0
  const { verbs, target } = friendly(name, args);
  const phase = activityPhase(name);
  if (phase !== currentActivityPhase) {
    messagesEl.appendChild(el("div", "phase-line", phase));
    currentActivityPhase = phase;
  }
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
function addToolEnd(id: string, name: string, ok: boolean, summary: string, diff?: DiffData, report?: ToolReport) {
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
  if (report) wrap.appendChild(renderToolReport(report));
  toolCards.delete(id);
  scrollToBottom();
}

/** Rich sub-agent telemetry is UI-only: useful evidence for the user without
 * adding a single token to the primary model's conversation. */
function renderToolReport(report: ToolReport): HTMLElement {
  const details = el("details", "tool-report") as HTMLDetailsElement;
  const cacheHit = report.promptTokens > 0
    ? Math.round((report.cachedTokens / report.promptTokens) * 100)
    : 0;
  const elapsed = report.durationMs < 1000
    ? `${report.durationMs}ms`
    : `${(report.durationMs / 1000).toFixed(report.durationMs < 10_000 ? 1 : 0)}s`;
  const agents = report.agents === 1 ? "1 agent" : `${report.agents} agents`;
  const headline = [
    agents,
    `${report.toolCalls} call${report.toolCalls === 1 ? "" : "s"}`,
    `${fmtTokens(report.promptTokens + report.completionTokens)} tok`,
    `${cacheHit}% cached`,
    elapsed,
    ...(report.cost != null ? [fmtCost(report.cost)] : []),
  ].join(" · ");
  details.appendChild(el("summary", "tool-report-summary", headline));

  const body = el("div", "tool-report-body");
  if (report.successful < report.agents) {
    body.appendChild(el("div", "tool-report-warning", `${report.successful}/${report.agents} agents completed`));
  }
  if (report.tools.length) {
    const tools = el("div", "tool-report-section");
    tools.appendChild(el("span", "tool-report-label", "Tools"));
    const chips = el("div", "tool-report-chips");
    for (const tool of report.tools) chips.appendChild(el("span", "tool-report-chip", `${tool.name} ×${tool.count}`));
    tools.appendChild(chips);
    body.appendChild(tools);
  }
  if (report.sources.length) {
    const sources = el("div", "tool-report-section");
    sources.appendChild(el("span", "tool-report-label", report.kind === "implementation" ? "Files" : "Sources"));
    const list = el("div", "tool-report-sources");
    for (const source of report.sources) list.appendChild(el("div", "tool-report-source", source));
    sources.appendChild(list);
    body.appendChild(sources);
  }
  details.appendChild(body);
  return details;
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

  // Expand only when there are changed rows the preview doesn't show (or the
  // diff was row-capped). We deliberately DON'T print a hidden-line count: a
  // side-by-side row can represent one or two changed lines (a paired
  // modification vs. a lone add/del), so any single number is misleading and
  // swings with how edits happen to align. The header's +adds/−dels covers scale.
  const expandable = changed.length > shown.length || !!diff.truncated;

  const root = el("div", "diff diff-preview" + (expandable ? " expandable" : ""));
  root.appendChild(diffHead(diff, isNewFileDiff(diff) ? "new file" : undefined));
  root.appendChild(diffBody(diff, shown));
  if (expandable) {
    root.title = "Click to view the full diff";
    root.appendChild(el("div", "diff-more", "click to expand"));
    root.onclick = () => showDiffSheet(diff);
  }
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
const toolOutputOrder: string[] = [];
const MAX_RETAINED_TOOL_OUTPUTS = 100;
const OUTPUT_PREVIEW_LINES = 8;
const OUTPUT_KEEP_CHARS = 200_000;

function appendToolOutput(id: string, delta: string) {
  const wrap = toolCards.get(id);
  if (!wrap) return;
  if (!toolOutputs.has(id)) {
    toolOutputOrder.push(id);
    while (toolOutputOrder.length > MAX_RETAINED_TOOL_OUTPUTS) {
      const expired = toolOutputOrder.shift();
      if (expired) toolOutputs.delete(expired);
    }
  }
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
  // Offer recovery actions when there's a turn to retry.
  if (turnsCompleted > 0) {
    const actions = el("div", "error-actions");
    const retry = el("button", "review-act", "Retry");
    retry.onclick = () => post({ type: "retryTurn" });
    actions.appendChild(retry);
    if (state.fallback && state.fallback !== state.model) {
      const fb = el("button", "review-act", `Retry with ${state.fallback.split("/").pop()}`);
      fb.title = `Switch to ${state.fallback} and retry`;
      fb.onclick = () => post({ type: "retryWithModel", model: state.fallback });
      actions.appendChild(fb);
    }
    e.appendChild(actions);
  }
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

/** Clarifying question from the ask_user tool. */
function showAskUser(p: { id: string; question: string; options?: string[] }) {
  approvalEl.innerHTML = "";
  const card = el("div", "approval-card enter");
  const head = el("div", "approval-head");
  head.appendChild(el("span", "approval-title", "Question for you"));
  head.appendChild(el("span", "approval-kind", "ask_user"));
  card.appendChild(head);
  card.appendChild(el("div", "approval-subject", p.question));

  if (p.options && p.options.length) {
    const opts = el("div", "approval-actions");
    for (const o of p.options) {
      const b = el("button", "btn btn-approve", o);
      b.onclick = () => {
        post({ type: "askUserResponse", id: p.id, answer: o });
        approvalEl.innerHTML = "";
      };
      opts.appendChild(b);
    }
    card.appendChild(opts);
  }

  const row = el("div", "approval-actions");
  const input = el("input", "set-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = p.options?.length ? "Or type a free-form answer…" : "Your answer…";
  input.style.flex = "1";
  const send = el("button", "btn btn-approve", "Send");
  const skip = el("button", "btn btn-reject", "Skip");
  const submit = () => {
    post({ type: "askUserResponse", id: p.id, answer: input.value.trim() });
    approvalEl.innerHTML = "";
  };
  send.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };
  skip.onclick = () => {
    post({ type: "askUserResponse", id: p.id, answer: "" });
    approvalEl.innerHTML = "";
  };
  row.appendChild(input);
  row.appendChild(skip);
  row.appendChild(send);
  card.appendChild(row);
  approvalEl.appendChild(card);
  scrollToBottom();
  setTimeout(() => input.focus(), 0);
}
// ---------- Overlay: sessions ----------
function hideOverlay() {
  clearControlCenterRefresh();
  controlCenterRefreshPending = false;
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
  clearControlCenterRefresh();
  controlCenterRefreshPending = false;
  overlayEl.innerHTML = "";
  const sheet = el("div", "sheet enter");
  overlayEl.appendChild(sheet);
  overlayEl.classList.remove("hidden");
  return sheet;
}

function clearControlCenterRefresh() {
  if (controlCenterRefreshTimer !== undefined) {
    window.clearTimeout(controlCenterRefreshTimer);
    controlCenterRefreshTimer = undefined;
  }
}

function requestControlCenter() {
  if (controlCenterRefreshPending) return;
  clearControlCenterRefresh();
  controlCenterRefreshPending = true;
  post({ type: "getControlCenter" });
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
      // Per-model cache hit rate — the primary model sitting near 0% while
      // others look healthy is the signature of a cache regression.
      const cache =
        (m.prompt ?? 0) > 0
          ? ` · ${Math.round(((m.cached ?? 0) / m.prompt) * 100)}% cached`
          : "";
      row.appendChild(
        el("div", "model-sub", `${fmtTokens(m.tokens)} tokens · ${m.count} turns${cache}${lines}`)
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
    existing.querySelectorAll<HTMLElement>("[data-profile]").forEach((button) => {
      button.classList.toggle("active", button.dataset.profile === s.costProfile);
    });
    return;
  }
  // Unsolicited broadcast (config changed elsewhere) with no sheet open: ignore.
  if (!settingsWanted) return;

  const sheet = openSheet();
  sheet.classList.add("sheet-wide", "settings-sheet");
  sheetHead(sheet, "Settings");
  const body = el("div", "settings-body");

  const profiles = setGroup("Cost profile");
  const profileRow = el("div", "profile-grid");
  for (const profile of ["economy", "balanced", "quality"] as const) {
    const button = el("button", `profile-card${s.costProfile === profile ? " active" : ""}`);
    button.dataset.profile = profile;
    button.appendChild(el("span", "profile-name", profile[0].toUpperCase() + profile.slice(1)));
    button.appendChild(el("span", "profile-copy",
      profile === "economy" ? "16K agents · low reasoning · price routing" :
      profile === "quality" ? "60K agents · high reasoning · full tools" :
      "32K agents · adaptive reasoning · progressive tools"
    ));
    button.onclick = () => post({ type: "applyCostProfile", profile });
    profileRow.appendChild(button);
  }
  profiles.appendChild(profileRow);
  profiles.appendChild(el("div", "set-desc", "Profiles update concrete settings below; you can customize them afterward."));
  body.appendChild(profiles);

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
      "Cheap model that writes checkpoint summaries during compaction. Empty = use the currently selected model.",
      textSetting("summarizerModel", s.summarizerModel, "same as selected model")
    )
  );
  const subagentInput = textSetting("subagentModel", s.subagentModel, "same as selected model");
  const subagentWrap = el("div", "set-inline");
  subagentWrap.appendChild(subagentInput);
  const subagentBrowse = el("button", "btn set-browse", "Browse…");
  // Reuse the model picker; after pick, write into subagentModel instead of model.
  subagentBrowse.onclick = () => post({ type: "selectSubagentModel" });
  subagentWrap.appendChild(subagentBrowse);
  models.appendChild(
    setRow(
      "Subagent model",
      "Model for research sub-agents (explore tool). Fast + cheap works well for digests. Empty = use the currently selected model.",
      subagentWrap
    )
  );
  models.appendChild(
    setRow(
      "Planner model",
      "Cheap model for research/planning iterations of the main loop. Empty = always use the session model (often same as subagent).",
      textSetting("plannerModel", s.plannerModel, "same as selected model")
    )
  );
  models.appendChild(
    setRow(
      "Implementer model",
      "Model for the implement tool's write-capable sub-agent. Empty = session model.",
      textSetting("implementerModel", s.implementerModel, "same as selected model")
    )
  );
  models.appendChild(
    setRow(
      "Fallback models",
      "One per line, tried in order when the primary model errors or is rate-limited.",
      listSetting("fallbackModels", s.fallbackModels)
    )
  );
  models.appendChild(
    setRow(
      "Favorite models",
      "One per line. When set, these are shown first in the model quick-pick (⌘/Ctrl-click the model chip, or the model command).",
      listSetting("favoriteModels", s.favoriteModels)
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
      "Sub-agent context budget",
      "Per-agent token ceiling. 32K is the cost-conscious default; raise it only for unusually broad research.",
      numberSetting("subagentMaxContextTokens", s.subagentMaxContextTokens, {
        min: 8000,
        step: 1000,
      })
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
  ctx.appendChild(
    setRow(
      "Progressive tools",
      "In Standard mode, start with read/meta schemas and unlock edit/exec after research. Auto always starts with every tool.",
      toggleSetting("progressiveTools", s.progressiveTools)
    )
  );
  ctx.appendChild(
    setRow(
      "Adaptive reasoning",
      "Lower thinking effort on pure research follow-ups; raise when implementing.",
      toggleSetting("adaptiveReasoning", s.adaptiveReasoning)
    )
  );
  body.appendChild(ctx);

  // --- Agent behavior ---
  const beh = setGroup("Agent Behavior");
  beh.appendChild(
    setRow(
      "Max turns per task",
      "Tool-loop steps the agent runs before stopping. Raise it so long tasks and plans (esp. Auto mode) finish without stalling. 0 = unlimited.",
      numberSetting("maxTurns", s.maxTurns, { min: 0, step: 10 })
    )
  );
  beh.appendChild(
    setRow(
      "Loop guard",
      "Soft-block rewriting the same file / re-running the same command (or identical call) more than this many times per turn. The model can adapt; hard-stop only after consecutive fully-blocked rounds. Does not affect paged reads. 0 = disabled.",
      numberSetting("loopGuardLimit", s.loopGuardLimit, { min: 0, step: 1 })
    )
  );
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
      "Reveal edited files",
      "Open each file the agent edits in a preview tab (focus stays in the chat). Off = don't open files as they're written.",
      toggleSetting("revealEditedFiles", s.revealEditedFiles)
    )
  );
  beh.appendChild(
    setRow(
      "Worktree sandbox",
      "Agent works in an isolated git worktree; inspect, merge, or discard it from Control Center.",
      toggleSetting("worktreeMode", s.worktreeMode)
    )
  );
  beh.appendChild(
    setRow(
      "Verification policy",
      "Advisory reports missing evidence; Strict marks missing diagnostics or tests as a failed gate.",
      selectSetting("verificationPolicy", s.verificationPolicy, [
        ["advisory", "Advisory"],
        ["standard", "Standard"],
        ["strict", "Strict"],
      ])
    )
  );
  beh.appendChild(
    setRow(
      "Test-first bug fixes",
      "When practical, reproduce bugs with a failing regression test before changing production code.",
      toggleSetting("testFirstFixes", s.testFirstFixes)
    )
  );
  beh.appendChild(
    setRow(
      "Crash-safe queue",
      "Persist queued work and in-progress recovery markers across extension reloads.",
      toggleSetting("durableQueue", s.durableQueue)
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
      "Thinking effort",
      "Reasoning budget for models that support it. Higher = more deliberate (and pricier); Off disables thinking. Default uses the model's own setting.",
      selectSetting("reasoningEffort", s.reasoningEffort, [
        { value: "default", label: "Default — the model's own setting" },
        { value: "off", label: "Off — no reasoning" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ])
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
  priv.appendChild(
    setRow(
      "Quantizations",
      "One per line (e.g. fp8, fp16, bf16). When set, only providers serving the model at these precisions are used — leave empty for any, or list fp8+ to avoid low-precision (fp4) routing.",
      listSetting("quantizations", s.quantizations)
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

// ---------- Overlay: engineering Control Center ----------
function showControlCenter(s: ControlCenterSnapshot) {
  controlCenterRefreshPending = false;
  clearControlCenterRefresh();

  // Live snapshots arrive while an agent is running. Reuse the sheet instead
  // of calling openSheet(), which clears the overlay and replays the entrance
  // animation on every poll. Only the body changes, and its scroll is retained.
  let sheet = overlayEl.querySelector(".control-center") as HTMLElement | null;
  const previousBody = sheet?.querySelector(".control-body") as HTMLElement | null;
  const previousScrollTop = previousBody?.scrollTop ?? 0;
  if (!sheet) {
    sheet = openSheet();
    sheet.classList.add("sheet-wide", "control-center");
    const head = sheetHead(sheet, "Control Center");
    const refresh = el("button", "btn set-browse", "Refresh");
    refresh.onclick = requestControlCenter;
    head.insertBefore(refresh, head.lastChild);
  }
  const body = el("div", "usage-body control-body");

  const overview = el("div", "stat-row");
  overview.appendChild(statCard("Budget", s.budget.state));
  overview.appendChild(statCard("Spent", fmtCost(s.budget.spent)));
  overview.appendChild(statCard("Next turn", s.budget.projectedNextTurn === undefined ? "—" : `~${fmtCost(s.budget.projectedNextTurn)}`));
  overview.appendChild(statCard("Queue", `${s.queue.length}${s.queuePaused ? " paused" : ""}`));
  overview.appendChild(statCard("Source files", String(s.repo.sourceFiles)));
  overview.appendChild(statCard("Tests", String(s.repo.testFiles)));
  body.appendChild(overview);

  const actions = el("div", "control-actions");
  const patch = el("button", "btn", "Open Patch Studio") as HTMLButtonElement;
  patch.disabled = checkpointFiles === 0;
  patch.onclick = () => post({ type: "getTurnDiff" });
  const pause = el("button", "btn", s.queuePaused ? "Resume queue" : "Pause queue");
  pause.onclick = () => post({ type: "pauseQueue", paused: !s.queuePaused });
  const memory = el("button", "btn", s.memory.path ? "Open project memory" : "Create project memory");
  memory.onclick = () => post({ type: "createMemory" });
  actions.append(patch, pause, memory);
  body.appendChild(actions);

  if (s.recovery) {
    const sec = controlSection("Interrupted run", "recovery");
    sec.appendChild(el("div", "control-main", s.recovery.text.slice(0, 500)));
    sec.appendChild(el("div", "set-hint", `${s.recovery.model} · ${s.recovery.toolCalls} tool calls · last event ${s.recovery.lastEvent}`));
    const bar = el("div", "control-actions");
    const resume = el("button", "btn set-browse", "Inspect & resume");
    resume.onclick = () => post({ type: "resumeRecovery" });
    const discard = el("button", "btn danger", "Discard recovery marker");
    discard.onclick = () => post({ type: "discardRecovery" });
    bar.append(resume, discard);
    sec.appendChild(bar);
    body.appendChild(sec);
  }

  if (s.sandbox) {
    const sec = controlSection("Isolated worktree", "sandbox");
    sec.appendChild(el("div", "control-main", s.sandbox.branch));
    sec.appendChild(el("div", "set-hint", `${s.sandbox.changedFiles} changed file(s) · ${s.sandbox.dir}`));
    const bar = el("div", "control-actions");
    const merge = el("button", "btn set-browse", "Merge patch into workspace");
    merge.onclick = () => post({ type: "mergeSandbox" });
    const discard = el("button", "btn danger", "Discard worktree");
    discard.onclick = () => post({ type: "discardSandbox" });
    bar.append(merge, discard);
    sec.appendChild(bar);
    body.appendChild(sec);
  }

  const gates = controlSection(`Verification gates · ${s.verificationPolicy}`, "gates");
  if (!s.gates.length) gates.appendChild(el("div", "sheet-empty", "Complete a turn to see verification evidence."));
  for (const gate of s.gates) {
    const row = el("div", `control-row gate-${gate.status}`);
    row.appendChild(el("span", "control-status", gate.status === "pass" ? "✓" : gate.status === "fail" ? "×" : gate.status === "warn" ? "!" : "–"));
    const info = el("div", "control-info");
    info.appendChild(el("div", "control-label", gate.label));
    info.appendChild(el("div", "set-hint", gate.detail));
    row.appendChild(info);
    gates.appendChild(row);
  }
  body.appendChild(gates);

  if (s.queue.length) {
    const queue = controlSection("Background queue", "queue");
    for (const job of s.queue) {
      const row = el("div", "control-row");
      const info = el("div", "control-info");
      info.appendChild(el("div", "control-label", job.text.slice(0, 180)));
      info.appendChild(el("div", "set-hint", new Date(job.createdAt).toLocaleString()));
      const remove = el("button", "review-act danger", "Remove");
      remove.onclick = () => post({ type: "removeQueued", id: job.id });
      row.append(info, remove);
      queue.appendChild(row);
    }
    body.appendChild(queue);
  }

  const graph = controlSection("Agent graph", "graph");
  if (!s.graph.length) graph.appendChild(el("div", "sheet-empty", "No completed agent activity yet."));
  for (const node of s.graph.slice(-40)) {
    const row = el("div", `graph-node ${node.parent ? "child" : ""} ${node.status}`);
    row.appendChild(el("span", "graph-dot"));
    row.appendChild(el("span", "control-label", node.label));
    const meta = [node.cost === undefined ? "" : fmtCost(node.cost), node.durationMs === undefined ? "" : `${Math.round(node.durationMs / 1000)}s`].filter(Boolean).join(" · ");
    if (meta) row.appendChild(el("span", "graph-meta", meta));
    if (node.prompt && node.status !== "running") {
      const retry = el("button", "review-act", "Retry");
      retry.onclick = () => {
        hideOverlay();
        post({ type: "retryGraphNode", prompt: node.prompt! });
      };
      row.appendChild(retry);
    }
    graph.appendChild(row);
  }
  body.appendChild(graph);

  const repo = controlSection("Repository intelligence", "repo");
  repo.appendChild(el("div", "control-main", s.repo.languages.join(" · ") || "No source language detected"));
  if (s.repo.entrypoints.length) repo.appendChild(el("div", "set-hint", `Entrypoints: ${s.repo.entrypoints.join(", ")}`));
  if (s.repo.modules.length) repo.appendChild(el("div", "control-bars", s.repo.modules.slice(0, 8).map((m) => `${m.name} ${m.files}`).join("  ·  ")));
  if (s.repo.dependencies.length) repo.appendChild(el("div", "set-hint", `Dependencies: ${s.repo.dependencies.slice(0, 8).map((d) => `${d.from} → ${d.to} (${d.count})`).join(" · ")}`));
  for (const risk of s.repo.risk) repo.appendChild(el("div", "control-risk", `⚠ ${risk}`));
  for (const hot of s.repo.hotspots.slice(0, 6)) repo.appendChild(el("div", "control-row compact", `${hot.path} · ${hot.touches} turns · ${hot.churn} changed lines`));
  body.appendChild(repo);

  const lab = controlSection("Tool Development Lab", "tools");
  for (const phase of s.tools) {
    const row = el("div", "control-row");
    const info = el("div", "control-info");
    info.appendChild(el("div", "control-label", `${phase.phase} · ${phase.tools} tools · ~${phase.estimatedTokens.toLocaleString()} schema tokens`));
    info.appendChild(el("div", "set-hint", `Largest: ${phase.largest.map((x) => `${x.name} ${x.estimatedTokens}`).join(", ")}`));
    row.appendChild(info);
    lab.appendChild(row);
  }
  body.appendChild(lab);

  const mem = controlSection("Inspectable project memory", "memory");
  mem.appendChild(el("div", "control-main", s.memory.path ?? "No LUNA.md or compatible project memory found."));
  if (s.memory.decisions.length) mem.appendChild(el("div", "set-hint", `Session decisions: ${s.memory.decisions.join(" · ")}`));
  if (s.memory.contents) mem.appendChild(el("pre", "memory-preview", s.memory.contents.slice(0, 2500)));
  body.appendChild(mem);

  const audit = controlSection("Security & trust audit", "audit");
  if (!s.audit.length) audit.appendChild(el("div", "sheet-empty", "No audited actions in this session."));
  for (const item of s.audit.slice(0, 40)) {
    const row = el("div", `control-row audit-${item.outcome}`);
    const info = el("div", "control-info");
    info.appendChild(el("div", "control-label", `${item.action} · ${item.outcome}`));
    info.appendChild(el("div", "set-hint", `${item.subject} · ${new Date(item.at).toLocaleTimeString()}`));
    row.appendChild(info);
    audit.appendChild(row);
  }
  body.appendChild(audit);
  if (previousBody) previousBody.replaceWith(body);
  else sheet.appendChild(body);
  body.scrollTop = previousScrollTop;

  if (state.running) {
    controlCenterRefreshTimer = window.setTimeout(() => {
      controlCenterRefreshTimer = undefined;
      if (sheet.isConnected && !overlayEl.classList.contains("hidden")) {
        requestControlCenter();
      }
    }, 1500);
  }
}

function controlSection(title: string, cls: string): HTMLElement {
  const section = el("section", `control-section control-${cls}`);
  section.appendChild(el("div", "block-label", title));
  return section;
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
  for (const d of diffs) body.appendChild(renderReviewFile(d));
  sheet.appendChild(body);
}

/** A reviewed file: full diff + per-file actions (open editor diff, revert) and,
 * when it has multiple change blocks, per-hunk revert checkboxes. */
function renderReviewFile(d: DiffData): HTMLElement {
  const block = el("div", "chart-block review-file");

  const head = el("div", "review-head");
  head.appendChild(el("span", "diff-path", d.path));
  const stat = el("span", "diff-stat");
  if (isNewFileDiff(d)) stat.appendChild(el("span", "diff-tag", "new file"));
  if (d.addCount) stat.appendChild(el("span", "stat-add", `+${d.addCount}`));
  if (d.delCount) stat.appendChild(el("span", "stat-del", `−${d.delCount}`));
  head.appendChild(stat);
  const actions = el("div", "review-actions");
  const openBtn = el("button", "review-act", "Open diff");
  openBtn.title = "Open a side-by-side diff in the editor";
  openBtn.onclick = () => post({ type: "openDiff", path: d.path });
  const revertBtn = el("button", "review-act danger", "Revert file");
  revertBtn.title = "Restore this file to its state before the last turn";
  revertBtn.onclick = () => post({ type: "revertFile", path: d.path });
  actions.appendChild(openBtn);
  actions.appendChild(revertBtn);
  head.appendChild(actions);
  block.appendChild(head);

  block.appendChild(diffBody(d, d.rows));
  if (d.truncated) block.appendChild(el("div", "diff-trunc", "… diff truncated"));

  // Per-hunk revert (only meaningful when there's more than one change block).
  const hunkIds = [...new Set(d.rows.filter((r) => r.hunk !== undefined).map((r) => r.hunk!))];
  if (hunkIds.length > 1) {
    const bar = el("div", "review-hunks");
    const checked = new Set<number>();
    const revertSel = el("button", "review-act danger", "Revert selected hunks") as HTMLButtonElement;
    revertSel.disabled = true;
    hunkIds.forEach((h, idx) => {
      const label = el("label", "review-hunk-chk");
      const cb = el("input") as HTMLInputElement;
      cb.type = "checkbox";
      cb.onchange = () => {
        cb.checked ? checked.add(h) : checked.delete(h);
        revertSel.disabled = checked.size === 0;
      };
      const first = d.rows.find((r) => r.hunk === h);
      const preview = (first?.right?.text ?? first?.left?.text ?? "").trim().slice(0, 50);
      if (preview) label.title = preview;
      label.appendChild(cb);
      label.appendChild(el("span", "review-hunk-label", `Hunk ${idx + 1}`));
      bar.appendChild(label);
    });
    revertSel.onclick = () => {
      if (checked.size) post({ type: "revertHunks", path: d.path, hunks: [...checked] });
    };
    bar.appendChild(revertSel);
    block.appendChild(bar);
  }
  return block;
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
  if (info.stubbedToolResults) {
    stats.appendChild(statCard("Stubbed results", String(info.stubbedToolResults)));
  }
  body.appendChild(stats);
  body.appendChild(
    el(
      "div",
      "block-label",
      `System prompt ~${fmtTokens(info.systemTokens)} tokens${info.hasMemory ? " · includes LUNA.md project memory" : ""}`
    )
  );
  if (info.byRole && info.byRole.length) {
    body.appendChild(el("div", "block-label", "By role"));
    for (const r of info.byRole) {
      const row = el("div", "ctx-item");
      row.appendChild(el("span", "ctx-role", r.role));
      row.appendChild(el("span", "ctx-preview", `${r.count} message${r.count === 1 ? "" : "s"}`));
      row.appendChild(el("span", "ctx-tokens", fmtTokens(r.tokens)));
      body.appendChild(row);
    }
  }
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
        "Every API call re-reads everything above (cached reads ≈ 10% of input price). History is append-only between compactions so those reads stay cached; hard compaction summarizes at the budget."
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
  currentReasoning = null;
  turnsCompleted = Math.max(0, turnsCompleted - 1);
  updateMeter();
}

// ---------- @-mentions (files, folders, symbols, problems, git) + / commands ----------
type MentionRow = {
  label: string;
  insert?: string;
  detail?: string;
  resolve?: { kind: string; arg?: string };
};
let mentionToken = 0;
let mentionActive = false;
let mentionItems: MentionRow[] = [];
let mentionSel = 0;
let mentionStart = -1; // index of "@" (file mode) — command mode inserts at 0
let mentionMode: "file" | "command" = "file";
let mentionTimer: ReturnType<typeof setTimeout> | undefined;

function mentionRowFromItem(it: MentionItem): MentionRow {
  if (it.kind === "problems" || it.kind === "git") {
    return { label: "@" + it.label, detail: it.detail, resolve: { kind: it.kind, arg: it.arg } };
  }
  return { label: it.label, insert: it.insert ?? it.label, detail: it.detail };
}

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
      state.commands
        .filter((c) => c.toLowerCase().startsWith(q))
        .map((c) => ({ label: "/" + c, insert: "/" + c }))
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
    post({ type: "queryMentions", query, token: ++mentionToken });
  }, 120);
}

function closeMention() {
  mentionActive = false;
  mentionEl.classList.add("hidden");
  mentionEl.innerHTML = "";
}

function renderMention(rows: MentionRow[]) {
  mentionItems = rows;
  mentionSel = 0;
  if (!rows.length) {
    closeMention();
    return;
  }
  mentionActive = true;
  mentionEl.classList.remove("hidden");
  mentionEl.innerHTML = "";
  rows.forEach((r, i) => {
    const row = el("div", "mention-item" + (i === mentionSel ? " sel" : ""));
    row.appendChild(el("span", "mention-label", r.label));
    if (r.detail) row.appendChild(el("span", "mention-detail", r.detail));
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
  if (item.resolve) {
    // Host-resolved context (problems/git): drop the @token; the resolved text
    // is attached to the next message host-side.
    inputEl.value = inputEl.value.slice(0, mentionStart) + inputEl.value.slice(caret);
    inputEl.setSelectionRange(mentionStart, mentionStart);
    post({ type: "resolveMention", kind: item.resolve.kind, arg: item.resolve.arg });
  } else {
    const insert = item.insert ?? item.label;
    inputEl.value = inputEl.value.slice(0, mentionStart) + insert + " " + inputEl.value.slice(caret);
    const pos = mentionStart + insert.length + 1;
    inputEl.setSelectionRange(pos, pos);
  }
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

function addImageFile(file: File) {
  if (pendingImages.length >= MAX_IMAGES) {
    addStatus(`Up to ${MAX_IMAGES} images per message.`);
    return;
  }
  if (!file.type.startsWith("image/")) {
    addStatus("Only image files can be attached.");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    addStatus("Image too large (max 3 MB). Resize and try again.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImages.push(String(reader.result));
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

inputEl.addEventListener("paste", (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    e.preventDefault();
    const file = item.getAsFile();
    if (file) addImageFile(file);
  }
});

// Drag & drop images onto the composer.
const inputShell = document.querySelector(".input-shell") as HTMLElement | null;
if (inputShell) {
  inputShell.addEventListener("dragover", (e: DragEvent) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
      e.preventDefault();
      inputShell.classList.add("drag-over");
    }
  });
  inputShell.addEventListener("dragleave", () => inputShell.classList.remove("drag-over"));
  inputShell.addEventListener("drop", (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    inputShell.classList.remove("drag-over");
    if (!files || !files.length) return;
    e.preventDefault();
    for (const f of Array.from(files)) addImageFile(f);
  });
}

// Attach-image button + hidden file picker.
const imgPicker = el("input") as HTMLInputElement;
imgPicker.type = "file";
imgPicker.accept = "image/*";
imgPicker.multiple = true;
imgPicker.style.display = "none";
imgPicker.onchange = () => {
  if (imgPicker.files) for (const f of Array.from(imgPicker.files)) addImageFile(f);
  imgPicker.value = "";
};
document.body.appendChild(imgPicker);
const attachBtn = el("button", "attach-btn", "📎");
attachBtn.title = "Attach image";
attachBtn.onclick = () => imgPicker.click();
const composerBar = document.querySelector(".composer-bar");
if (composerBar) composerBar.insertBefore(attachBtn, composerBar.firstChild);

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

function clearWelcome() {
  messagesEl.querySelector(".welcome")?.remove();
}

/** First-run / empty-session onboarding: modes, tips, and quick actions. */
function renderWelcome() {
  if (messagesEl.querySelector(".welcome")) return;
  const wrap = el("div", "welcome enter");
  const modes = state.modes.map((m) => `<li><b>${m.label}</b> — ${m.description}</li>`).join("");
  wrap.innerHTML = `
    <div class="welcome-logo"></div>
    <h2>Luna Code is ready</h2>
    <p>Ask it to build, fix, or explain anything in this workspace.</p>
    ${modes ? `<ul class="welcome-modes">${modes}</ul>` : ""}
    <p class="welcome-tips"><b>@</b> adds files, folders, symbols, problems, or the git diff · <b>/</b> runs commands · <b>⌘/Ctrl&nbsp;.</b> cycles mode</p>
  `;
  const row = el("div", "welcome-actions");
  const mem = el("button", "btn", "Create LUNA.md");
  mem.title = "Create a project-memory file Luna reads every turn";
  mem.onclick = () => post({ type: "createMemory" });
  const model = el("button", "btn", `Model: ${state.model.split("/").pop() || "choose"}`);
  model.onclick = () => post({ type: "selectModel" });
  row.appendChild(mem);
  row.appendChild(model);
  wrap.appendChild(row);
  const chips = el("div", "welcome-examples");
  ["Explain this codebase", "Find and fix a bug", "Add tests"].forEach((ex) => {
    const c = el("button", "welcome-chip", ex);
    c.onclick = () => {
      inputEl.value = ex + " ";
      autosize();
      inputEl.focus();
    };
    chips.appendChild(c);
  });
  wrap.appendChild(chips);
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
      state.fallback = msg.fallback ?? "";
      renderModeBar();
      renderModel();
      updateMeter();
      if (!msg.hasApiKey) {
        messagesEl.innerHTML = "";
        renderApiKeyNotice();
      } else if (!messagesEl.querySelector(".msg")) {
        renderWelcome();
      }
      break;
    case "config":
      state.hasApiKey = msg.hasApiKey;
      state.model = msg.model;
      state.mode = msg.mode;
      state.commands = msg.commands ?? state.commands;
      state.fallback = msg.fallback ?? state.fallback;
      renderModel();
      renderModeBar();
      if (state.hasApiKey && messagesEl.querySelector(".welcome")) {
        // API key was just added — swap the key notice for the onboarding card.
        messagesEl.innerHTML = "";
        renderWelcome();
      } else if (!state.hasApiKey && !messagesEl.querySelector(".welcome")) {
        messagesEl.innerHTML = "";
        renderApiKeyNotice();
      }
      break;
    case "sessionReset":
      messagesEl.innerHTML = "";
      stickToBottom = true;
      currentAssistant = null;
      currentReasoning = null;
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
      else renderWelcome();
      break;
    case "userEcho":
      // A queued message arrives mid-stream — don't disturb the assistant block
      // currently streaming; just append it below with a Queued tag.
      if (!msg.queued) currentAssistant = null;
      addUserMessage(msg.text, { queued: msg.queued, echoId: msg.echoId, rewindId: msg.rewindId });
      break;
    case "turnStart":
      setRunning(true);
      currentAssistant = null;
      currentTurnModel = msg.model || state.model;
      currentActivityPhase = "";
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
      // Only render live (during a real turn); replays don't carry reasoning.
      if (state.running) appendReasoning(msg.delta);
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
      addToolEnd(msg.id, msg.name, msg.ok, msg.summary, msg.diff, msg.report);
      // Back to thinking until the next text/tool/turn-end — only during a live turn.
      if (state.running) {
        startThink();
        startRotating();
      }
      break;
    case "status":
      addStatus(msg.message);
      break;
    case "steeringApplied":
      clearQueuedTags();
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
    case "controlCenter":
      showControlCenter(msg.snapshot);
      break;
    case "mentionMatches":
      if (msg.token === mentionToken) renderMention(msg.items.map(mentionRowFromItem));
      break;
    case "rollback":
      rollbackDom();
      break;
    case "rewindAssign": {
      const wrap = messagesEl.querySelector<HTMLElement>(
        `.msg.user[data-echo-id="${msg.echoId}"]`
      );
      if (wrap) attachRewindButton(wrap, msg.rewindId);
      break;
    }
    case "rewindState":
      rewindPoints = new Map(msg.points.map((p) => [p.id, p.files]));
      rewindLoaded = true;
      applyRewindState();
      break;
    case "rewindPreview":
      showRewindConfirm(msg);
      break;
    case "rewound":
      rollbackDomFrom(msg.id);
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
      finalizeReasoning();
      hideActivity();
      addError(msg.message);
      break;
    case "turnEnd": {
      const secs = thinking ? Math.max(1, Math.round((Date.now() - thinkStart) / 1000)) : undefined;
      thinking = false;
      finalizeReasoning(secs);
      hideActivity();
      setRunning(false);
      currentAssistant = null;
      turnsCompleted++;
      thinkCountEl.textContent = "";
      markClippedCode(messagesEl);
      updateMeter();
      break;
    }
    case "turnReceipt":
      appendTurnReceipt(msg.receipt, messagesEl, {
        fmtTokens,
        fmtCost,
        onLayout: () => scrollToBottom(),
      });
      currentActivityPhase = "";
      break;
    case "approvalRequest":
      showApproval(msg.payload);
      break;
    case "askUserRequest":
      showAskUser(msg);
      break;
    case "sessionList":
      showSessionList(msg.sessions, msg.currentId);
      break;
  }
});

post({ type: "ready" });
