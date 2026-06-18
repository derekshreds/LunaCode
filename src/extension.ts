import * as vscode from "vscode";
import {
  LunaCodeController,
  LunaCodeViewProvider,
  openLunaCodeEditor,
} from "./webview/provider";
import { getConfig, setModel, SecretStore } from "./config";
import { OpenRouterClient } from "./openrouter/client";
import { SessionStore } from "./sessions";
import { UsageStore } from "./usage";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Luna Code");
  const secrets = new SecretStore(context.secrets);
  const sessions = new SessionStore(context.workspaceState);
  const usage = new UsageStore(context.globalState);
  const controller = new LunaCodeController(
    context.extensionUri,
    secrets,
    output,
    sessions,
    usage
  );
  const provider = new LunaCodeViewProvider(controller, context.extensionUri);

  context.subscriptions.push(
    // Primary sidebar (Activity Bar) surface.
    vscode.window.registerWebviewViewProvider(
      LunaCodeViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    // Secondary Side Bar surface (the right-hand auxiliary bar, like Claude Code).
    vscode.window.registerWebviewViewProvider(
      LunaCodeViewProvider.auxViewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.openChat", async () => {
      await vscode.commands.executeCommand("lunacode.chatView.focus");
    }),

    vscode.commands.registerCommand("lunacode.openInEditor", () => {
      openLunaCodeEditor(controller, context.extensionUri);
    }),

    vscode.commands.registerCommand("lunacode.openInSecondarySideBar", async () => {
      // Reveal the Secondary Side Bar view (registered via the secondarySideBar
      // contribution). Falls back to toggling the bar if focus fails.
      try {
        await vscode.commands.executeCommand("lunacode.chatViewAux.focus");
      } catch {
        await vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
      }
    }),

    vscode.commands.registerCommand("lunacode.newSession", () => {
      controller.newSession();
    }),

    vscode.commands.registerCommand("lunacode.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "OpenRouter API Key",
        prompt: "Paste your OpenRouter API key (stored securely in VS Code SecretStorage).",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-or-v1-...",
      });
      if (key && key.trim()) {
        await secrets.setApiKey(key);
        vscode.window.showInformationMessage("Luna Code: OpenRouter API key saved.");
        await controller.sendConfig();
      }
    }),

    vscode.commands.registerCommand("lunacode.clearApiKey", async () => {
      await secrets.clearApiKey();
      vscode.window.showInformationMessage("Luna Code: OpenRouter API key cleared.");
      await controller.sendConfig();
    }),

    vscode.commands.registerCommand("lunacode.selectModel", async () => {
      await pickModel(secrets, controller);
    }),

    vscode.commands.registerCommand("lunacode.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage("Luna Code: No text selected.");
        return;
      }
      const text = editor.document.getText(editor.selection);
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      await vscode.commands.executeCommand("lunacode.chatView.focus");
      controller.addSelection(text, file, editor.selection.start.line + 1);
    })
  );

  context.subscriptions.push(
    secrets.onChange(() => {
      void controller.sendConfig();
    })
  );

  output.appendLine("Luna Code activated.");
}

async function pickModel(secrets: SecretStore, controller: LunaCodeController) {
  const cfg = getConfig();
  const apiKey = await secrets.getApiKey();

  // A tiny set of cheap, capable favorites for quick swapping. This is NOT the
  // source of truth — "Browse all" fetches the live OpenRouter catalog, so add
  // long-lived favorites here only and let Browse all cover everything else.
  const curated: vscode.QuickPickItem[] = [
    { label: "deepseek/deepseek-v4-flash", description: "DeepSeek · fastest & cheapest" },
    { label: "deepseek/deepseek-v4-pro", description: "DeepSeek · strong agentic coder, great value" },
    { label: "$(search) Browse all OpenRouter models…", description: "Fetch the full live list" },
  ];

  const choice = await vscode.window.showQuickPick(curated, {
    title: "Select OpenRouter Model",
    placeHolder: `Current: ${cfg.model}`,
  });
  if (!choice) return;

  let modelId = choice.label;
  if (choice.label.startsWith("$(search)")) {
    if (!apiKey) {
      vscode.window.showWarningMessage("Set your API key first to browse models.");
      return;
    }
    modelId = await browseAllModels(apiKey, cfg.baseUrl);
    if (!modelId) return;
  }

  await setModel(modelId);
  vscode.window.showInformationMessage(`Luna Code: model set to ${modelId}`);
  await controller.sendConfig();
}

async function browseAllModels(apiKey: string, baseUrl: string): Promise<string> {
  try {
    const client = new OpenRouterClient({ apiKey, baseUrl, model: "" });
    const models = await client.listModels();
    const items: vscode.QuickPickItem[] = models
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({
        label: m.id,
        description: m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : undefined,
        detail: m.name,
      }));
    const pick = await vscode.window.showQuickPick(items, {
      title: "All OpenRouter Models",
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: "Type to filter…",
    });
    return pick?.label ?? "";
  } catch (e: any) {
    vscode.window.showErrorMessage(`Luna Code: ${e.message}`);
    return "";
  }
}

export function deactivate() {}
