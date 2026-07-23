import * as fs from "fs/promises";
import * as path from "path";
import type { RepoIntelligence } from "../controlCenter";
import type { TurnReceipt } from "../webview/protocol";
import { IGNORED_DIRS } from "./tools/util";

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".kt", ".rb", ".php", ".cs", ".cpp", ".c", ".h"]);
const LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin",
  ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".cpp": "C++", ".c": "C", ".h": "C/C++",
};

async function collect(root: string, dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await collect(root, abs, out, limit);
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
}

export async function buildRepoIntelligence(
  root: string,
  receipts: TurnReceipt[] = []
): Promise<RepoIntelligence> {
  const files: string[] = [];
  await collect(root, root, files, 10_000);
  const sources = files.filter((f) => SOURCE_EXT.has(path.extname(f).toLowerCase()));
  const tests = sources.filter((f) => /(^|\/)(?:test|tests|__tests__)\/|(?:\.|_)(?:test|spec)\.[^.]+$/i.test(f));
  const languages = [...new Set(sources.map((f) => LANGUAGE[path.extname(f).toLowerCase()]).filter(Boolean))].sort();
  const modules = new Map<string, number>();
  const moduleOf = (file: string) => {
    const parts = file.split("/");
    return /^(?:src|lib|app|packages|apps)$/.test(parts[0]) && parts.length > 2
      ? `${parts[0]}/${parts[1]}`
      : parts.length > 1 ? parts[0] : "(root)";
  };
  for (const file of sources) {
    const name = moduleOf(file);
    modules.set(name, (modules.get(name) ?? 0) + 1);
  }
  const dependencyCounts = new Map<string, number>();
  for (const file of sources.filter((f) => /\.[cm]?[jt]sx?$/.test(f)).slice(0, 1000)) {
    let text = "";
    try { text = await fs.readFile(path.join(root, file), "utf8"); } catch { continue; }
    const from = moduleOf(file);
    const re = /(?:from\s*|import\s*|require\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g;
    for (let match; (match = re.exec(text)); ) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      const to = moduleOf(target);
      if (to === from) continue;
      const key = `${from}\0${to}`;
      dependencyCounts.set(key, (dependencyCounts.get(key) ?? 0) + 1);
    }
  }
  const dependencies = [...dependencyCounts].map(([key, count]) => {
    const [from, to] = key.split("\0");
    return { from, to, count };
  }).sort((a, b) => b.count - a.count).slice(0, 30);
  const entryCandidates = ["src/index.ts", "src/main.ts", "src/extension.ts", "index.ts", "main.py", "app.py", "cmd", "packages", "apps"];
  const present = new Set(files);
  const entrypoints = entryCandidates.filter((c) => present.has(c) || files.some((f) => f.startsWith(c + "/")));

  const touches = new Map<string, { touches: number; churn: number }>();
  for (const receipt of receipts) {
    for (const file of receipt.files) {
      const prev = touches.get(file.path) ?? { touches: 0, churn: 0 };
      prev.touches++;
      prev.churn += file.added + file.removed;
      touches.set(file.path, prev);
    }
  }
  const hotspots = [...touches].map(([p, v]) => ({ path: p, ...v }))
    .sort((a, b) => b.touches - a.touches || b.churn - a.churn)
    .slice(0, 12);

  const risk: string[] = [];
  if (sources.length > 20 && tests.length === 0) risk.push("No conventional test files were detected.");
  if (files.length >= 10_000) risk.push("Repository scan reached the 10,000-file safety limit.");
  const largest = [...modules].sort((a, b) => b[1] - a[1])[0];
  if (largest && largest[1] > 250) risk.push(`${largest[0]}/ contains ${largest[1]} source files; consider splitting ownership boundaries.`);
  if (hotspots[0]?.touches >= 5) risk.push(`${hotspots[0].path} is a high-change hotspot (${hotspots[0].touches} recorded turns).`);

  return {
    generatedAt: Date.now(),
    languages,
    entrypoints,
    modules: [...modules].map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files).slice(0, 20),
    dependencies,
    hotspots,
    testFiles: tests.length,
    sourceFiles: sources.length,
    risk,
  };
}
