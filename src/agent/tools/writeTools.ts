import * as fsp from "fs/promises";
import * as path from "path";
import { Tool, ToolContext, ToolResult } from "./types";
import { fileExists, resolveInWorkspace } from "./util";
import { computeDiff } from "../../diff";

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing file with the given contents. Prefer edit_file for targeted changes to existing files. Parent directories are created automatically.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      content: { type: "string", description: "Full file contents to write." },
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

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, args.content, "utf8");
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
    "Apply changes to MULTIPLE files in ONE call — much cheaper and faster than sequential edit_file calls when a change spans files (each extra round-trip re-sends the whole conversation). Each change either edits an existing file via exact old_string→new_string replacements, or creates/overwrites a file by giving full content. Files whose edits don't match are skipped and reported; the rest still apply.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            edits: {
              type: "array",
              description: "Exact-string replacements to apply to an existing file, in order.",
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
              description: "Full contents — creates or overwrites the file (instead of edits).",
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
        const count = text.split(e.old_string).length - 1;
        if (count === 0) {
          error = `old_string not found: "${e.old_string.slice(0, 60)}${e.old_string.length > 60 ? "…" : ""}"`;
          break;
        }
        if (count > 1 && !e.replace_all) {
          error = `old_string appears ${count} times (add context or replace_all): "${e.old_string.slice(0, 60)}…"`;
          break;
        }
        text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, e.new_string);
        replacements += e.replace_all ? count : 1;
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
        await fsp.mkdir(path.dirname(p.abs), { recursive: true });
        await fsp.writeFile(p.abs, p.after, "utf8");
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
    "Make a targeted edit to an existing file by replacing an exact string. The old_string must appear EXACTLY ONCE (include enough surrounding context to be unique). Set replace_all to replace every occurrence. This is the preferred way to modify existing files.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      old_string: {
        type: "string",
        description: "Exact text to find. Must be unique unless replace_all is true.",
      },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences instead of requiring uniqueness.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const abs = resolveInWorkspace(ctx.workspaceRoot, args.path);
    let before: string;
    try {
      before = await fsp.readFile(abs, "utf8");
    } catch (e: any) {
      return { content: `Cannot edit ${args.path}: ${e.message}`, isError: true };
    }

    if (args.old_string === args.new_string) {
      return { content: "old_string and new_string are identical; nothing to do.", isError: true };
    }

    const count = before.split(args.old_string).length - 1;
    if (count === 0) {
      return {
        content: `old_string not found in ${args.path}. Read the file and copy the exact text (including whitespace).`,
        isError: true,
      };
    }
    if (count > 1 && !args.replace_all) {
      return {
        content: `old_string appears ${count} times in ${args.path}. Add more surrounding context to make it unique, or set replace_all: true.`,
        isError: true,
      };
    }

    const after = args.replace_all
      ? before.split(args.old_string).join(args.new_string)
      : before.replace(args.old_string, args.new_string);

    // Diff the WHOLE file before/after so line numbers and context are real.
    const diff = computeDiff(before, after, args.path);

    const decision = await ctx.requestApproval({
      kind: "edit",
      title: "Edit file",
      subject: args.path,
      diff,
    });
    if (decision === "rejected") {
      return { content: `User rejected editing ${args.path}.`, isError: true };
    }

    await fsp.writeFile(abs, after, "utf8");
    return {
      content: `Edited ${args.path} (${count} replacement${count === 1 ? "" : "s"}).`,
      ui: { path: args.path, action: "edit", replacements: count, diff },
    };
  },
};
