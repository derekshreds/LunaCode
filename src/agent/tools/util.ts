import * as path from "path";
import * as fs from "fs";

/**
 * Resolve a (possibly relative) path against the workspace root and ensure it
 * stays inside the workspace. Throws on traversal outside the root.
 */
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
  const normalized = path.normalize(abs);
  const root = path.normalize(workspaceRoot);
  const rel = path.relative(root, normalized);
  if (rel === "") return normalized;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path "${p}" resolves outside the workspace and is not allowed.`
    );
  }
  return normalized;
}

export function toRelative(workspaceRoot: string, abs: string): string {
  const rel = path.relative(workspaceRoot, abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Directories that should never be walked during search/glob. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".cache",
  ".vscode-test",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  "target",
  "bin",
  "obj",
]);

export function isProbablyBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text:
      text.slice(0, maxChars) +
      `\n\n…[truncated ${text.length - maxChars} characters]`,
    truncated: true,
  };
}
