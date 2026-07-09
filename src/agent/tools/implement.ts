import { Tool, ToolResult } from "./types";

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
    "Delegate a self-contained implementation task to a write-capable sub-agent. Returns a summary of what changed. Pass tasks (array) for parallel independent sub-tasks (max 3). Not available in Plan mode.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Concrete task with enough context (files, approach, constraints).",
      },
      tasks: {
        type: "array",
        items: { type: "string" },
        description:
          "Independent implementation tasks to run in parallel (max 3). Each task gets its own write-capable sub-agent.",
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
    const list: string[] = [];
    if (Array.isArray(args.tasks)) {
      for (const t of args.tasks) {
        if (typeof t === "string" && t.trim()) list.push(t.trim());
      }
    }
    if (!list.length && typeof args.task === "string" && args.task.trim()) {
      list.push(args.task.trim());
    }
    if (!list.length) {
      return {
        content: "implement requires a non-empty `task` or `tasks` array.",
        isError: true,
      };
    }

    // Cap fan-out so a runaway model can't spawn dozens of sub-agents.
    const MAX_PARALLEL = 3;
    const tasks = list.slice(0, MAX_PARALLEL);
    const truncated = list.length > MAX_PARALLEL;

    // Single task: request approval once, then run.
    if (tasks.length === 1) {
      const decision = await ctx.requestApproval({
        kind: "implement",
        title: "Run implementer sub-agent",
        subject: tasks[0].slice(0, 200) + (tasks[0].length > 200 ? "…" : ""),
        detail: "A disposable sub-agent will edit files to complete this task.",
      });
      if (decision === "rejected") {
        return { content: "User rejected the implementer sub-agent.", isError: true };
      }
      try {
        const summary = await ctx.implement(tasks[0]);
        return { content: summary };
      } catch (e: any) {
        return { content: `Implementer failed: ${e?.message ?? e}`, isError: true };
      }
    }

    // Parallel orchestration: each task runs in its own sub-agent context.
    // Request a single approval covering all sub-tasks.
    const decision = await ctx.requestApproval({
      kind: "implement",
      title: `Run ${tasks.length} implementer sub-agents in parallel`,
      subject: `${tasks.length} implementation tasks`,
      detail: tasks
        .map(
          (t, i) =>
            `${i + 1}. ${t.slice(0, 120)}${t.length > 120 ? "…" : ""}`,
        )
        .join("\n"),
    });
    if (decision === "rejected") {
      return { content: "User rejected parallel implementer sub-agents.", isError: true };
    }

    ctx.emitOutput?.(
      `Orchestrating ${tasks.length} implementer sub-agents in parallel…\n`,
    );
    const results = await Promise.all(
      tasks.map(async (t, i) => {
        ctx.emitOutput?.(
          `[${i + 1}/${tasks.length}] ${t.slice(0, 80)}${t.length > 80 ? "…" : ""}\n`,
        );
        try {
          const summary = await ctx.implement!(t);
          return { t, summary, ok: true as const };
        } catch (e: any) {
          return {
            t,
            summary: `Implementer failed: ${e?.message ?? e}`,
            ok: false as const,
          };
        }
      }),
    );

    const parts = results.map((r, i) => {
      const header = `## Implementation ${i + 1}: ${r.t}`;
      return `${header}\n\n${r.summary}`;
    });
    let content = parts.join("\n\n---\n\n");
    if (truncated) {
      content += `\n\n(Note: ${list.length - MAX_PARALLEL} additional task(s) were dropped — max ${MAX_PARALLEL} parallel implementers.)`;
    }
    return { content };
  },
};
