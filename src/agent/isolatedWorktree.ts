import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { isSensitivePath } from "./tools/util";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout));
    });
  });
}

export interface IsolatedWorktreeResult<T> {
  result: T;
  isolated: boolean;
  changedPaths: string[];
  patchBytes: number;
}

export async function canUseIsolatedWorktree(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one implementer against a disposable worktree built from the caller's
 * tracked working state (`git stash create` does not mutate the caller). The
 * completed binary patch is applied back only after the agent exits. If Git is
 * unavailable, callers may safely fall back to direct scoped execution.
 */
export async function runInIsolatedWorktree<T>(opts: {
  root: string;
  signal: AbortSignal;
  run(worktree: string): Promise<T>;
  beforeApply(paths: string[]): Promise<void>;
  log?(line: string): void;
}): Promise<IsolatedWorktreeResult<T>> {
  await git(opts.root, ["rev-parse", "--is-inside-work-tree"]);
  const common = (await git(opts.root, ["rev-parse", "--show-toplevel"])).trim();
  const snapshot = (await git(opts.root, ["stash", "create", "lunacode isolated implementer"])).trim();
  const base = snapshot || (await git(opts.root, ["rev-parse", "HEAD"])).trim();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunacode-implementer-"));
  // git worktree add requires the target path not to exist.
  await fs.rmdir(dir);
  let keepPatch: string | undefined;
  try {
    await git(common, ["worktree", "add", "--detach", dir, base]);
    // `stash create` includes staged/unstaged tracked state but not untracked
    // source files. Copy those explicitly so the implementer sees the exact
    // caller state. Ignore oversized files to keep delegation bounded.
    const untracked = (await git(opts.root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0").filter(Boolean).slice(0, 500);
    const copiedUntracked: string[] = [];
    for (const rel of untracked) {
      if (isSensitivePath(rel)) continue;
      const src = path.join(opts.root, rel);
      const dest = path.join(dir, rel);
      try {
        const st = await fs.stat(src);
        if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        copiedUntracked.push(rel);
      } catch {
        /* file changed during snapshot; revision guards still protect merge */
      }
    }
    if (copiedUntracked.length) {
      await git(dir, ["add", "--", ...copiedUntracked]);
      await git(dir, [
        "-c", "user.name=Luna Code",
        "-c", "user.email=lunacode@localhost",
        "commit", "--no-gpg-sign", "-m", "lunacode: untracked baseline",
      ]);
    }
    for (const dep of ["node_modules", ".venv", "vendor"]) {
      const src = path.join(opts.root, dep);
      const dest = path.join(dir, dep);
      try {
        await fs.access(src);
        await fs.symlink(src, dest, os.platform() === "win32" ? "junction" : "dir");
      } catch {
        /* optional dependency bridge */
      }
    }
    if (opts.signal.aborted) throw new Error("Implementer cancelled before isolation started.");
    opts.log?.(`Isolated worktree: ${dir}`);
    const result = await opts.run(dir);
    await git(dir, ["add", "-A"]);
    const changedPaths = (await git(dir, ["diff", "--cached", "--name-only", "-z"]))
      .split("\0").filter(Boolean);
    const patch = await git(dir, ["diff", "--cached", "--binary"]);
    if (!patch.trim()) return { result, isolated: true, changedPaths: [], patchBytes: 0 };
    await opts.beforeApply(changedPaths);
    keepPatch = path.join(os.tmpdir(), `lunacode-implementer-${Date.now().toString(36)}.patch`);
    await fs.writeFile(keepPatch, patch, "utf8");
    try {
      try {
        // The patch was based on an exact snapshot of the caller's dirty
        // tracked state, so a normal context apply is the cleanest path.
        await git(opts.root, ["apply", "--binary", keepPatch]);
      } catch {
        // If the user changed a nearby line while the implementer ran, ask Git
        // for a three-way merge instead of overwriting it.
        await git(opts.root, ["apply", "--binary", "--3way", keepPatch]);
      }
      await fs.rm(keepPatch, { force: true });
      keepPatch = undefined;
    } catch (e: any) {
      throw new Error(`Implementer patch could not be merged safely. Patch preserved at ${keepPatch}. ${e?.message ?? e}`);
    }
    opts.log?.(`Merged isolated patch: ${changedPaths.length} file(s), ${Buffer.byteLength(patch)} bytes`);
    return { result, isolated: true, changedPaths, patchBytes: Buffer.byteLength(patch) };
  } finally {
    await git(common, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    await git(common, ["worktree", "prune"]).catch(() => undefined);
    if (keepPatch) opts.log?.(`Conflict patch retained: ${keepPatch}`);
  }
}
