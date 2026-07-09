import * as vscode from "vscode";
import * as fsp from "fs/promises";
import * as path from "path";
import { Tool, ToolContext, ToolResult } from "./types";
import { fileExists, resolveInWorkspace } from "./util";
import { computeDiff } from "../../diff";
import { planLineRangeReplace, planStringReplace } from "../editMatch";

/**
 * Write file contents. If the file is currently open in the editor, route the
 * change through a WorkspaceEdit so it lands on VS Code's native undo stack and
 * doesn't trigger a "file changed on disk" conflict with the buffer; then save
 * so disk (checkpoints, git, disk-based diagnostics) stays consistent. Files
 * that aren't open are written straight to disk as before.
 */
async function writeFileContents(abs: string, content: string): Promise<void> {
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === "file" && d.uri.fsPath === abs
  );
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    const end = open.lineCount > 0 ? open.lineAt(open.lineCount - 1).range.end : new vscode.Position(0, 0);
    edit.replace(open.uri, new vscode.Range(new vscode.Position(0, 0), end), content);
    if (await vscode.workspace.applyEdit(edit)) {
      await Promise.resolve(open.save()).catch(() => {});
      return;
    }
    // Fall through to a disk write if the edit was rejected.
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf8");
}

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a file. Prefer edit_file for targeted changes.",
  mutating: true,
  group: "edit",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    const existed = fileExists(abs);
    const before = existed ? await fsp.readFile(abs, "utf8").catch(() => "") : "";
    const diff = computeDiff(before, args.content, args.path);

    const decision = await ctx.requestApproval({
      kind: "write",
      title: existed ? "Overwrite file" : "Create file",
      subject: args.path,
      diff,
    });
    if (decision === "rejected") {
      return { content: `User rejected writing ${args.path}.`, isError: true };
    }

    await writeFileContents(abs, args.content);
    const lines = args.content.split("\n").length;
    return {
      content: `${existed ? "Overwrote" : "Created"} ${args.path} (${lines} lines).`,
      ui: { path: args.path, action: existed ? "overwrite" : "create", diff },
    };
  },
};

interface PatchChange {
  path: string;
  edits?: Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
  content?: string;
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "Apply edits to MULTIPLE files in one call. Each change is old_string→new_string edits or full content.",
  mutating: true,
  group: "edit",
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path." },
            edits: {
              type: "array",
              description: "Exact-string replacements.",
              items: {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            },
            content: {
              type: "string",
              description: "Full contents (instead of edits).",
            },
          },
          required: ["path"],
        },
      },
    },
    required: ["changes"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const changes: PatchChange[] = Array.isArray(args.changes) ? args.changes : [];
    if (!changes.length) {
      return { content: "apply_patch requires a non-empty changes array.", isError: true };
    }

    // Phase 1: resolve and compute after-states without touching disk.
    type Prepared = {
      change: PatchChange;
      abs: string;
      before: string;
      after: string;
      existed: boolean;
      replacements: number;
      error?: string;
    };
    const prepared: Prepared[] = [];
    for (const change of changes) {
      let abs: string;
      try {
        abs = resolveInWorkspace(ctx.workspaceRoot, change.path);
      } catch (e: any) {
        prepared.push({ change, abs: "", before: "", after: "", existed: false, replacements: 0, error: e.message });
        continue;
      }
      const existed = fileExists(abs);
      const before = existed ? await fsp.readFile(abs, "utf8").catch(() => "") : "";
      if (typeof change.content === "string") {
        prepared.push({ change, abs, before, after: change.content, existed, replacements: 0 });
        continue;
      }
      if (!Array.isArray(change.edits) || !change.edits.length) {
        prepared.push({ change, abs, before, after: before, existed, replacements: 0, error: "no edits or content given" });
        continue;
      }
      if (!existed) {
        prepared.push({ change, abs, before, after: before, existed, replacements: 0, error: "file does not exist (use content to create it)" });
        continue;
      }
      let text = before;
      let replacements = 0;
      let error: string | undefined;
      for (const e of change.edits) {
        const plan = planStringReplace(text, e.old_string, e.new_string, !!e.replace_all);
        if (!plan.ok) {
          error = plan.reason;
          break;
        }
        text = plan.after;
        replacements += plan.count;
      }
      prepared.push({ change, abs, before, after: text, existed, replacements, error });
    }

    const valid = prepared.filter((p) => !p.error);
    if (!valid.length) {
      return {
        content:
          "apply_patch: no file could be applied:\n" +
          prepared.map((p) => `✗ ${p.change.path}: ${p.error}`).join("\n"),
        isError: true,
      };
    }

    // One approval for the whole patch; the diff preview shows the largest change.
    const diffs = valid.map((p) => computeDiff(p.before, p.after, p.change.path));
    const biggest = diffs.reduce((a, b) => (b.addCount + b.delCount > a.addCount + a.delCount ? b : a));
    const decision = await ctx.requestApproval({
      kind: "patch",
      title: "Apply multi-file patch",
      subject: `${valid.length} file(s)`,
      detail: diffs.map((d) => `${d.path}  (+${d.addCount} −${d.delCount})`).join("\n"),
      diff: biggest,
      diffs,
    });
    if (decision === "rejected") {
      return { content: "User rejected the patch.", isError: true };
    }

    const lines: string[] = [];
    for (const p of prepared) {
      if (p.error) {
        lines.push(`✗ ${p.change.path}: ${p.error}`);
        continue;
      }
      try {
        await writeFileContents(p.abs, p.after);
        lines.push(
          typeof p.change.content === "string"
            ? `✓ ${p.change.path} (${p.existed ? "overwrote" : "created"})`
            : `✓ ${p.change.path} (${p.replacements} replacement${p.replacements === 1 ? "" : "s"})`
        );
      } catch (e: any) {
        lines.push(`✗ ${p.change.path}: ${e.message}`);
      }
    }
    return {
      content: `Applied patch:\n${lines.join("\n")}`,
      ui: { diff: biggest, files: valid.length },
    };
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Targeted edit: exact old_string→new_string, or start_line+end_line with new_string for a line-range replace.",
  mutating: true,
  group: "edit",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      old_string: {
        type: "string",
        description:
          "Exact text to find (unique unless replace_all); required unless start_line/end_line.",
      },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences.",
      },
      start_line: {
        type: "number",
        description: "1-based start for line-range replace (with end_line; ignores old_string).",
      },
      end_line: {
        type: "number",
        description: "1-based inclusive end for line-range replace.",
      },
    },
    required: ["path", "new_string"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    let before: string;
    try {
      before = await fsp.readFile(abs, "utf8");
    } catch (e: any) {
      return { content: `Cannot edit ${args.path}: ${e.message}`, isError: true };
    }

    const newString = typeof args.new_string === "string" ? args.new_string : "";
    const useLines =
      args.start_line != null &&
      args.end_line != null &&
      Number.isFinite(Number(args.start_line)) &&
      Number.isFinite(Number(args.end_line));

    let plan;
    if (useLines) {
      plan = planLineRangeReplace(before, Number(args.start_line), Number(args.end_line), newString);
    } else {
      if (typeof args.old_string !== "string" || args.old_string.length === 0) {
        return {
          content:
            "edit_file requires a non-empty old_string (string replace) OR both start_line and end_line (line-range replace). " +
            "new_string alone is not enough — re-issue with the exact text to replace, or a line range from a prior read_file.",
          isError: true,
        };
      }
      plan = planStringReplace(before, args.old_string, newString, !!args.replace_all);
    }

    if (!plan.ok) {
      return { content: `${plan.reason} (file: ${args.path})`, isError: true };
    }

    // Diff the WHOLE file before/after so line numbers and context are real.
    const diff = computeDiff(before, plan.after, args.path);

    const decision = await ctx.requestApproval({
      kind: "edit",
      title: "Edit file",
      subject: args.path,
      diff,
    });
    if (decision === "rejected") {
      return { content: `User rejected editing ${args.path}.`, isError: true };
    }

    await writeFileContents(abs, plan.after);
    const modeNote = plan.mode === "fuzzy" ? " via whitespace-fuzzy match" : "";
    const rangeNote = useLines
      ? ` lines ${args.start_line}-${args.end_line}`
      : ` (${plan.count} replacement${plan.count === 1 ? "" : "s"}${modeNote})`;
    return {
      content: `Edited ${args.path}${rangeNote}.`,
      ui: { path: args.path, action: "edit", replacements: plan.count, diff },
    };
  },
};
