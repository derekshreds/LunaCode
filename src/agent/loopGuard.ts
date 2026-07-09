import { ToolCall } from "../openrouter/types";

/**
 * Per-turn loop detection for the agent tool loop.
 *
 * Two signals:
 *  1. Mutation targets — same file rewritten / same command re-run too many times.
 *  2. Exact call signatures — identical tool name + args repeated (second-guessing).
 *
 * Soft-fail by default: excess calls are skipped with a clear message so the model
 * can adapt. A hard stop only fires after the model keeps producing only blocked
 * calls (no progress) for consecutive rounds.
 */

export interface LoopGuardConfig {
  /** Max mutations per target (file/cmd) or identical call signatures this turn. 0 = off. */
  limit: number;
  /**
   * After this many consecutive rounds where every mutating call was blocked,
   * end the turn. Defaults to 2.
   */
  hardStopAfterBlockedRounds?: number;
}

export type LoopCallDecision =
  | { blocked: false }
  | { blocked: true; reason: string; target: string };

export interface LoopRoundResult {
  /** Per-call decisions, parallel to the input calls array. */
  decisions: LoopCallDecision[];
  /** True when the whole turn should end (model is stuck). */
  hardStop: boolean;
  /** Human-readable status when hardStop is true. */
  hardStopMessage?: string;
}

/** Mutation target(s) a tool call acts on. Read-only tools return none. */
export function mutatingTargets(call: ToolCall): string[] {
  const name = call.function.name;
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return [];
  }
  if (name === "run_command" || name === "start_process") {
    const cmd = String(args.command ?? "")
      .trim()
      .slice(0, 100);
    return cmd ? [`cmd:${cmd}`] : [];
  }
  if (name === "write_file" || name === "edit_file") {
    return args.path ? [`file:${args.path}`] : [];
  }
  if (name === "apply_patch") {
    return Array.isArray(args.changes)
      ? args.changes
          .map((c: any) => c?.path)
          .filter(Boolean)
          .map((p: string) => `file:${p}`)
      : [];
  }
  return [];
}

/** Stable stringify (sorted keys) so arg order never splits identity. */
function canonicalize(args: any): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args);
  if (Array.isArray(args)) return "[" + args.map(canonicalize).join(",") + "]";
  return (
    "{" +
    Object.keys(args)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalize(args[k]))
      .join(",") +
    "}"
  );
}

/**
 * Stable signature for exact-duplicate detection. Canonicalizes JSON so key
 * order doesn't create false uniqueness. Non-mutating tools return null.
 */
export function callSignature(call: ToolCall): string | null {
  const targets = mutatingTargets(call);
  if (!targets.length) return null;
  const name = call.function.name;
  let normalized = call.function.arguments ?? "";
  try {
    normalized = canonicalize(JSON.parse(normalized));
  } catch {
    // keep raw
  }
  // Cap so pathological arg dumps don't bloat the map key.
  return `${name}:${normalized.slice(0, 500)}`;
}

export class LoopGuard {
  private editCounts = new Map<string, number>();
  private sigCounts = new Map<string, number>();
  /** Consecutive rounds where every mutating call was blocked. */
  private blockedRounds = 0;
  private readonly limit: number;
  private readonly hardStopAfter: number;

  constructor(cfg: LoopGuardConfig) {
    this.limit = Math.max(0, Math.floor(cfg.limit || 0));
    this.hardStopAfter = Math.max(1, cfg.hardStopAfterBlockedRounds ?? 2);
  }

  get enabled(): boolean {
    return this.limit > 0;
  }

  reset(): void {
    this.editCounts.clear();
    this.sigCounts.clear();
    this.blockedRounds = 0;
  }

  /**
   * Evaluate a round of tool calls. Mutating calls that exceed the limit are
   * marked blocked; non-mutating calls always pass. Counts are updated for
   * every mutating call (including blocked ones) so repeated attempts still
   * accumulate.
   */
  evaluate(calls: ToolCall[]): LoopRoundResult {
    if (!this.enabled) {
      return { decisions: calls.map(() => ({ blocked: false })), hardStop: false };
    }

    const decisions: LoopCallDecision[] = [];
    let mutating = 0;
    let blockedMutating = 0;

    for (const c of calls) {
      const targets = mutatingTargets(c);
      if (!targets.length) {
        decisions.push({ blocked: false });
        continue;
      }
      mutating++;

      // Signature check first — exact re-issue of the same call.
      const sig = callSignature(c);
      if (sig) {
        const sn = (this.sigCounts.get(sig) ?? 0) + 1;
        this.sigCounts.set(sig, sn);
        if (sn > this.limit) {
          blockedMutating++;
          const target = targets[0].replace(/^(file|cmd):/, "");
          decisions.push({
            blocked: true,
            target,
            reason:
              `Loop guard: identical ${c.function.name} call repeated ${sn} times this turn ` +
              `(limit ${this.limit}). Stop retrying the same action — try a different approach, ` +
              `or raise lunacode.loopGuardLimit (0 disables).`,
          });
          continue;
        }
      }

      // Per-target mutation count (file rewritten / command re-run).
      let tripped: string | null = null;
      let trippedCount = 0;
      for (const t of targets) {
        const n = (this.editCounts.get(t) ?? 0) + 1;
        this.editCounts.set(t, n);
        if (n > this.limit && !tripped) {
          tripped = t;
          trippedCount = n;
        }
      }
      if (tripped) {
        blockedMutating++;
        const target = tripped.replace(/^(file|cmd):/, "");
        decisions.push({
          blocked: true,
          target,
          reason:
            `Loop guard: "${target}" was changed ${trippedCount} times this turn ` +
            `(limit ${this.limit}). Stop rewriting it — verify with diagnostics/tests, ` +
            `or raise lunacode.loopGuardLimit (0 disables).`,
        });
      } else {
        decisions.push({ blocked: false });
      }
    }

    // Hard-stop only when the model is stuck: a round with mutating calls where
    // every one was blocked (no progress possible).
    if (mutating > 0 && blockedMutating === mutating) {
      this.blockedRounds++;
    } else if (mutating > 0) {
      this.blockedRounds = 0;
    }

    if (this.blockedRounds >= this.hardStopAfter) {
      const sample = decisions.find((d) => d.blocked);
      const target = sample && sample.blocked ? sample.target : "the same targets";
      return {
        decisions,
        hardStop: true,
        hardStopMessage:
          `Stopped: the model kept retrying blocked mutations on "${target}" ` +
          `(${this.blockedRounds} consecutive blocked rounds). Refine the request, ` +
          `or raise lunacode.loopGuardLimit (0 disables).`,
      };
    }

    return { decisions, hardStop: false };
  }
}
