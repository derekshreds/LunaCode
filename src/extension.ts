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
    // Shut down MCP server processes on deactivate.
    { dispose: () => controller.dispose() },
    // Keep the webview (model chip + open settings sheet) in sync with edits
    // made outside it — the model QuickPick or VS Code's settings editor.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("lunacode")) controller.onConfigChanged();
    }),
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
    }),

    // --- editor-native entry points ---

    vscode.commands.registerCommand("lunacode.fixFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const diags = vscode.languages
        .getDiagnostics(editor.document.uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
        .slice(0, 30)
        .map((d) => `${rel}:${d.range.start.line + 1} ${d.message}`);
      if (!diags.length) {
        vscode.window.showInformationMessage(`Luna Code: no problems reported in ${rel}.`);
        return;
      }
      await controller.sendExternal(
        `Fix these problems in ${rel}:\n${diags.join("\n")}`
      );
    }),

    vscode.commands.registerCommand("lunacode.refactorSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const instruction = await vscode.window.showInputBox({
        title: "Refactor selection",
        prompt: "What should Luna do with the selected code?",
        placeHolder: "e.g. extract this into a helper function",
        ignoreFocusOut: true,
      });
      if (!instruction?.trim()) return;
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const sel = editor.selection;
      const text = editor.document.getText(sel).slice(0, 6000);
      await controller.sendExternal(
        `${instruction.trim()}\n\nThe code in question (${rel}, lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\`\`\`\n${text}\n\`\`\``
      );
    }),

    vscode.commands.registerCommand("lunacode.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const sel = editor.selection;
      const text = editor.document.getText(sel).slice(0, 6000);
      await controller.sendExternal(
        `Explain what this code does and any pitfalls (${rel}, lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\`\`\`\n${text}\n\`\`\``
      );
    }),

    vscode.commands.registerCommand("lunacode.mergeSandbox", () => controller.mergeSandbox()),
    vscode.commands.registerCommand("lunacode.discardSandbox", () => controller.discardSandbox()),
    vscode.commands.registerCommand("lunacode.exportSession", () => controller.exportSession()),
    vscode.commands.registerCommand("lunacode.selectWorkspaceFolder", () =>
      controller.pickWorkspaceFolder()
    ),

    // Quick-fix lightbulb: "Fix with Luna Code" on any diagnostic.
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      {
        provideCodeActions(document, range, ctx) {
          const relevant = ctx.diagnostics.filter(
            (d) => d.severity <= vscode.DiagnosticSeverity.Warning
          );
          if (!relevant.length) return [];
          const action = new vscode.CodeAction(
            "Fix with Luna Code",
            vscode.CodeActionKind.QuickFix
          );
          action.command = {
            command: "lunacode.fixDiagnosticAt",
            title: "Fix with Luna Code",
            arguments: [document.uri, relevant.map((d) => ({
              line: d.range.start.line + 1,
              message: d.message,
            }))],
          };
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.commands.registerCommand(
      "lunacode.fixDiagnosticAt",
      async (uri: vscode.Uri, diags: Array<{ line: number; message: string }>) => {
        const rel = vscode.workspace.asRelativePath(uri);
        const list = diags.map((d) => `${rel}:${d.line} ${d.message}`).join("\n");
        await controller.sendExternal(`Fix this problem:\n${list}`);
      }
    )
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
