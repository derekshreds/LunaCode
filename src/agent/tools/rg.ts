/**
 * Prefer native ripgrep when available; fall back to the JS walker.
 * Faster search → fewer agent thrash loops → lower model cost.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

let cachedRg: string | null | undefined;

/** Resolve an rg binary once per process. null = not found. */
export function resolveRg(): string | null {
  if (cachedRg !== undefined) return cachedRg;
  const candidates = [
    process.env.RIPGREP_PATH,
    "rg",
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
    // VS Code / Cursor sometimes ship rg next to the binary.
    process.platform === "darwin"
      ? "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg"
      : undefined,
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c === "rg") {
      // PATH lookup deferred to spawn; assume available and verify on first use.
      cachedRg = "rg";
      return cachedRg;
    }
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        cachedRg = c;
        return cachedRg;
      }
    } catch {
      /* try next */
    }
  }
  cachedRg = null;
  return null;
}

/** Force re-detect (tests). */
export function resetRgCache(): void {
  cachedRg = undefined;
}

export interface RgMatch {
  path: string;
  line: number;
  text: string;
}

export interface RgSearchOpts {
  cwd: string;
  pattern: string;
  glob?: string;
  caseInsensitive?: boolean;
  maxResults: number;
  searchPath?: string; // relative or absolute under cwd
  signal?: AbortSignal;
  lineClip?: number;
}

/**
 * Run rg --json and collect match lines. Returns null if rg is missing or fails
 * in a way that should fall back to the JS walker (not for "no matches").
 */
export function rgSearch(opts: RgSearchOpts): Promise<RgMatch[] | null> {
  const bin = resolveRg();
  if (!bin) return Promise.resolve(null);

  const args = [
    "--json",
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(Math.max(1, opts.maxResults)),
  ];
  if (opts.caseInsensitive) args.push("-i");
  if (opts.glob) args.push("--glob", opts.glob);
  // Skip heavy dirs even if not gitignored.
  for (const d of [
    "node_modules",
    ".git",
    "dist",
    "out",
    "build",
    ".next",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
    "target",
  ]) {
    args.push("--glob", `!${d}/**`);
  }
  args.push("--", opts.pattern);
  if (opts.searchPath) args.push(opts.searchPath);

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let sawBinary = false;

    const finish = (result: RgMatch[] | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish([]);
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        finish([]);
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", () => {
      // Not on PATH / failed to spawn → fall back.
      if (bin === "rg") cachedRg = null;
      finish(null);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      // rg: 0 = matches, 1 = no matches, 2 = error
      if (code !== 0 && code !== 1) {
        finish(null);
        return;
      }
      const matches: RgMatch[] = [];
      const clip = opts.lineClip ?? 200;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "match" && ev.data?.path?.text != null) {
            const text: string = ev.data.lines?.text ?? "";
            matches.push({
              path: String(ev.data.path.text),
              line: Number(ev.data.line_number) || 0,
              text: text.replace(/\n$/, "").trim().slice(0, clip),
            });
            if (matches.length >= opts.maxResults) break;
          }
        } catch {
          sawBinary = true;
        }
      }
      if (sawBinary && matches.length === 0 && code != null && code > 1) {
        finish(null);
        return;
      }
      finish(matches);
    });
  });
}

/** Format matches as the same path:line: text style the JS grep uses. */
export function formatRgMatches(
  matches: RgMatch[],
  workspaceRoot: string,
  pattern: string,
  max: number,
  groupByFile: boolean = true,
  maxLinesPerFile: number = 20
): string {
  if (!matches.length) return `No matches for /${pattern}/.`;

  // Normalize paths to relative
  const normalized = matches.map((m) => {
    let rel = m.path;
    if (path.isAbsolute(rel) && rel.startsWith(workspaceRoot)) {
      rel = path.relative(workspaceRoot, rel).split(path.sep).join("/");
    }
    return { ...m, path: rel };
  });

  // Group by file
  const byFile = new Map<string, RgMatch[]>();
  for (const m of normalized) {
    const arr = byFile.get(m.path);
    if (arr) arr.push(m);
    else byFile.set(m.path, [m]);
  }

  const files = Array.from(byFile.keys());
  const total = normalized.length;
  const cap = maxLinesPerFile > 0 ? maxLinesPerFile : Infinity;

  // Compact grouped format when many matches across many files
  if (groupByFile && total > 10 && files.length > 3) {
    const lines: string[] = [`${total} match(es) in ${files.length} file(s):`];
    for (const f of files) {
      const cnt = byFile.get(f)!.length;
      lines.push(`  ${f}: ${cnt} match(es)`);
    }
    // First 3 examples
    const examples = normalized.slice(0, 3);
    lines.push("", "Examples:");
    for (const m of examples) {
      lines.push(`  ${m.path}:${m.line}: ${m.text}`);
    }
    return lines.join("\n");
  }

  // Default: show individual matches, capped per file
  const out: string[] = [];
  let shown = 0;
  let cappedMore = false;

  for (const [file, fileMatches] of Array.from(byFile.entries())) {
    if (shown >= max) {
      cappedMore = true;
      break;
    }
    const limit = Math.min(fileMatches.length, cap, max - shown);
    for (let i = 0; i < limit; i++) {
      out.push(`${file}:${fileMatches[i].line}: ${fileMatches[i].text}`);
    }
    shown += limit;
    if (fileMatches.length > limit) {
      out.push(`  … ${fileMatches.length - limit} more match(es) in ${file}`);
      cappedMore = true;
    }
  }

  const cappedStr = total >= max || cappedMore ? " (capped)" : "";
  return `${total} match(es)${cappedStr}:\n${out.join("\n")}`;
}
