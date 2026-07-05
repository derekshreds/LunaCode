import * as vscode from "vscode";
import { AgentMode, isMode } from "./modes";
import { McpServerConfig } from "./mcp/client";

const SECRET_KEY = "lunacode.openrouter.apiKey";

export interface LunaCodeConfig {
  model: string;
  baseUrl: string;
  defaultMode: AgentMode;
  maxTokens: number;
  temperature: number;
  enablePromptCaching: boolean;
  maxContextTokens: number;
  autoBudgetCarryCostUsd: number;
  compactionTargetRatio: number;
  summarizerModel: string;
  subagentModel: string;
  fallbackModels: string[];
  prewarmCache: boolean;
  sessionBudgetUsd: number;
  maxTurns: number;
  includeActiveFile: boolean;
  formatAfterEdit: boolean;
  worktreeMode: boolean;
  customCommands: Record<string, string>;
  autoApproveCommands: string[];
  alwaysDenyCommands: string[];
  dataCollection: "deny" | "allow";
  zeroDataRetention: boolean;
  /** OpenRouter provider ranking; undefined = OpenRouter's default load balancing. */
  providerSort?: "throughput" | "latency" | "price";
  mcpServers: Record<string, McpServerConfig>;
}

export function getConfig(): LunaCodeConfig {
  const c = vscode.workspace.getConfiguration("lunacode");
  const mode = c.get<string>("defaultMode", "standard");
  return {
    model: c.get<string>("model", "deepseek/deepseek-v4-flash"),
    baseUrl: c.get<string>("baseUrl", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    defaultMode: isMode(mode) ? mode : "standard",
    maxTokens: c.get<number>("maxTokens", 0),
    temperature: c.get<number>("temperature", 0),
    enablePromptCaching: c.get<boolean>("enablePromptCaching", true),
    maxContextTokens: c.get<number>("maxContextTokens", 0),
    autoBudgetCarryCostUsd: clamp(c.get<number>("autoBudgetCarryCostUsd", 0.1), 0.01, 2, 0.1),
    compactionTargetRatio: clamp(c.get<number>("compactionTargetRatio", 0.45), 0.2, 0.8, 0.45),
    summarizerModel: c.get<string>("summarizerModel", "").trim(),
    subagentModel: c.get<string>("subagentModel", "").trim(),
    fallbackModels: (c.get<string[]>("fallbackModels", []) ?? []).filter(Boolean),
    prewarmCache: c.get<boolean>("prewarmCache", false),
    sessionBudgetUsd: Math.max(0, c.get<number>("sessionBudgetUsd", 0) || 0),
    maxTurns: Math.max(0, Math.floor(c.get<number>("maxTurns", 200) || 0)),
    includeActiveFile: c.get<boolean>("includeActiveFile", true),
    formatAfterEdit: c.get<boolean>("formatAfterEdit", false),
    worktreeMode: c.get<boolean>("worktreeMode", false),
    customCommands: c.get<Record<string, string>>("customCommands", {}) ?? {},
    autoApproveCommands: c.get<string[]>("autoApproveCommands", []),
    alwaysDenyCommands: c.get<string[]>("alwaysDenyCommands", []),
    dataCollection: c.get<string>("dataCollection", "deny") === "allow" ? "allow" : "deny",
    zeroDataRetention: c.get<boolean>("zeroDataRetention", false),
    providerSort: parseProviderSort(c.get<string>("providerSort", "throughput")),
    mcpServers: c.get<Record<string, McpServerConfig>>("mcpServers", {}) ?? {},
  };
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : fallback));
}

function parseProviderSort(v: string): "throughput" | "latency" | "price" | undefined {
  return v === "throughput" || v === "latency" || v === "price" ? v : undefined;
}

export async function setModel(model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("lunacode")
    .update("model", model, vscode.ConfigurationTarget.Global);
}

export class SecretStore {
  constructor(private secrets: vscode.SecretStorage) {}

  getApiKey(): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(SECRET_KEY));
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key.trim());
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  onChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) listener();
    });
  }
}
