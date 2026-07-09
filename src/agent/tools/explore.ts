import { Tool, ToolResult } from "./types";

/**
 * Delegates open-ended research to one or more sub-agents, each with its own
 * disposable context. The runner is injected by the Agent via ToolContext.explore
 * (the tool layer has no OpenRouter client of its own), and is absent inside
 * sub-agents so explore can never recurse.
 *
 * Pass `questions` (array) to fan out independent research topics in parallel —
 * each question gets its own sub-agent and the digests are returned together.
 */
export const exploreTool: Tool = {
  name: "explore",
  description:
    "Delegate open-ended research to a sub-agent with its own context; returns a concise digest. Prefer for multi-hop questions. Pass questions (array) for parallel sub-agents.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "Single research question (sub-agent cannot see this conversation).",
      },
      questions: {
        type: "array",
        items: { type: "string" },
        description:
          "Independent research questions in parallel (max 4).",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.explore) {
      return {
        content: "The explore tool is not available in this context.",
        isError: true,
      };
    }

    // Normalize to a list of questions. Prefer `questions` when both are set.
    const list: string[] = [];
    if (Array.isArray(args.questions)) {
      for (const q of args.questions) {
        if (typeof q === "string" && q.trim()) list.push(q.trim());
      }
    }
    if (!list.length && typeof args.question === "string" && args.question.trim()) {
      list.push(args.question.trim());
    }
    if (!list.length) {
      return {
        content: "explore requires a non-empty `question` or `questions` array.",
        isError: true,
      };
    }

    // Cap fan-out so a runaway model can't spawn dozens of sub-agents.
    const MAX_PARALLEL = 4;
    const questions = list.slice(0, MAX_PARALLEL);
    const truncated = list.length > MAX_PARALLEL;

    if (questions.length === 1) {
      const digest = await ctx.explore(questions[0]);
      return { content: digest };
    }

    // Parallel orchestration: each question runs in its own sub-agent context.
    ctx.emitOutput?.(
      `Orchestrating ${questions.length} research sub-agents in parallel…\n`
    );
    const digests = await Promise.all(
      questions.map(async (q, i) => {
        ctx.emitOutput?.(`[${i + 1}/${questions.length}] ${q.slice(0, 80)}${q.length > 80 ? "…" : ""}\n`);
        try {
          const digest = await ctx.explore!(q);
          return { q, digest, ok: true as const };
        } catch (e: any) {
          return {
            q,
            digest: `Explore failed: ${e?.message ?? e}`,
            ok: false as const,
          };
        }
      })
    );

    const parts = digests.map((d, i) => {
      const header = `## Research ${i + 1}: ${d.q}`;
      return `${header}\n\n${d.digest}`;
    });
    let content = parts.join("\n\n---\n\n");
    if (truncated) {
      content += `\n\n(Note: ${list.length - MAX_PARALLEL} additional question(s) were dropped — max ${MAX_PARALLEL} parallel explores.)`;
    }
    return { content };
  },
};
