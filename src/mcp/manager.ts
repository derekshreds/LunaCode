import * as vscode from "vscode";
import { McpClient, McpServerConfig, McpToolInfo } from "./client";
import { Tool, ToolResult } from "../agent/tools/types";

/**
 * Owns the configured MCP server processes and bridges their tools into
 * LunaCode's Tool interface. Bridged tools are named mcp__<server>__<tool>
 * and treated as MUTATING (external side effects are unknowable), so they
 * require approval in Standard mode, run freely in Auto, and are hidden in
 * Plan mode.
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private configKey = "";

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly onStatus?: (message: string) => void
  ) {}

  /** Start/stop servers to match the config. No-op when nothing changed. */
  refresh(servers: Record<string, McpServerConfig> | undefined) {
    const key = JSON.stringify(servers ?? {});
    if (key === this.configKey) return;
    this.configKey = key;

    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();

    for (const [name, cfg] of Object.entries(servers ?? {})) {
      if (!cfg || typeof cfg.command !== "string" || !cfg.command.trim()) continue;
      const client = new McpClient(name, cfg, this.output);
      this.clients.set(name, client);
      client
        .start()
        .then(() =>
          this.onStatus?.(
            `MCP server "${name}" connected — ${client.tools.length} tool(s) available.`
          )
        )
        .catch((e) =>
          this.onStatus?.(`MCP server "${name}" failed to start: ${e?.message ?? e}`)
        );
    }
  }

  /** Bridge the currently-connected MCP tools into agent tools. */
  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const [server, client] of this.clients) {
      for (const info of client.tools) {
        tools.push(this.bridgeTool(server, client, info));
      }
    }
    return tools;
  }

  dispose() {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }

  private bridgeTool(server: string, client: McpClient, info: McpToolInfo): Tool {
    return {
      name: mcpToolName(server, info.name),
      description: `[MCP · ${server}] ${info.description ?? info.name}`,
      mutating: true, // side effects unknown — be conservative
      parameters:
        (info.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      execute: async (args, ctx): Promise<ToolResult> => {
        const decision = await ctx.requestApproval({
          kind: `mcp:${server}`,
          title: "Run MCP tool",
          subject: `${server} · ${info.name}`,
          detail: JSON.stringify(args ?? {}, null, 2).slice(0, 2000),
        });
        if (decision !== "approved") {
          return { content: "User rejected the MCP tool call.", isError: true };
        }
        try {
          const text = await client.callTool(info.name, args, ctx.signal);
          return { content: text };
        } catch (e: any) {
          return {
            content: `MCP call ${server}.${info.name} failed: ${e?.message ?? e}`,
            isError: true,
          };
        }
      },
    };
  }
}

/** OpenAI-compatible function names: [a-zA-Z0-9_-], max 64 chars. */
function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
