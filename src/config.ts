import * as vscode from "vscode";
import { AgentMode, isMode } from "./modes";

const SECRET_KEY = "lunacode.openrouter.apiKey";

export interface LunaCodeConfig {
  model: string;
  baseUrl: string;
  defaultMode: AgentMode;
  maxTokens: number;
  temperature: number;
  enablePromptCaching: boolean;
  maxContextTokens: number;
  autoApproveCommands: string[];
  alwaysDenyCommands: string[];
  dataCollection: "deny" | "allow";
  zeroDataRetention: boolean;
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
    maxContextTokens: c.get<number>("maxContextTokens", 180000),
    autoApproveCommands: c.get<string[]>("autoApproveCommands", []),
    alwaysDenyCommands: c.get<string[]>("alwaysDenyCommands", []),
    dataCollection: c.get<string>("dataCollection", "deny") === "allow" ? "allow" : "deny",
    zeroDataRetention: c.get<boolean>("zeroDataRetention", false),
  };
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
