import { spawn, ChildProcess } from "child_process";
import * as vscode from "vscode";

/**
 * Minimal Model Context Protocol client over the stdio transport
 * (newline-delimited JSON-RPC 2.0). No SDK dependency — LunaCode only needs
 * initialize / tools/list / tools/call.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const INIT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
/** Cap tool output injected into the conversation. */
const MAX_RESULT_CHARS = 30_000;

export class McpClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private dead = false;

  /** Populated after start(). */
  tools: McpToolInfo[] = [];

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
    private readonly output: vscode.OutputChannel
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      // Windows: resolve npx/node from PATH the way a shell would.
      shell: process.platform === "win32",
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.output.appendLine(`[mcp:${this.name}] ${String(chunk).trimEnd()}`);
    });
    this.proc.on("exit", (code) => {
      this.output.appendLine(`[mcp:${this.name}] exited (code ${code ?? "?"})`);
      this.failAll(new Error(`MCP server "${this.name}" exited (code ${code ?? "?"})`));
    });
    this.proc.on("error", (e) => this.failAll(e));

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lunacode", version: "0.1.0" },
      },
      INIT_TIMEOUT_MS
    );
    this.notify("notifications/initialized", {});
    const res = await this.request("tools/list", {}, INIT_TIMEOUT_MS);
    this.tools = Array.isArray(res?.tools) ? res.tools : [];
  }

  /** Call a tool and flatten its content blocks to text for the model. */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const res = await this.request(
      "tools/call",
      { name, arguments: args ?? {} },
      CALL_TIMEOUT_MS,
      signal
    );
    const parts: string[] = [];
    for (const block of res?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block?.type) parts.push(`[unsupported ${block.type} content omitted]`);
    }
    let text = parts.join("\n").trim() || "(empty result)";
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + "\n…[MCP result truncated]";
    }
    return res?.isError ? `MCP tool reported an error:\n${text}` : text;
  }

  dispose() {
    this.dead = true;
    this.failAll(new Error(`MCP server "${this.name}" was shut down.`));
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }

  // --- JSON-RPC plumbing ---

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<any> {
    if (this.dead || !this.proc?.stdin?.writable) {
      return Promise.reject(new Error(`MCP server "${this.name}" is not running.`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      this.proc!.stdin!.write(payload + "\n");
    });
  }

  private notify(method: string, params: unknown) {
    if (this.dead || !this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout; ignore non-JSON lines
      }
      if (typeof msg?.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      // Server-initiated requests/notifications are ignored (we advertise no
      // capabilities that would invite them).
    }
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}
