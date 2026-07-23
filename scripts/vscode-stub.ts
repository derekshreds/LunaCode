// Minimal stub so usage.ts (which imports 'vscode' at module scope) can be
// bundled and exercised in plain Node for unit testing.
export const workspace = {
  textDocuments: [],
  applyEdit: async () => false,
};

export class Position {
  constructor(public line: number, public character: number) {}
}
export class Range {
  constructor(public start: Position, public end: Position) {}
}
export class WorkspaceEdit {
  replace() {}
}

export const ConfigurationTarget = { Global: 1 };
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const SymbolKind = new Proxy({}, { get: (_target, key) => String(key) });
export const Uri = { file: (fsPath: string) => ({ fsPath, scheme: "file" }) };
export const languages = { getDiagnostics: () => [] };
export const commands = { executeCommand: async () => [] };
