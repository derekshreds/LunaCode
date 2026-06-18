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
