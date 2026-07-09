import * as path from "path";
import * as fs from "fs";
import type { ToolContext, ToolResult } from "./types";

/** Short-circuit if an identical live tool result is already in context —
 * replaces a multi-KB repeat with a one-line pointer, for the whole session
 * (unlike the 30s read cache). Works for any read-only tool. */
export function dedupHit(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>
): ToolResult | null {
  const hit = ctx.context?.findLiveToolResult(toolName, args);
  if (!hit) return null;
  return {
    content:
      `Already in context (${toolName}${hit.label ? " " + hit.label : ""}). ` +
      `Do not re-run — use the earlier result. Re-read only if the file was edited or you need a different range.`,
  };
}

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

/**
 * Truncate keeping both head and tail — useful for command output where errors
 * and summaries often land at the end.
 */
export function truncateHeadTail(
  text: string,
  maxChars: number,
  headRatio = 0.4
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.max(200, Math.floor(maxChars * headRatio));
  const tail = Math.max(200, maxChars - head - 80);
  const omitted = text.length - head - tail;
  return {
    text:
      text.slice(0, head) +
      `\n\n…[${omitted} characters omitted]…\n\n` +
      text.slice(text.length - tail),
    truncated: true,
  };
}

// ─── In-memory LRU read cache for tool results ────────────────────────────────

interface CacheEntry {
  content: string
  at: number
  isError?: boolean
}

const cacheStore = new Map<string, CacheEntry>()
const CACHE_TTL = 30_000 // 30s default
const CACHE_MAX = 50

/** Build a canonical cache key from tool name and args (sorted JSON keys). */
export function makeCacheKey(toolName: string, args: any): string {
  const canonical = JSON.stringify(
    args && typeof args === "object"
      ? Object.keys(args)
          .sort()
          .reduce((acc: Record<string, any>, k: string) => {
            acc[k] = args[k]
            return acc
          }, {})
      : args
  )
  return toolName + "|" + canonical
}

/**
 * Retrieve a cached tool result. Returns null if missing, expired, or evicted.
 * Moves entry to end (most-recently-used) on access.
 */
export function readCacheGet(
  key: string
): { content: string; isError?: boolean } | null {
  const entry = cacheStore.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > CACHE_TTL) {
    cacheStore.delete(key)
    return null
  }
  // LRU: move to end
  cacheStore.delete(key)
  cacheStore.set(key, entry)
  return { content: entry.content, isError: entry.isError }
}

/** Store a tool result in the cache (LRU eviction when over max). */
export function readCacheSet(
  key: string,
  content: string,
  isError?: boolean
): void {
  if (cacheStore.has(key)) {
    cacheStore.delete(key)
  } else if (cacheStore.size >= CACHE_MAX) {
    // Evict oldest (first inserted) entry
    const oldest = cacheStore.keys().next()
    if (!oldest.done && oldest.value) {
      cacheStore.delete(oldest.value)
    }
  }
  cacheStore.set(key, { content, at: Date.now(), isError })
}

/**
 * Invalidate cache entries. If a path string is provided, only entries whose
 * key contains that path are removed. If omitted, the entire cache is cleared.
 */
export function readCacheInvalidate(path?: string): void {
  if (!path) {
    cacheStore.clear()
    return
  }
  for (const key of cacheStore.keys()) {
    if (key.includes(path)) {
      cacheStore.delete(key)
    }
  }
}

/**
 * Invalidate all cache entries whose key contains the given file path.
 * Convenience wrapper around readCacheInvalidate.
 */
export function readCacheInvalidatePath(path: string): void {
  readCacheInvalidate(path)
}
