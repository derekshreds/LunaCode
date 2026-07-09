import * as vscode from "vscode";
import { Tool, ToolContext, ToolResult } from "./types";
import { dedupHit, makeCacheKey, readCacheGet, readCacheSet, toRelative } from "./util";
import { symbolKindName } from "./vscodeTools";

/**
 * Workspace-wide symbol search via the language server. Returns path:line hits
 * without dumping file contents — cheaper orientation than multi-hop grep.
 */
export const findSymbolTool: Tool = {
  name: "find_symbol",
  description:
    "Find symbols across the workspace via the language server. Returns path:line hits.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Symbol name or partial name.",
      },
      maxResults: {
        type: "number",
        description: "Max hits (default 40, max 100).",
      },
    },
    required: ["query"],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { content: "find_symbol requires a non-empty query.", isError: true };
    }
    const max = Math.min(100, Math.max(1, Math.floor(Number(args.maxResults) || 40)));
    // Raw args, not normalized — the prior call is matched on what the model sent.
    const dup = dedupHit(ctx, "find_symbol", {
      query: args.query,
      maxResults: args.maxResults,
    });
    if (dup) return dup;
    const cacheKey = makeCacheKey("find_symbol", { query, maxResults: max });
    const cached = readCacheGet(cacheKey);
    if (cached) return cached;

    let symbols: vscode.SymbolInformation[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query
      );
    } catch (e: any) {
      return {
        content: `find_symbol failed: ${e?.message ?? e}. Fall back to grep.`,
        isError: true,
      };
    }
    if (!symbols?.length) {
      return {
        content: `No symbols matching "${query}". Try a shorter query, or use grep.`,
      };
    }
    const lines: string[] = [];
    for (const s of symbols.slice(0, max)) {
      if (ctx.signal.aborted) break;
      const uri = s.location?.uri;
      if (!uri || uri.scheme !== "file") continue;
      // Stay inside the active workspace root when possible.
      let rel = uri.fsPath;
      if (uri.fsPath.startsWith(ctx.workspaceRoot)) {
        rel = toRelative(ctx.workspaceRoot, uri.fsPath);
      }
      const line = s.location.range.start.line + 1;
      const container = s.containerName ? ` in ${s.containerName}` : "";
      lines.push(`${rel}:${line}  ${symbolKindName(s.kind)} ${s.name}${container}`);
    }
    if (!lines.length) {
      return { content: `No in-workspace symbols matching "${query}".` };
    }
    const result: ToolResult = {
      content:
        `${lines.length} symbol(s) for "${query}"${symbols.length > max ? " (capped)" : ""}` +
        "\n" +
        lines.join("\n"),
    };
    readCacheSet(cacheKey, result.content);
    return result;
  },
};
