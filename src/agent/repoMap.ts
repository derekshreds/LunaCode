/**
 * Compact workspace map for orientation. Built once per session (mtime-cached
 * under .lunacode/repo-map.txt) and injected into the system prompt so the
 * agent skips multi-hop list_dir/glob rediscovery.
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { IGNORED_DIRS } from "./tools/util";

const CACHE_DIR = ".lunacode";
const CACHE_FILE = "repo-map.txt";
const MAX_MAP_CHARS = 3500;
const MAX_DEPTH = 3;
const MAX_ENTRIES_PER_DIR = 40;

/** In-memory cache: root → {text, at}. TTL 5 min. */
const memCache = new Map<string, { text: string; at: number }>();
const MEM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface PackageHints {
  name?: string;
  scripts?: string[];
  deps?: string[];
}

async function readPackageHints(root: string): Promise<PackageHints> {
  try {
    const raw = await fsp.readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const scripts = pkg.scripts && typeof pkg.scripts === "object"
      ? Object.keys(pkg.scripts).slice(0, 16)
      : undefined;
    const depNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].slice(0, 24);
    return {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      scripts,
      deps: depNames.length ? depNames : undefined,
    };
  } catch {
    return {};
  }
}

async function detectLanguages(root: string): Promise<string[]> {
  const markers: Array<[string, string]> = [
    ["tsconfig.json", "TypeScript"],
    ["package.json", "JavaScript/Node"],
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["Cargo.toml", "Rust"],
    ["go.mod", "Go"],
    ["pom.xml", "Java"],
    ["build.gradle", "Java/Gradle"],
    ["Gemfile", "Ruby"],
    ["composer.json", "PHP"],
    ["*.csproj", "C#"],
  ];
  const found: string[] = [];
  for (const [file, lang] of markers) {
    if (file.includes("*")) continue;
    try {
      await fsp.access(path.join(root, file));
      if (!found.includes(lang)) found.push(lang);
    } catch {
      /* absent */
    }
  }
  return found;
}

async function walkTree(
  root: string,
  dir: string,
  depth: number,
  lines: string[],
  budget: { left: number }
): Promise<void> {
  if (depth > MAX_DEPTH || budget.left <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const sorted = entries
    .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
    .filter((e) => !e.name.startsWith(".") || e.name === ".github")
    .sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_ENTRIES_PER_DIR);

  for (const e of sorted) {
    if (budget.left <= 0) return;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    const indent = "  ".repeat(depth);
    if (e.isDirectory()) {
      const line = `${indent}${e.name}/`;
      lines.push(line);
      budget.left -= line.length + 1;
      await walkTree(root, abs, depth + 1, lines, budget);
    } else {
      // Only list interesting files at depth 0–1; deeper dirs just show structure.
      if (depth <= 1 || /\.(ts|tsx|js|jsx|py|rs|go|md|json|yml|yaml)$/i.test(e.name)) {
        const line = `${indent}${e.name}`;
        lines.push(line);
        budget.left -= line.length + 1;
      }
    }
  }
}

/** Build a fresh repo map string (no cache). */
export async function buildRepoMap(workspaceRoot: string): Promise<string> {
  const parts: string[] = [];
  const langs = await detectLanguages(workspaceRoot);
  const pkg = await readPackageHints(workspaceRoot);
  if (pkg.name) parts.push(`Package: ${pkg.name}`);
  if (langs.length) parts.push(`Languages: ${langs.join(", ")}`);
  if (pkg.scripts?.length) {
    parts.push(`Scripts: ${pkg.scripts.join(", ")}`);
    // Detect test/check/lint commands for quick reference
    const cmds = ["test", "check", "lint"]
      .filter((k) => pkg.scripts!.includes(k))
      .map((k) => `${k}: npm run ${k}`);
    if (cmds.length) parts.push(`Commands: ${cmds.join(", ")}`);
  }
  if (pkg.deps?.length) parts.push(`Deps (sample): ${pkg.deps.join(", ")}`);

  // Entrypoints / common roots
  const entryCandidates = [
    "src",
    "lib",
    "app",
    "packages",
    "apps",
    "server",
    "client",
    "extension.ts",
    "src/extension.ts",
    "src/index.ts",
    "src/main.ts",
    "index.ts",
    "main.py",
    "README.md",
  ];
  const present: string[] = [];
  for (const c of entryCandidates) {
    try {
      await fsp.access(path.join(workspaceRoot, c));
      present.push(c);
    } catch {
      /* skip */
    }
  }
  if (present.length) parts.push(`Entrypoints: ${present.join(", ")}`);

  const treeLines: string[] = [];
  await walkTree(workspaceRoot, workspaceRoot, 0, treeLines, {
    left: MAX_MAP_CHARS - parts.join("\n").length - 40,
  });
  if (treeLines.length) {
    parts.push("Tree:");
    parts.push(treeLines.join("\n"));
  }

  let text = parts.join("\n");
  if (text.length > MAX_MAP_CHARS) {
    text = text.slice(0, MAX_MAP_CHARS) + "\n…[repo map truncated]";
  }
  return text;
}

function cachePath(root: string): string {
  return path.join(root, CACHE_DIR, CACHE_FILE);
}

/** Clear the in-memory cache. If root is omitted, clear all. */
export function invalidateRepoMap(root?: string): void {
  if (root) {
    memCache.delete(root);
  } else {
    memCache.clear();
  }
}

/** Load a cached map if still fresh (default 10 min), else rebuild. */
export async function getRepoMap(
  workspaceRoot: string,
  maxAgeMs = 10 * 60 * 1000
): Promise<string> {
  // In-memory check (5 min TTL)
  const mem = memCache.get(workspaceRoot);
  if (mem && Date.now() - mem.at < MEM_CACHE_TTL) {
    return mem.text;
  }

  // Disk cache check
  const cp = cachePath(workspaceRoot);
  try {
    const st = await fsp.stat(cp);
    if (Date.now() - st.mtimeMs < maxAgeMs) {
      const cached = await fsp.readFile(cp, "utf8");
      if (cached.trim()) {
        memCache.set(workspaceRoot, { text: cached, at: Date.now() });
        return cached;
      }
    }
  } catch {
    /* miss */
  }

  const map = await buildRepoMap(workspaceRoot);
  memCache.set(workspaceRoot, { text: map, at: Date.now() });
  try {
    await fsp.mkdir(path.dirname(cp), { recursive: true });
    await fsp.writeFile(cp, map, "utf8");
  } catch {
    /* cache write is best-effort */
  }
  return map;
}
