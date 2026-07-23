import { Tool, ToolResult } from "./types";
import { canRunJobsInParallel, combineSubagentReports, DelegatedJob } from "../delegation";

/**
 * Delegates a bounded implementation task to a disposable write-capable
 * sub-agent.  Intermediate reads die with the sub-context; only a summary
 * (+ paths changed) returns to the main conversation.
 *
 * Pass `tasks` (array) to fan out independent implementation work in parallel
 * (max 3) — each task gets its own sub-agent and the summaries are returned
 * together.
 *
 * Injected via ToolContext.implement — absent in Plan mode and inside sub-agents.
 */
export const implementTool: Tool = {
  name: "implement",
  description:
    "Delegate implementation to a write-capable sub-agent. Use jobs with declared paths for conflict-safe parallel work; unscoped tasks are serialized. Returns changes, tests, cost, and evidence. Not available in Plan mode.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Concrete task with enough context (files, approach, constraints).",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Optional write scope for a single task; directory scopes end with /.",
      },
      tasks: {
        type: "array",
        items: { type: "string" },
        description:
          "Independent implementation tasks to run in parallel (max 3). Each task gets its own write-capable sub-agent.",
      },
      jobs: {
        type: "array",
        description: "Scoped implementation jobs (max 3). Disjoint path sets run in parallel; overlapping or missing scopes run serially.",
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: "Concrete implementation task." },
            paths: { type: "array", items: { type: "string" }, description: "Only files this job may write; directory scopes end with /." },
          },
          required: ["task", "paths"],
        },
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.implement) {
      return {
        content:
          "implement is not available in this context (Plan mode, nested sub-agent, or disabled). Do the work with edit_file/apply_patch directly.",
        isError: true,
      };
    }

    // Normalize to a list of tasks.  Prefer `tasks` when both are set.
    const list: DelegatedJob[] = [];
    if (Array.isArray(args.jobs)) {
      for (const job of args.jobs) {
        if (typeof job?.task === "string" && job.task.trim()) {
          list.push({
            task: job.task.trim(),
            paths: Array.isArray(job.paths)
              ? job.paths.filter((p: unknown) => typeof p === "string" && p.trim()).map((p: string) => p.trim())
              : undefined,
          });
        }
      }
    }
    if (!list.length && Array.isArray(args.tasks)) {
      for (const t of args.tasks) {
        if (typeof t === "string" && t.trim()) list.push({ task: t.trim() });
      }
    }
    if (!list.length && typeof args.task === "string" && args.task.trim()) {
      list.push({ task: args.task.trim(), paths: Array.isArray(args.paths) ? args.paths : undefined });
    }
    if (!list.length) {
      return {
        content: "implement requires a non-empty `task` or `tasks` array.",
        isError: true,
      };
    }

    // Cap fan-out so a runaway model can't spawn dozens of sub-agents.
    const MAX_PARALLEL = 3;
    const jobs = list.slice(0, MAX_PARALLEL);
    const truncated = list.length > MAX_PARALLEL;
    const estimate = ctx.estimateDelegation?.("implementation", jobs.length);
    if (estimate) ctx.emitOutput?.(
      `Cost ceiling: ${jobs.length} × ${estimate.maxContextTokens.toLocaleString()} tokens on ${estimate.model}` +
      (estimate.estimatedCost != null ? ` ≈ $${estimate.estimatedCost.toFixed(4)}` : "") + "\n"
    );

    // Single task: request approval once, then run.
    if (jobs.length === 1) {
      const job = jobs[0];
      const decision = await ctx.requestApproval({
        kind: "implement",
        title: "Run implementer sub-agent",
        subject: job.task.slice(0, 200) + (job.task.length > 200 ? "…" : ""),
        detail: job.paths?.length ? `Write scope: ${job.paths.join(", ")}` : "A disposable sub-agent will edit files to complete this task.",
      });
      if (decision === "rejected") {
        return { content: "User rejected the implementer sub-agent.", isError: true };
      }
      try {
        const result = await ctx.implement(job);
        return { content: result.summary, ui: { report: result.report } };
      } catch (e: any) {
        return { content: `Implementer failed: ${e?.message ?? e}`, isError: true };
      }
    }

    // Parallel orchestration: each task runs in its own sub-agent context.
    // Request a single approval covering all sub-tasks.
    const parallel = canRunJobsInParallel(jobs);
    const decision = await ctx.requestApproval({
      kind: "implement",
      title: `Run ${jobs.length} implementer sub-agents ${parallel ? "in parallel" : "safely in sequence"}`,
      subject: `${jobs.length} implementation tasks`,
      detail: jobs
        .map(
          (job, i) =>
            `${i + 1}. ${job.task.slice(0, 120)}${job.task.length > 120 ? "…" : ""}${job.paths?.length ? `\n   paths: ${job.paths.join(", ")}` : "\n   paths: unscoped → serialized"}`,
        )
        .join("\n"),
    });
    if (decision === "rejected") {
      return { content: "User rejected parallel implementer sub-agents.", isError: true };
    }

    ctx.emitOutput?.(
      `Orchestrating ${jobs.length} implementer sub-agents ${parallel ? "in parallel with disjoint write scopes" : "sequentially to prevent write conflicts"}…\n`,
    );
    const runJob = async (job: DelegatedJob, i: number) => {
        ctx.emitOutput?.(
          `[${i + 1}/${jobs.length}] ${job.task.slice(0, 80)}${job.task.length > 80 ? "…" : ""}\n`,
        );
        try {
          const result = await ctx.implement!(job);
          return { t: job.task, result, ok: true as const };
        } catch (e: any) {
          return {
            t: job.task,
            result: undefined,
            error: `Implementer failed: ${e?.message ?? e}`,
            ok: false as const,
          };
        }
    };
    const results: Array<Awaited<ReturnType<typeof runJob>>> = [];
    if (parallel) results.push(...await Promise.all(jobs.map(runJob)));
    else for (let i = 0; i < jobs.length; i++) results.push(await runJob(jobs[i], i));

    const parts = results.map((r, i) => {
      const header = `## Implementation ${i + 1}: ${r.t}`;
      return `${header}\n\n${r.result?.summary ?? r.error}`;
    });
    let content = parts.join("\n\n---\n\n");
    if (truncated) {
      content += `\n\n(Note: ${list.length - MAX_PARALLEL} additional task(s) were dropped — max ${MAX_PARALLEL} implementers.)`;
    }
    const completed = results.flatMap((r) => (r.result ? [r.result] : []));
    return {
      content,
      ...(completed.length ? { ui: { report: combineSubagentReports("implementation", completed) } } : {}),
      isError: completed.length === 0,
    };
  },
};
