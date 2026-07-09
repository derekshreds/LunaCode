import { execFile } from "child_process";
import { Tool, ToolResult } from "./types";
import { truncateHeadTail } from "./util";

const MAX_OUT = 14_000;

function execGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || err).trim();
          reject(new Error(msg || "git failed"));
        } else {
          resolve(String(stdout));
        }
      }
    );
    if (signal) {
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error("Aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description:
    "Structured git status (branch, staged/unstaged/untracked).",
  mutating: false,
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args, ctx): Promise<ToolResult> {
    try {
      const [branch, porcelain, stash] = await Promise.all([
        execGit(ctx.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], ctx.signal).catch(
          () => "unknown"
        ),
        execGit(ctx.workspaceRoot, ["status", "--porcelain=v1", "-b"], ctx.signal),
        execGit(ctx.workspaceRoot, ["stash", "list"], ctx.signal).catch(() => ""),
      ]);
      const lines = porcelain.split("\n").filter(Boolean);
      const branchLine = lines.find((l) => l.startsWith("## ")) ?? `## ${branch}`;
      const files = lines.filter((l) => !l.startsWith("## "));
      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];
      for (const l of files) {
        const x = l[0];
        const y = l[1];
        const file = l.slice(3);
        if (x === "?" && y === "?") untracked.push(file);
        else {
          if (x !== " " && x !== "?") staged.push(`${x} ${file}`);
          if (y !== " " && y !== "?") unstaged.push(`${y} ${file}`);
        }
      }
      const parts = [
        `Branch: ${branchLine.replace(/^## /, "")}`,
        staged.length ? `Staged (${staged.length}):\n  ${staged.slice(0, 80).join("\n  ")}` : "Staged: (none)",
        unstaged.length
          ? `Unstaged (${unstaged.length}):\n  ${unstaged.slice(0, 80).join("\n  ")}`
          : "Unstaged: (none)",
        untracked.length
          ? `Untracked (${untracked.length}):\n  ${untracked.slice(0, 40).join("\n  ")}`
          : "Untracked: (none)",
      ];
      if (stash.trim()) {
        const n = stash.trim().split("\n").length;
        parts.push(`Stash: ${n} entr${n === 1 ? "y" : "ies"}`);
      }
      return { content: parts.join("\n") };
    } catch (e: any) {
      return { content: `git_status failed: ${e?.message ?? e}`, isError: true };
    }
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  description:
    "Show git diff (working tree and/or staged). Truncated head+tail.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      staged: {
        type: "boolean",
        description: "Staged diff only (default false = unstaged).",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Pathspecs to limit the diff.",
      },
      both: {
        type: "boolean",
        description: "Include unstaged AND staged sections.",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const paths: string[] = Array.isArray(args.paths)
        ? args.paths.filter((p: any) => typeof p === "string")
        : [];
      const sections: string[] = [];
      const run = async (label: string, gitArgs: string[]) => {
        const out = await execGit(ctx.workspaceRoot, gitArgs, ctx.signal);
        if (!out.trim()) {
          sections.push(`## ${label}\n(no changes)`);
        } else {
          const { text } = truncateHeadTail(out, MAX_OUT);
          sections.push(`## ${label}\n${text}`);
        }
      };
      if (args.both) {
        await run("unstaged", ["diff", "--", ...paths]);
        await run("staged", ["diff", "--staged", "--", ...paths]);
      } else if (args.staged) {
        await run("staged", ["diff", "--staged", "--", ...paths]);
      } else {
        await run("unstaged", ["diff", "--", ...paths]);
      }
      return { content: sections.join("\n\n") };
    } catch (e: any) {
      return { content: `git_diff failed: ${e?.message ?? e}`, isError: true };
    }
  },
};

export const gitLogTool: Tool = {
  name: "git_log",
  description: "Recent commits (oneline).",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      n: {
        type: "number",
        description: "Number of commits (default 15, max 40).",
      },
      path: {
        type: "string",
        description: "Optional path to scope history.",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const n = Math.min(40, Math.max(1, Math.floor(Number(args.n) || 15)));
      const gitArgs = ["log", `-${n}`, "--oneline", "--decorate"];
      if (typeof args.path === "string" && args.path.trim()) {
        gitArgs.push("--", args.path.trim());
      }
      const out = await execGit(ctx.workspaceRoot, gitArgs, ctx.signal);
      return { content: out.trim() || "(no commits)" };
    } catch (e: any) {
      return { content: `git_log failed: ${e?.message ?? e}`, isError: true };
    }
  },
};
