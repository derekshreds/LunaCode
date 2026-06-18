import { DiffData, DiffRow } from "./webview/protocol";

interface Op {
  type: "eq" | "del" | "add";
  text: string;
}

/** Classic LCS line diff. Fine for the modestly-sized regions we render. */
function lineDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });
  return ops;
}

const CONTEXT = 3;
const MAX_ROWS = 600;

/**
 * Build a git-style side-by-side diff between two texts, with real line numbers
 * and long unchanged stretches collapsed into a "gap" separator.
 *
 * @param oldStartLine 1-based line number of `oldText`'s first line in its file.
 * @param newStartLine 1-based line number of `newText`'s first line in its file.
 */
export function computeDiff(
  oldText: string,
  newText: string,
  path: string,
  oldStartLine = 1,
  newStartLine = 1
): DiffData {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const ops = lineDiff(a, b);

  // First pass: attach line numbers.
  let lo = oldStartLine;
  let ln = newStartLine;
  type Tagged = { type: Op["type"]; text: string; oldNo?: number; newNo?: number; changed: boolean };
  const tagged: Tagged[] = ops.map((op) => {
    if (op.type === "eq") return { ...op, oldNo: lo++, newNo: ln++, changed: false };
    if (op.type === "del") return { ...op, oldNo: lo++, changed: true };
    return { ...op, newNo: ln++, changed: true };
  });

  // Mark which eq lines to keep (within CONTEXT of a change).
  const keep = new Array(tagged.length).fill(false);
  for (let i = 0; i < tagged.length; i++) {
    if (tagged[i].changed) {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(tagged.length - 1, i + CONTEXT); k++) {
        keep[k] = true;
      }
    }
  }

  let addCount = 0;
  let delCount = 0;
  for (const t of tagged) {
    if (t.type === "add") addCount++;
    else if (t.type === "del") delCount++;
  }

  // Second pass: emit rows, pairing del/add runs side-by-side and collapsing
  // long unchanged gaps.
  const rows: DiffRow[] = [];
  let i = 0;
  let inGap = false;
  while (i < tagged.length && rows.length < MAX_ROWS) {
    const t = tagged[i];
    if (t.type === "eq") {
      if (keep[i]) {
        rows.push({
          left: { n: t.oldNo!, text: t.text, type: "ctx" },
          right: { n: t.newNo!, text: t.text, type: "ctx" },
        });
        inGap = false;
      } else if (!inGap) {
        rows.push({ gap: "⋯" });
        inGap = true;
      }
      i++;
      continue;
    }
    inGap = false;
    // Collect a contiguous run of dels then adds.
    const dels: Tagged[] = [];
    const adds: Tagged[] = [];
    while (i < tagged.length && tagged[i].type === "del") dels.push(tagged[i++]);
    while (i < tagged.length && tagged[i].type === "add") adds.push(tagged[i++]);
    const rowsInRun = Math.max(dels.length, adds.length);
    for (let r = 0; r < rowsInRun && rows.length < MAX_ROWS; r++) {
      const d = dels[r];
      const ad = adds[r];
      rows.push({
        left: d ? { n: d.oldNo!, text: d.text, type: "del" } : undefined,
        right: ad ? { n: ad.newNo!, text: ad.text, type: "add" } : undefined,
      });
    }
  }

  return {
    path,
    language: detectLanguage(path),
    rows,
    addCount,
    delCount,
    truncated: rows.length >= MAX_ROWS,
  };
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  sql: "sql",
  dockerfile: "dockerfile",
};

export function detectLanguage(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? "";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext];
}
