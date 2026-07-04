import * as vscode from "vscode";
import { Tool, ToolContext, ToolResult } from "./types";
import { resolveInWorkspace, toRelative } from "./util";

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
  await new Promise((r) => setTimeout(r, 700));
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

function symbolKindName(k: vscode.SymbolKind): string {
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
    "Get the symbol outline of a file (classes, functions, methods with their line ranges) from the language server. MUCH cheaper than reading a whole file — use this first on large files, then read_file with offset/limit to pull just the range you need.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file." },
    },
    required: ["path"],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
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

    return {
      content: `${args.path} (${doc.lineCount} lines) — outline [start-end lines]:\n` + lines.join("\n"),
    };
  },
};

export const diagnosticsTool: Tool = {
  name: "get_diagnostics",
  description:
    "Get current language-server diagnostics (errors and warnings) for the workspace or a specific file. Use SPARINGLY: at most once after a batch of edits to a language with an active language server (TypeScript, Python, etc.). It returns nothing for plain HTML/CSS/JSON/Markdown or when no language server is running, so don't call it for those or after every edit.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative file to scope to (optional; omit for all files).",
      },
      errorsOnly: { type: "boolean", description: "Only return errors (default false)." },
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
