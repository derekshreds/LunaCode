import { spawn } from "child_process";
import * as os from "os";
import { Tool, ToolContext, ToolResult } from "./types";
import { resolveInWorkspace, truncateHeadTail } from "./util";
import { getConfig } from "../../config";

const MAX_OUTPUT_CHARS = 18_000;
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

export function isBlocked(cmd: string): string | null {
  const cfg = getConfig();
  for (const bad of cfg.alwaysDenyCommands) {
    if (cmd.includes(bad)) return bad;
  }
  return null;
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command and capture stdout/stderr. For builds, tests, git, package managers. Not for long-running processes (use start_process).",
  mutating: true,
  group: "exec",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to execute." },
      cwd: {
        type: "string",
        description: "Working dir relative to workspace (optional).",
      },
      timeout_ms: {
        type: "number",
        description: `Timeout ms (default ${DEFAULT_TIMEOUT_MS}).`,
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

    // Smart verify: skip re-running an identical successful test/build if no
    // relevant files have been edited since (saves a full suite + model turn).
    const vc = ctx.verifyCache;
    if (
      vc &&
      vc.exitCode === 0 &&
      vc.command.trim() === String(command).trim() &&
      Date.now() - vc.at < 10 * 60 * 1000 &&
      /\b(test|check|lint|typecheck|tsc|pytest|jest|vitest|cargo test|go test|npm test|pnpm test|yarn test)\b/i.test(
        command
      )
    ) {
      return {
        content:
          `Skipped — still green from earlier this turn/session (` +
          `${Math.round((Date.now() - vc.at) / 1000)}s ago, exit 0). ` +
          `Re-run only if you edited code since then or need a fresh signal.`,
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
        const { text: out } = truncateHeadTail(combine(stdout, stderr), MAX_OUTPUT_CHARS);
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

      child.stdout?.on("data", (d) => {
        const s = d.toString();
        stdout += s;
        ctx.emitOutput?.(s);
      });
      child.stderr?.on("data", (d) => {
        const s = d.toString();
        stderr += s;
        ctx.emitOutput?.(s);
      });

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
        // Keep head + tail so build errors at the end survive truncation.
        const { text } = truncateHeadTail(combined, MAX_OUTPUT_CHARS);
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
