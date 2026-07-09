/**
 * Compact, machine-maintained session scratchpad that survives compaction.
 * Free-text summaries are lossy; this structured blob is re-injected after
 * every compaction event so the agent doesn't re-discover goals, decisions,
 * and known failures.
 */

export interface StickyMemory {
  goal?: string;
  decisions: string[];
  filesTouched: string[];
  openErrors: string[];
  nextStep?: string;
  /** Named durable commands (e.g. test → "npm test"). */
  commands: Record<string, string>;
}

export function emptyStickyMemory(): StickyMemory {
  return {
    decisions: [],
    filesTouched: [],
    openErrors: [],
    commands: {},
  };
}

/** Cap list lengths so the sticky block stays cheap to re-inject. */
const MAX_LIST = 24;
const MAX_CMD = 12;
const MAX_STR = 240;

function clip(s: string, n = MAX_STR): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function uniqPush(list: string[], item: string, max = MAX_LIST): void {
  const v = clip(item);
  if (!v) return;
  const i = list.findIndex((x) => x.toLowerCase() === v.toLowerCase());
  if (i >= 0) list.splice(i, 1);
  list.push(v);
  while (list.length > max) list.shift();
}

export function applyStickyUpdate(
  mem: StickyMemory,
  patch: Partial<{
    goal: string;
    decisions: string[];
    filesTouched: string[];
    openErrors: string[];
    nextStep: string;
    commands: Record<string, string>;
    /** Replace openErrors entirely (e.g. after a clean verify). */
    clearErrors: boolean;
  }>
): StickyMemory {
  if (typeof patch.goal === "string" && patch.goal.trim()) {
    mem.goal = clip(patch.goal, 400);
  }
  if (typeof patch.nextStep === "string") {
    mem.nextStep = patch.nextStep.trim() ? clip(patch.nextStep) : undefined;
  }
  if (patch.clearErrors) mem.openErrors = [];
  if (Array.isArray(patch.decisions)) {
    for (const d of patch.decisions) uniqPush(mem.decisions, String(d));
  }
  if (Array.isArray(patch.filesTouched)) {
    for (const f of patch.filesTouched) uniqPush(mem.filesTouched, String(f), 40);
  }
  if (Array.isArray(patch.openErrors)) {
    for (const e of patch.openErrors) uniqPush(mem.openErrors, String(e));
  }
  if (patch.commands && typeof patch.commands === "object") {
    for (const [k, v] of Object.entries(patch.commands)) {
      if (!k.trim() || typeof v !== "string" || !v.trim()) continue;
      mem.commands[clip(k, 40)] = clip(v, 160);
      const keys = Object.keys(mem.commands);
      while (keys.length > MAX_CMD) {
        delete mem.commands[keys.shift()!];
      }
    }
  }
  return mem;
}

/** Render a short block for system-prompt / post-compaction injection. */
export function renderStickyMemory(mem: StickyMemory): string {
  const lines: string[] = ["# Scratchpad (survives compaction)"];
  if (mem.goal) lines.push(`Goal: ${mem.goal}`);
  if (mem.nextStep) lines.push(`Next: ${mem.nextStep}`);
  if (mem.decisions.length) {
    for (const d of mem.decisions.slice(-12)) lines.push(`- ${d}`);
  }
  if (mem.filesTouched.length) {
    lines.push(`Files: ${mem.filesTouched.slice(-20).join(", ")}`);
  }
  if (mem.openErrors.length) {
    for (const e of mem.openErrors.slice(-10)) lines.push(`- ! ${e}`);
  }
  const cmds = Object.entries(mem.commands);
  if (cmds.length) {
    for (const [k, v] of cmds) lines.push(`- ${k}: \`${v}\``);
  }
  if (lines.length === 1) return "";
  return lines.join("\n");
}

export function stickyIsEmpty(mem: StickyMemory): boolean {
  return (
    !mem.goal &&
    !mem.nextStep &&
    mem.decisions.length === 0 &&
    mem.filesTouched.length === 0 &&
    mem.openErrors.length === 0 &&
    Object.keys(mem.commands).length === 0
  );
}
