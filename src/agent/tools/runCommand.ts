import { spawn } from "child_process";
import * as os from "os";
import { Tool, ToolContext, ToolResult } from "./types";
import { resolveInWorkspace, truncate } from "./util";
import { getConfig } from "../../config";

const MAX_OUTPUT_CHARS = 30000;
const DEFAULT_TIMEOUT_MS = 120000;

/** Heuristic: is this command read-only / safe to auto-run? */
function classifyCommand(cmd: string): "safe" | "risky" {
  const trimmed = cmd.trim();
  const cfg = getConfig();
  for (const prefix of cfg.autoApproveCommands) {
    if (trimmed === prefix || trimmed.startsWith(prefix + " ")) return "safe";
  }
  // A few inherently safe read-only commands. Require a trailing space so we
  // match the exact command and not look-alikes (e.g. "ls" must not match
  // "lsblk" / "lsof").
  const safeExact = new Set(["ls", "dir", "pwd"]);
  if (safeExact.has(trimmed)) return "safe";
  const safePrefixes = ["echo ", "ls ", "dir ", "type ", "cat ", "head ", "tail ", "wc "];
  if (safePrefixes.some((p) => trimmed.startsWith(p))) {
    return "safe";
  }
  return "risky";
}

function isBlocked(cmd: string): string | null {
  const cfg = getConfig();
  for (const bad of cfg.alwaysDenyCommands) {
    if (cmd.includes(bad)) return bad;
  }
  return null;
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the workspace and capture its stdout/stderr. Use for builds, tests, git, package managers, and scripts. On Windows the command runs in PowerShell; elsewhere in bash/sh. Long-running or interactive commands are not supported.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The full command line to execute." },
      cwd: {
        type: "string",
        description: "Working directory relative to the workspace root (optional).",
      },
      timeout_ms: {
        type: "number",
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
      },
    },
    required: ["command"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command: string = args.command;
    const blocked = isBlocked(command);
    if (blocked) {
      return {
        content: `Command blocked: it matches the always-deny rule "${blocked}".`,
        isError: true,
      };
    }

    const cwd = args.cwd
      ? resolveInWorkspace(ctx.workspaceRoot, args.cwd)
      : ctx.workspaceRoot;

    const classification = classifyCommand(command);
    // Approval policy:
    //  - plan mode never reaches here (mutating tool is blocked upstream).
    //  - auto mode: run everything autonomously (always-deny still blocks above).
    //  - standard mode: ask for everything not in the auto-approve list.
    const needsApproval =
      ctx.mode === "standard" ? classification !== "safe" : false;

    if (needsApproval) {
      const decision = await ctx.requestApproval({
        kind: "command",
        title: "Run command",
        subject: command,
        detail: `cwd: ${args.cwd ?? "."}`,
      });
      if (decision === "rejected") {
        return { content: `User rejected running: ${command}`, isError: true };
      }
    }

    ctx.log(`$ ${command}`);

    const isWindows = os.platform() === "win32";
    const shell = isWindows ? "powershell.exe" : "/bin/sh";
    const shellArgs = isWindows
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];

    return await new Promise<ToolResult>((resolve) => {
      const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn(shell, shellArgs, {
        cwd,
        env: process.env,
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        const out = combine(stdout, stderr);
        resolve({
          content: `Command timed out after ${timeout}ms.\n${out}`,
          isError: true,
        });
      }, timeout);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill();
        clearTimeout(timer);
        resolve({ content: "Command aborted by user.", isError: true });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ content: `Failed to start command: ${err.message}`, isError: true });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const combined = combine(stdout, stderr);
        const { text } = truncate(combined, MAX_OUTPUT_CHARS);
        const status = code === 0 ? "exit 0" : `exit ${code}`;
        resolve({
          content: `[${status}]\n${text || "(no output)"}`,
          isError: code !== 0,
          ui: { command, exitCode: code },
        });
      });
    });
  },
};

function combine(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trimEnd());
  if (stderr.trim()) parts.push("[stderr]\n" + stderr.trimEnd());
  return parts.join("\n");
}
