import { Tool, ToolResult } from "./types";

/** Produce independent candidate analyses. The parent model remains the judge,
 * so candidate context never pollutes the main transcript. */
export const tournamentTool: Tool = {
  name: "tournament",
  description: "Get two independent analyses for a high-risk decision, then judge and synthesize them.",
  mutating: false,
  group: "meta",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "Problem both candidates analyze." },
    },
    required: ["question"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) return { content: "tournament requires a question.", isError: true };
    if (!ctx.tournament) return { content: "Tournament routing is unavailable in this context.", isError: true };
    const estimate = ctx.estimateDelegation?.("research", 2);
    if (estimate) ctx.emitOutput?.(
      `Tournament ceiling: 2 × ${estimate.maxContextTokens.toLocaleString()} tokens` +
      (estimate.estimatedCost == null ? "" : ` ≈ $${estimate.estimatedCost.toFixed(4)}`) + "\n"
    );
    try {
      const result = await ctx.tournament(question);
      return { content: result.summary, ui: { report: result.report } };
    } catch (e: any) {
      return { content: `Tournament failed: ${e?.message ?? e}`, isError: true };
    }
  },
};
