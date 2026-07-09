import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { Tool, ToolContext, ToolResult } from "./types";
import {
  IGNORED_DIRS,
  dedupHit,
  isProbablyBinary,
  makeCacheKey,
  readCacheGet,
  readCacheSet,
  resolveInWorkspace,
  toRelative,
  truncate,
} from "./util";
import { formatRgMatches, rgSearch } from "./rg";

/** Hard cap on any single read_file result (~6–7.5k tokens). */
const MAX_FILE_CHARS = 30_000;
/** Without offset/limit, stop after this many lines and nudge toward paging. */
const DEFAULT_PAGE_LINES = 250;
/** Without offset/limit, stop after this many raw chars before numbering. */
const DEFAULT_PAGE_CHARS = 12_000;
/** Default max matching lines for grep. */
const DEFAULT_GREP_MAX = 100;
/** Per-match line clip for grep. */
const GREP_LINE_CLIP = 200;

function numberLines(lines: string[], startLine: number): string {
  // Compact "N|" prefix — padStart(6) wasted ~3–5 chars per line.
  return lines.map((l, i) => `${startLine + i}|${l}`).join("\n");
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file. Returns line-numbered contents. Use offset/limit for large files.",
  mutating: false,
  group: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      offset: {
        type: "number",
        description: "1-based start line (optional).",
      },
      limit: {
        type: "number",
        description: "Max lines to read (optional).",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const dup = dedupHit(ctx, "read_file", {
      path: args.path,
      offset: args.offset,
      limit: args.limit,
    });
    if (dup) return dup;

    const cacheKey = makeCacheKey("read_file", {
      path: args.path,
      offset: args.offset,
      limit: args.limit,
    });
    const cached = readCacheGet(cacheKey);
    if (cached) return cached;

    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    let buf: Buffer;
    try {
      buf = await fsp.readFile(abs);
    } catch (e: any) {
      return { content: `Error reading ${args.path}: ${e.message}`, isError: true };
    }
    if (isProbablyBinary(buf)) {
      return {
        content: `${args.path} appears to be a binary file (${buf.length} bytes); not displayed.`,
      };
    }
    const allLines = buf.toString("utf8").split("\n");
    const totalLines = allLines.length;
    const explicitPaging = args.offset != null || args.limit != null;
    const offset = Math.max(1, args.offset ?? 1);

    let limit: number;
    let autoPaged = false;
    if (explicitPaging) {
      limit = args.limit ?? totalLines;
    } else {
      // Unscoped read of a large file: return a head page + guidance instead of
      // dumping tens of thousands of tokens into the conversation.
      let charBudget = 0;
      let end = 0;
      while (end < totalLines && end < DEFAULT_PAGE_LINES) {
        charBudget += allLines[end].length + 1;
        if (charBudget > DEFAULT_PAGE_CHARS) break;
        end++;
      }
      if (end < totalLines && (totalLines > DEFAULT_PAGE_LINES || charBudget > DEFAULT_PAGE_CHARS)) {
        limit = Math.max(1, end);
        autoPaged = true;
      } else {
        limit = totalLines;
      }
    }

    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const numbered = numberLines(slice, offset);
    const { text, truncated } = truncate(numbered, MAX_FILE_CHARS);
    const endLine = offset + slice.length - 1;
    const partial = slice.length < totalLines || autoPaged;
    let header = "";
    if (partial) {
      header = `lines ${offset}-${endLine}/${totalLines}\n`;
    }
    let footer = "";
    if (autoPaged || (truncated && partial)) {
      footer =
        `\n\n…[large file — page with offset/limit]`;
    } else if (truncated) {
      footer = `\n\n…[truncated — re-read with offset/limit]`;
    }
    const result: ToolResult = {
      content: header + text + footer,
      ui: { path: args.path, lines: totalLines, truncated: truncated || autoPaged },
    };
    readCacheSet(cacheKey, result.content, result.isError);
    return result;
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "List directory entries (dirs end with '/'). Skips node_modules, .git, dist.",
  mutating: false,
  group: "read",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative dir (default: root).",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = args.path ? args.path : ".";
    const dup = dedupHit(ctx, "list_dir", { path: args.path ?? "." });
    if (dup) return dup;

    const cacheKey = makeCacheKey("list_dir", { path: args.path ?? "." });
    const cached = readCacheGet(cacheKey);
    if (cached) return cached;
    const abs = resolveInWorkspace(ctx.workspaceRoot, target);
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e: any) {
      return { content: `Error listing ${target}: ${e.message}`, isError: true };
    }
    const sorted = entries
      .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
    const lines = sorted.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const result: ToolResult = {
      content:
        lines.length === 0
          ? `(empty directory: ${target})`
          : `${toRelative(ctx.workspaceRoot, abs)}/\n` + lines.join("\n"),
    };
    readCacheSet(cacheKey, result.content, result.isError);
    return result;
  },
};

function globToRegExp(pattern: string): RegExp {
  // Convert a simple glob (supporting **, *, ?) to a RegExp matching a
  // forward-slash path.
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // consume trailing slash of **/
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob (**, *, ?). Returns paths, newest first.",
  mutating: false,
  group: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob, e.g. '**/*.ts'.",
      },
      path: {
        type: "string",
        description: "Search root (optional).",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const dup = dedupHit(ctx, "glob", { pattern: args.pattern, path: args.path });
    if (dup) return dup;

    const cacheKey = makeCacheKey("glob", { pattern: args.pattern, path: args.path ?? null });
    const cached = readCacheGet(cacheKey);
    if (cached) return cached;
    const root = args.path
      ? resolveInWorkspace(ctx.workspaceRoot, args.path)
      : ctx.workspaceRoot;
    const re = globToRegExp(args.pattern);
    const found: Array<{ rel: string; abs: string }> = [];
    const MAX = 500;

    const walk = async (dir: string) => {
      if (found.length >= MAX || ctx.signal.aborted) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= MAX) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          await walk(abs);
        } else {
          const rel = toRelative(ctx.workspaceRoot, abs);
          if (re.test(rel) || re.test(e.name)) found.push({ rel, abs });
        }
      }
    };
    await walk(root);
    // Stat for newest-first ordering AFTER the walk, in parallel chunks — up
    // to 500 sequential stats mid-walk added real latency.
    const matches: Array<{ rel: string; mtime: number }> = [];
    const CHUNK = 64;
    for (let i = 0; i < found.length; i += CHUNK) {
      const chunk = await Promise.all(
        found.slice(i, i + CHUNK).map(async (f) => ({
          rel: f.rel,
          mtime: await fsp.stat(f.abs).then((s) => s.mtimeMs).catch(() => 0),
        }))
      );
      matches.push(...chunk);
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    const list = matches.map((m) => m.rel);
    return {
      content:
        list.length === 0
          ? `No files matched "${args.pattern}".`
          : `${list.length} match(es)${list.length >= MAX ? " (capped)" : ""}:\n` +
            list.join("\n"),
    };
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search workspace with a regex. Returns path:line hits. Uses ripgrep when available.",
  mutating: false,
  group: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: {
        type: "string",
        description: "Directory or file to search (optional).",
      },
      glob: {
        type: "string",
        description: "Filename glob filter (e.g. '*.ts').",
      },
      caseInsensitive: { type: "boolean", description: "Case-insensitive match." },
      maxResults: {
        type: "number",
        description: `Max matching lines (default ${DEFAULT_GREP_MAX}).`,
      },
      groupByFile: {
        type: "boolean",
        description: "Group matches by file (default true).",
      },
      maxLinesPerFile: {
        type: "number",
        description: "Max lines per file before summarizing (default 20, 0 = unlimited).",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const dup = dedupHit(ctx, "grep", {
      pattern: args.pattern,
      path: args.path,
      glob: args.glob,
      caseInsensitive: args.caseInsensitive,
      maxResults: args.maxResults,
      groupByFile: args.groupByFile,
      maxLinesPerFile: args.maxLinesPerFile,
    });
    if (dup) return dup;

    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.caseInsensitive ? "i" : undefined);
    } catch (e: any) {
      return { content: `Invalid regex: ${e.message}`, isError: true };
    }
    const max = args.maxResults ?? DEFAULT_GREP_MAX;
    const groupByFile = args.groupByFile !== false; // default true
    const maxLinesPerFile = args.maxLinesPerFile ?? 20;

    // Prefer native ripgrep when present (faster, gitignore-aware).
    try {
      const searchPath = args.path
        ? resolveInWorkspace(ctx.workspaceRoot, args.path)
        : undefined;
      const rgMatches = await rgSearch({
        cwd: ctx.workspaceRoot,
        pattern: args.pattern,
        glob: args.glob,
        caseInsensitive: !!args.caseInsensitive,
        maxResults: max,
        searchPath:
          searchPath && searchPath !== ctx.workspaceRoot
            ? toRelative(ctx.workspaceRoot, searchPath)
            : undefined,
        signal: ctx.signal,
        lineClip: GREP_LINE_CLIP,
      });
      if (rgMatches) {
        return {
          content: formatRgMatches(
            rgMatches,
            ctx.workspaceRoot,
            args.pattern,
            max,
            groupByFile,
            maxLinesPerFile
          ),
        };
      }
    } catch {
      /* fall through to JS walker */
    }

    const fileGlob = args.glob ? globToRegExp(args.glob) : null;
    const root = args.path
      ? resolveInWorkspace(ctx.workspaceRoot, args.path)
      : ctx.workspaceRoot;
    // Collect as raw match objects for grouping
    const rawMatches: Array<{ file: string; line: number; text: string }> = [];
    let filesScanned = 0;

    const searchFile = async (abs: string) => {
      if (rawMatches.length >= max || ctx.signal.aborted) return;
      let buf: Buffer;
      try {
        buf = await fsp.readFile(abs);
      } catch {
        return;
      }
      if (isProbablyBinary(buf)) return;
      filesScanned++;
      const rel = toRelative(ctx.workspaceRoot, abs);
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (rawMatches.length >= max) return;
        if (re.test(lines[i])) {
          rawMatches.push({
            file: rel,
            line: i + 1,
            text: lines[i].trim().slice(0, GREP_LINE_CLIP),
          });
        }
      }
    };

    const walk = async (dir: string) => {
      if (rawMatches.length >= max || ctx.signal.aborted) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          await walk(abs);
        } else if (!fileGlob || fileGlob.test(e.name)) {
          await searchFile(abs);
        }
      }
    };

    const stat = await fsp.stat(root).catch(() => null);
    if (stat?.isFile()) {
      await searchFile(root);
    } else {
      await walk(root);
    }

    // Build output with grouping support
    const total = rawMatches.length;
    if (total === 0) {
      return {
        content: `No matches for /${args.pattern}/ (scanned ${filesScanned} files).`,
      };
    }

    // Group by file
    const byFile = new Map<string, typeof rawMatches>();
    for (const m of rawMatches) {
      const arr = byFile.get(m.file);
      if (arr) arr.push(m);
      else byFile.set(m.file, [m]);
    }

    const files = Array.from(byFile.keys());
    const cap = maxLinesPerFile > 0 ? maxLinesPerFile : Infinity;

    // Compact grouped format when many matches across many files
    if (groupByFile && total > 10 && files.length > 3) {
      const lines: string[] = [`${total} match(es) in ${files.length} file(s):`];
      for (const f of files) {
        lines.push(`  ${f}: ${byFile.get(f)!.length} match(es)`);
      }
      // First 3 examples
      const examples = rawMatches.slice(0, 3);
      lines.push("", "Examples:");
      for (const m of examples) {
        lines.push(`  ${m.file}:${m.line}: ${m.text}`);
      }
      return { content: lines.join("\n") };
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
    return {
      content: `${total} match(es)${cappedStr}:\n${out.join("\n")}`,
    };
  },
};
