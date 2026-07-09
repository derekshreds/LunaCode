import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { Tool, ToolContext, ToolResult } from "./types";
import { dedupHit, resolveInWorkspace, toRelative, truncate, makeCacheKey, readCacheGet, readCacheSet } from "./util";

function severityName(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

/**
 * After a successful file edit, wait briefly for the language server to
 * re-check, then return that file's errors (and warnings) formatted for the
 * model — or null when the file is clean / has no language server. Injected
 * into the edit tool's own result so the model sees breakage immediately
 * instead of one full round-trip later.
 */
export async function postEditDiagnostics(
  workspaceRoot: string,
  relPath: string,
  signal: AbortSignal
): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 400));
  if (signal.aborted) return null;
  let abs: string;
  try {
    abs = resolveInWorkspace(workspaceRoot, relPath);
  } catch {
    return null;
  }
  const diags = vscode.languages.getDiagnostics(vscode.Uri.file(abs));
  const relevant = diags.filter(
    (d) =>
      d.severity === vscode.DiagnosticSeverity.Error ||
      d.severity === vscode.DiagnosticSeverity.Warning
  );
  if (relevant.length === 0) return null;
  const lines = relevant
    .slice(0, 25)
    .map(
      (d) =>
        `${relPath}:${d.range.start.line + 1}:${d.range.start.character + 1} [${severityName(
          d.severity
        )}] ${d.message}${d.source ? ` (${d.source})` : ""}`
    );
  const extra = relevant.length > 25 ? `\n…and ${relevant.length - 25} more` : "";
  return `Diagnostics after this edit (fix errors before moving on):\n${lines.join("\n")}${extra}`;
}

/**
 * Post-edit lint gate: detect the project's linter, run it on the specific
 * file, and return the output (truncated to 2000 chars). Returns null when no
 * linter is detected or the linter produces no output.
 *
 * Detected linters (in priority order):
 *  - eslint (config: .eslintrc.*, eslint.config.*)
 *  - biome (config: biome.json)
 *  - ruff (config: pyproject.toml [tool.ruff])
 *  - pylint (config: .pylintrc)
 *  - clippy (config: Cargo.toml)
 */
export async function postEditLint(
  workspaceRoot: string,
  relPath: string
): Promise<string | null> {
  const linter = detectLinter(workspaceRoot);
  if (!linter) return null;

  const abs = path.resolve(workspaceRoot, relPath);
  if (!fs.existsSync(abs)) return null;

  return await runLinter(linter, abs, workspaceRoot);
}

interface LinterConfig {
  cmd: string;
  args: string[];
}

function detectLinter(workspaceRoot: string): LinterConfig | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(workspaceRoot);
  } catch {
    return null;
  }
  const has = (name: string) => entries.includes(name);
  const hasMatch = (re: RegExp) => entries.some((e) => re.test(e));

  // Priority: eslint, biome, ruff, pylint, clippy
  if (hasMatch(/^\.eslintrc\./) || hasMatch(/^eslint\.config\./) || has(".eslintrc")) {
    return { cmd: "npx", args: ["eslint", "--format", "compact", "--no-color"] };
  }
  if (has("biome.json") || has("biome.jsonc")) {
    return { cmd: "npx", args: ["biome", "lint"] };
  }
  if (has("pyproject.toml") || has("ruff.toml")) {
    // Prefer ruff when present; fall through if binary missing (runLinter handles that).
    return { cmd: "ruff", args: ["check"] };
  }
  if (has(".pylintrc") || has("pylintrc")) {
    return { cmd: "pylint", args: ["--output-format=text"] };
  }
  if (has("Cargo.toml")) {
    // Clippy needs a package context; lint the whole package (file path ignored by cargo).
    return { cmd: "cargo", args: ["clippy", "--message-format=short", "--", "-A", "warnings"] };
  }
  return null;
}

function runLinter(
  linter: LinterConfig,
  filePath: string,
  cwd: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const args =
      linter.cmd === "cargo" ? [...linter.args] : [...linter.args, filePath];
    const child = spawn(linter.cmd, args, {
      cwd,
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(null); // timeout → treat as no output
    }, 5000);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // Clean exit — remaining output is version banners / summary noise,
        // not actionable; don't spend transcript tokens on it.
        resolve(null);
        return;
      }
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n[stderr]\n");
      if (!combined) {
        resolve(null);
        return;
      }
      // Truncate to 2000 chars max
      const { text } = truncate(combined, 2000);
      resolve(`[Lint exit ${code}]\n${text}`);
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null); // linter not installed / not found
    });
  });
}

/** Best-effort: format an edited file with the workspace's formatter so agent
 * edits match project style (and never trigger format-only lint noise). */
export async function formatFile(workspaceRoot: string, relPath: string): Promise<void> {
  try {
    const abs = resolveInWorkspace(workspaceRoot, relPath);
    const uri = vscode.Uri.file(abs);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      uri,
      { tabSize: 2, insertSpaces: true }
    );
    if (!edits || edits.length === 0) return;
    const we = new vscode.WorkspaceEdit();
    we.set(uri, edits);
    const applied = await vscode.workspace.applyEdit(we);
    if (applied) await doc.save();
  } catch {
    // No formatter for this language, or it errored — never block the edit.
  }
}

export function symbolKindName(k: vscode.SymbolKind): string {
  // Compact, model-friendly names for the common kinds.
  const names: Partial<Record<vscode.SymbolKind, string>> = {
    [vscode.SymbolKind.File]: "file",
    [vscode.SymbolKind.Module]: "module",
    [vscode.SymbolKind.Namespace]: "namespace",
    [vscode.SymbolKind.Class]: "class",
    [vscode.SymbolKind.Method]: "method",
    [vscode.SymbolKind.Property]: "prop",
    [vscode.SymbolKind.Field]: "field",
    [vscode.SymbolKind.Constructor]: "ctor",
    [vscode.SymbolKind.Enum]: "enum",
    [vscode.SymbolKind.Interface]: "interface",
    [vscode.SymbolKind.Function]: "fn",
    [vscode.SymbolKind.Variable]: "var",
    [vscode.SymbolKind.Constant]: "const",
    [vscode.SymbolKind.Struct]: "struct",
    [vscode.SymbolKind.EnumMember]: "enum-member",
    [vscode.SymbolKind.TypeParameter]: "type-param",
  };
  return names[k] ?? "symbol";
}

export const outlineTool: Tool = {
  name: "file_outline",
  description:
    "Symbol outline of a file (classes, functions, methods with line ranges). Prefer over whole-file reads.",
  mutating: false,
  group: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
    },
    required: ["path"],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const dup = dedupHit(ctx, "file_outline", { path: args.path });
    if (dup) return dup;
    const cacheKey = makeCacheKey("file_outline", { path: args.path });
    const cached = readCacheGet(cacheKey);
    if (cached) return cached;

    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    const uri = vscode.Uri.file(abs);
    let doc: vscode.TextDocument;
    try {
      // Loading the document also wakes the language server for this file.
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (e: any) {
      return { content: `Error opening ${args.path}: ${e?.message ?? e}`, isError: true };
    }
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >("vscode.executeDocumentSymbolProvider", uri);

    if (!symbols || symbols.length === 0) {
      return {
        content: `No outline available for ${args.path} (${doc.lineCount} lines) — no language server for this file type, or it is still starting. Use read_file with offset/limit instead.`,
      };
    }

    const lines: string[] = [];
    const walk = (syms: (vscode.DocumentSymbol | vscode.SymbolInformation)[], depth: number) => {
      for (const s of syms) {
        if (lines.length >= 400) return;
        const range = "range" in s ? s.range : s.location.range;
        const indent = "  ".repeat(depth);
        lines.push(
          `${indent}${symbolKindName(s.kind)} ${s.name}  [${range.start.line + 1}-${range.end.line + 1}]`
        );
        if ("children" in s && s.children?.length) walk(s.children, depth + 1);
      }
    };
    walk(symbols, 0);

    const result: ToolResult = {
      content: `${args.path} (${doc.lineCount} lines) — outline [start-end lines]:\n` + lines.join("\n"),
    };
    readCacheSet(cacheKey, result.content);
    return result;
  },
};

export const diagnosticsTool: Tool = {
  name: "get_diagnostics",
  description:
    "Language-server diagnostics for workspace or one file. Prefer auto-appended post-edit diagnostics.",
  mutating: false,
  group: "read",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File to scope to (optional; omit for all).",
      },
      errorsOnly: { type: "boolean", description: "Only errors (default false)." },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // Give the language server a brief moment to catch up after edits.
    await new Promise((r) => setTimeout(r, 300));

    let all = vscode.languages.getDiagnostics();
    if (args.path) {
      const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
      const uri = vscode.Uri.file(abs);
      all = all.filter(([u]) => u.fsPath === uri.fsPath);
    }

    const lines: string[] = [];
    let count = 0;
    for (const [uri, diags] of all) {
      for (const d of diags) {
        if (args.errorsOnly && d.severity !== vscode.DiagnosticSeverity.Error) {
          continue;
        }
        const rel = toRelative(ctx.workspaceRoot, uri.fsPath);
        lines.push(
          `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${severityName(
            d.severity
          )}] ${d.message}${d.source ? ` (${d.source})` : ""}`
        );
        count++;
        if (count >= 200) break;
      }
      if (count >= 200) break;
    }

    return {
      content:
        lines.length === 0
          ? "No diagnostics. ✓"
          : `${lines.length} diagnostic(s):\n` + lines.join("\n"),
    };
  },
};

/**
 * Find all references to a symbol at a given file:line using the language
 * server's reference provider. Returns results grouped by file with line text
 * context.
 */
export const findReferencesTool: Tool = {
  name: "find_references",
  description:
    "Find all references to a symbol across the workspace. Specify file path and line number.",
  mutating: false,
  group: "read",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File containing the symbol.",
      },
      line: {
        type: "number",
        description: "1-based line of the symbol.",
      },
      column: {
        type: "number",
        description: "1-based column (default 1).",
      },
    },
    required: ["path", "line"],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    const uri = vscode.Uri.file(abs);
    const line = Math.max(1, Math.floor(Number(args.line) || 1));
    const col = Math.max(1, Math.floor(Number(args.column) || 1));
    // Raw args, not normalized — the prior call is matched on what the model sent.
    const dup = dedupHit(ctx, "find_references", {
      path: args.path,
      line: args.line,
      column: args.column,
    });
    if (dup) return dup;
    const position = new vscode.Position(line - 1, col - 1);

    // Load the document so the language server is active for this file.
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch (e: any) {
      return {
        content: `Error opening ${args.path}: ${e?.message ?? e}`,
        isError: true,
      };
    }

    let references: vscode.Location[] | undefined;
    try {
      references = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        uri,
        position
      );
    } catch (e: any) {
      return {
        content: `find_references failed: ${e?.message ?? e}. No language server for this file type, or it is still starting.`,
        isError: true,
      };
    }

    if (!references || references.length === 0) {
      return { content: `No references found at ${args.path}:${line}:${col}.` };
    }

    // Group by file and show line text context.
    const byFile = new Map<string, vscode.Location[]>();
    for (const ref of references) {
      let key = ref.uri.fsPath;
      if (key.startsWith(ctx.workspaceRoot)) {
        key = toRelative(ctx.workspaceRoot, key);
      }
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(ref);
    }

    const resultLines: string[] = [];
    let total = 0;
    for (const [file, locs] of byFile) {
      if (total >= 80) {
        resultLines.push(`…and ${references.length - total} more references.`);
        break;
      }
      resultLines.push(`── ${file} ──`);
      for (const loc of locs.slice(0, 20)) {
        if (total >= 80) break;
        const r = loc.range;
        const refLine = r.start.line + 1;
        const refCol = r.start.character + 1;
        // Try to read the source line for context.
        let lineText = "";
        try {
          const doc = await vscode.workspace.openTextDocument(loc.uri);
          if (r.start.line < doc.lineCount) {
            lineText = doc.lineAt(r.start.line).text.trim();
          }
        } catch {
          // File may not be open — skip context.
        }
        const context = lineText ? `  // ${lineText}` : "";
        resultLines.push(`  ${file}:${refLine}:${refCol}${context}`);
        total++;
      }
    }

    return {
      content: `${total} reference(s) for ${args.path}:${line}:${col}:\n` + resultLines.join("\n"),
    };
  },
};
