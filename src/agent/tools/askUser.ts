import { Tool, ToolResult } from "./types";

/**
 * Pause the agent loop to ask the user a clarifying question. Prevents
 * expensive wrong-path refactors when the request is ambiguous.
 *
 * The runner is injected via ToolContext.askUser (same pattern as explore).
 */
export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question and wait. Use when the request is ambiguous or two+ approaches exist.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Clear, specific question.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional multiple-choice options.",
      },
    },
    required: ["question"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) {
      return { content: "ask_user requires a non-empty question.", isError: true };
    }
    if (!ctx.askUser) {
      return {
        content:
          "ask_user is not available in this context. State your assumption and proceed, or stop and wait for the user.",
        isError: true,
      };
    }
    const options = Array.isArray(args.options)
      ? args.options.filter((o: any) => typeof o === "string" && o.trim()).map((o: string) => o.trim())
      : undefined;
    try {
      const answer = await ctx.askUser({ question, options });
      if (!answer || !String(answer).trim()) {
        return {
          content: "User did not provide an answer. State a reasonable default assumption and continue, or stop.",
          isError: true,
        };
      }
      return { content: `User answered: ${String(answer).trim()}` };
    } catch (e: any) {
      return { content: `ask_user failed: ${e?.message ?? e}`, isError: true };
    }
  },
};
