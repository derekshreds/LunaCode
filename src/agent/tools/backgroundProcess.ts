import { ChildProcess, spawn } from "child_process";
import * as os from "os";
import { Tool, ToolResult } from "./types";
import { resolveInWorkspace } from "./util";
import { isBlocked } from "./runCommand";

/**
 * Long-running background processes (dev servers, watchers). run_command
 * blocks until exit, so the agent couldn't start a server, probe it, and
 * iterate — these three tools close that loop.
 */

interface BgProc {
  id: string;
  name: string;
  command: string;
  proc: ChildProcess;
  /** Ring buffer of combined stdout+stderr. */
  buffer: string;
  exited: number | null; // exit code once done
}

const MAX_PROCESSES = 5;
const MAX_BUFFER_CHARS = 100_000;
const processes = new Map<string, BgProc>();
let nextId = 1;

/** Kill everything on extension deactivate / session teardown. */
export function disposeAllProcesses() {
  for (const p of processes.values()) {
    try {
      p.proc.kill();
    } catch {
      /* ignore */
    }
  }
  processes.clear();
}

function statusLine(p: BgProc): string {
  return `[${p.id}] ${p.name} — ${p.exited === null ? "running" : `exited (${p.exited})`} — ${p.command}`;
}

export const startProcessTool: Tool = {
  name: "start_process",
  description:
    "Start a LONG-RUNNING command in the background (dev server, watcher, tail). Returns a process id immediately plus the first moments of output. Use read_process to check its output later and stop_process when done. For commands that finish on their own, use run_command instead.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run in the background." },
      cwd: { type: "string", description: "Working directory relative to the workspace root (optional)." },
      name: { type: "string", description: "Short label, e.g. 'dev-server' (optional)." },
    },
    required: ["command"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command: string = args.command;
    const blocked = isBlocked(command);
    if (blocked) {
      return { content: `Blocked: command matches always-deny rule "${blocked}".`, isError: true };
    }
    const live = [...processes.values()].filter((p) => p.exited === null);
    if (live.length >= MAX_PROCESSES) {
      return {
        content: `Too many background processes (${live.length}). Stop one first:\n${live.map(statusLine).join("\n")}`,
        isError: true,
      };
    }
    const decision = await ctx.requestApproval({
      kind: "command",
      title: "Start background process",
      subject: command,
      detail: args.cwd ? `cwd: ${args.cwd}` : undefined,
    });
    if (decision === "rejected") {
      return { content: "User rejected starting the background process.", isError: true };
    }

    const cwd = args.cwd ? resolveInWorkspace(ctx.workspaceRoot, args.cwd) : ctx.workspaceRoot;
    const isWin = os.platform() === "win32";
    const proc = spawn(isWin ? "powershell.exe" : "/bin/sh", isWin ? ["-Command", command] : ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const id = `proc_${nextId++}`;
    const entry: BgProc = {
      id,
      name: args.name || command.split(/\s+/)[0],
      command,
      proc,
      buffer: "",
      exited: null,
    };
    const append = (chunk: Buffer) => {
      entry.buffer += chunk.toString("utf8");
      if (entry.buffer.length > MAX_BUFFER_CHARS) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - MAX_BUFFER_CHARS);
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("exit", (code) => (entry.exited = code ?? -1));
    proc.on("error", (e) => {
      entry.buffer += `\n[spawn error: ${e.message}]`;
      entry.exited = -1;
    });
    processes.set(id, entry);

    // Give it a moment so the model sees startup output (or an instant crash).
    await new Promise((r) => setTimeout(r, 1500));
    const head = entry.buffer.slice(0, 2000);
    return {
      content:
        `Started ${statusLine(entry)}\n` +
        (head ? `--- first output ---\n${head}` : "(no output yet — use read_process to check later)"),
    };
  },
};

export const readProcessTool: Tool = {
  name: "read_process",
  description:
    "Read the recent output of a background process started with start_process. With no id, lists all background processes and their status.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Process id from start_process (optional — omit to list all)." },
      tail_chars: { type: "number", description: "How much of the latest output to return (default 4000)." },
    },
  },
  async execute(args): Promise<ToolResult> {
    if (!args.id) {
      const all = [...processes.values()];
      return {
        content: all.length ? all.map(statusLine).join("\n") : "No background processes.",
      };
    }
    const p = processes.get(args.id);
    if (!p) return { content: `No such process: ${args.id}`, isError: true };
    const tail = Math.min(Math.max(args.tail_chars ?? 4000, 200), 20_000);
    const out = p.buffer.slice(-tail);
    return {
      content: `${statusLine(p)}\n--- latest output ---\n${out || "(no output)"}`,
    };
  },
};

export const stopProcessTool: Tool = {
  name: "stop_process",
  description: "Stop a background process started with start_process.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Process id from start_process." },
    },
    required: ["id"],
  },
  async execute(args): Promise<ToolResult> {
    const p = processes.get(args.id);
    if (!p) return { content: `No such process: ${args.id}`, isError: true };
    if (p.exited !== null) {
      processes.delete(args.id);
      return { content: `${p.name} had already exited (${p.exited}). Removed.` };
    }
    try {
      p.proc.kill();
    } catch {
      /* ignore */
    }
    processes.delete(args.id);
    return { content: `Stopped ${p.name} (${args.id}).` };
  },
};
