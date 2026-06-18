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
