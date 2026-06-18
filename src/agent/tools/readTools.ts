import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { Tool, ToolContext, ToolResult } from "./types";
import {
  IGNORED_DIRS,
  isProbablyBinary,
  resolveInWorkspace,
  toRelative,
  truncate,
} from "./util";

const MAX_FILE_CHARS = 60000;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. Returns the file contents with line numbers. Use offset/limit to page through large files.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file." },
      offset: {
        type: "number",
        description: "1-based line number to start reading from (optional).",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read (optional).",
      },
    },
    required: ["path"],
  },
  async execute(args, ctx): Promise<ToolResult> {
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
    const offset = Math.max(1, args.offset ?? 1);
    const limit = args.limit ?? allLines.length;
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((l, i) => `${String(offset + i).padStart(6)}\t${l}`)
      .join("\n");
    const { text, truncated } = truncate(numbered, MAX_FILE_CHARS);
    const header =
      slice.length < allLines.length
        ? `(showing lines ${offset}-${offset + slice.length - 1} of ${allLines.length})\n`
        : "";
    return {
      content: header + text,
      ui: { path: args.path, lines: allLines.length, truncated },
    };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "List the entries of a directory in the workspace. Directories are suffixed with '/'. Ignores node_modules, .git, dist, and similar.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative directory path. Defaults to the workspace root.",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = args.path ? args.path : ".";
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
    return {
      content:
        lines.length === 0
          ? `(empty directory: ${target})`
          : `${toRelative(ctx.workspaceRoot, abs)}/\n` + lines.join("\n"),
    };
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
    "Find files by glob pattern (supports ** , * , ?). Returns workspace-relative paths sorted by modification time (newest first). Good for locating files by name when you don't know the exact path.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob, e.g. '**/*.ts' or 'src/**/index.*'.",
      },
      path: {
        type: "string",
        description: "Directory to search within (optional, defaults to root).",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const root = args.path
      ? resolveInWorkspace(ctx.workspaceRoot, args.path)
      : ctx.workspaceRoot;
    const re = globToRegExp(args.pattern);
    const matches: Array<{ rel: string; mtime: number }> = [];
    const MAX = 500;

    const walk = async (dir: string) => {
      if (matches.length >= MAX || ctx.signal.aborted) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= MAX) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          await walk(abs);
        } else {
          const rel = toRelative(ctx.workspaceRoot, abs);
          if (re.test(rel) || re.test(e.name)) {
            let mtime = 0;
            try {
              mtime = (await fsp.stat(abs)).mtimeMs;
            } catch {
              /* ignore */
            }
            matches.push({ rel, mtime });
          }
        }
      }
    };
    await walk(root);
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
    "Search file contents with a regular expression across the workspace. Returns matching lines with file paths and line numbers. Use this to find symbols, usages, or text.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: {
        type: "string",
        description: "Directory or file to search within (optional).",
      },
      glob: {
        type: "string",
        description: "Only search files whose name matches this glob (optional, e.g. '*.ts').",
      },
      caseInsensitive: { type: "boolean", description: "Case-insensitive match." },
      maxResults: {
        type: "number",
        description: "Max matching lines to return (default 200).",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.caseInsensitive ? "i" : undefined);
    } catch (e: any) {
      return { content: `Invalid regex: ${e.message}`, isError: true };
    }
    const fileGlob = args.glob ? globToRegExp(args.glob) : null;
    const root = args.path
      ? resolveInWorkspace(ctx.workspaceRoot, args.path)
      : ctx.workspaceRoot;
    const max = args.maxResults ?? 200;
    const results: string[] = [];
    let filesScanned = 0;

    const searchFile = async (abs: string) => {
      if (results.length >= max || ctx.signal.aborted) return;
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
        if (results.length >= max) return;
        if (re.test(lines[i])) {
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        }
      }
    };

    const walk = async (dir: string) => {
      if (results.length >= max || ctx.signal.aborted) return;
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

    return {
      content:
        results.length === 0
          ? `No matches for /${args.pattern}/ (scanned ${filesScanned} files).`
          : `${results.length} match(es)${results.length >= max ? " (capped)" : ""}:\n` +
            results.join("\n"),
    };
  },
};
