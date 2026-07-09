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
  /** Cheap model for research/planning iterations; empty = session model. */
  plannerModel: string;
  /** Model for implementer sub-agent; empty = session model. */
  implementerModel: string;
  /** Sub-agent context budget in tokens (explore/implement). */
  subagentMaxContextTokens: number;
  /** Start with read-only tool schemas; expand after first edit/command. */
  progressiveTools: boolean;
  /** Lower reasoning effort on pure research follow-up iterations. */
  adaptiveReasoning: boolean;
  fallbackModels: string[];
  prewarmCache: boolean;
  sessionBudgetUsd: number;
  maxTurns: number;
  /** Soft-block a mutating call if the same file/command (or identical call) is
   * re-issued more than this many times in one turn. Hard-stop only after
   * consecutive fully-blocked rounds. 0 = disabled. */
  loopGuardLimit: number;
  /** Thinking effort passed to reasoning-capable models. "default" = model's own. */
  reasoningEffort: "default" | "off" | "low" | "medium" | "high";
  includeActiveFile: boolean;
  formatAfterEdit: boolean;
  /** Reveal each edited file in a preview tab as the agent writes it. */
  revealEditedFiles: boolean;
  worktreeMode: boolean;
  customCommands: Record<string, string>;
  autoApproveCommands: string[];
  alwaysDenyCommands: string[];
  dataCollection: "deny" | "allow";
  zeroDataRetention: boolean;
  /** OpenRouter provider ranking; undefined = OpenRouter's default load balancing. */
  providerSort?: "throughput" | "latency" | "price";
  /** Allowed provider quantization levels (e.g. ["fp8","fp16","bf16"]); empty =
   * no restriction. Avoids routing to low-precision (fp4) endpoints. */
  quantizations: string[];
  /** Preferred models surfaced first in the model quick-pick; empty = show all. */
  favoriteModels: string[];
  mcpServers: Record<string, McpServerConfig>;
}

export function getConfig(): LunaCodeConfig {
  const c = vscode.workspace.getConfiguration("lunacode");
  const mode = c.get<string>("defaultMode", "standard");
  return {
    model: c.get<string>("model", "z-ai/glm-5.2"),
    baseUrl: c.get<string>("baseUrl", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    defaultMode: isMode(mode) ? mode : "standard",
    maxTokens: c.get<number>("maxTokens", 0),
    temperature: c.get<number>("temperature", 0),
    enablePromptCaching: c.get<boolean>("enablePromptCaching", true),
    maxContextTokens: c.get<number>("maxContextTokens", 0),
    autoBudgetCarryCostUsd: clamp(c.get<number>("autoBudgetCarryCostUsd", 0.1), 0.01, 2, 0.1),
    compactionTargetRatio: clamp(c.get<number>("compactionTargetRatio", 0.35), 0.2, 0.8, 0.35),
    summarizerModel: c.get<string>("summarizerModel", "").trim(),
    subagentModel: c.get<string>("subagentModel", "").trim(),
    plannerModel: c.get<string>("plannerModel", "").trim(),
    implementerModel: c.get<string>("implementerModel", "").trim(),
    subagentMaxContextTokens: Math.max(
      8_000,
      Math.floor(c.get<number>("subagentMaxContextTokens", 60_000) || 60_000)
    ),
    progressiveTools: c.get<boolean>("progressiveTools", true),
    adaptiveReasoning: c.get<boolean>("adaptiveReasoning", true),
    fallbackModels: (c.get<string[]>("fallbackModels", []) ?? []).filter(Boolean),
    prewarmCache: c.get<boolean>("prewarmCache", false),
    sessionBudgetUsd: Math.max(0, c.get<number>("sessionBudgetUsd", 0) || 0),
    maxTurns: Math.max(0, Math.floor(c.get<number>("maxTurns", 200) || 0)),
    loopGuardLimit: Math.max(0, Math.floor(c.get<number>("loopGuardLimit", 10) || 0)),
    reasoningEffort: parseReasoningEffort(c.get<string>("reasoningEffort", "default")),
    includeActiveFile: c.get<boolean>("includeActiveFile", true),
    formatAfterEdit: c.get<boolean>("formatAfterEdit", false),
    revealEditedFiles: c.get<boolean>("revealEditedFiles", false),
    worktreeMode: c.get<boolean>("worktreeMode", false),
    customCommands: c.get<Record<string, string>>("customCommands", {}) ?? {},
    autoApproveCommands: c.get<string[]>("autoApproveCommands", []),
    alwaysDenyCommands: c.get<string[]>("alwaysDenyCommands", []),
    dataCollection: c.get<string>("dataCollection", "deny") === "allow" ? "allow" : "deny",
    zeroDataRetention: c.get<boolean>("zeroDataRetention", false),
    providerSort: parseProviderSort(c.get<string>("providerSort", "throughput")),
    quantizations: sanitizeQuantizations(c.get<string[]>("quantizations", [])),
    favoriteModels: (c.get<string[]>("favoriteModels", []) ?? []).filter(Boolean),
    mcpServers: c.get<Record<string, McpServerConfig>>("mcpServers", {}) ?? {},
  };
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : fallback));
}

function parseProviderSort(v: string): "throughput" | "latency" | "price" | undefined {
  return v === "throughput" || v === "latency" || v === "price" ? v : undefined;
}

function parseReasoningEffort(v: string): "default" | "off" | "low" | "medium" | "high" {
  return v === "off" || v === "low" || v === "medium" || v === "high" ? v : "default";
}

const VALID_QUANTIZATIONS = new Set([
  "int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown",
]);

/** Accept comma- or newline-separated entries, lowercase, and drop anything
 * that isn't a valid OpenRouter quantization — so a stray value can't 400. */
function sanitizeQuantizations(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of raw ?? []) {
    for (const part of String(entry).split(/[,\s]+/)) {
      const q = part.trim().toLowerCase();
      if (VALID_QUANTIZATIONS.has(q) && !out.includes(q)) out.push(q);
    }
  }
  return out;
}

export async function setModel(model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("lunacode")
    .update("model", model, vscode.ConfigurationTarget.Global);
}

export async function setSubagentModel(model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("lunacode")
    .update("subagentModel", model, vscode.ConfigurationTarget.Global);
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
