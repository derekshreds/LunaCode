import { Tool, ToolResult } from "./types";

/**
 * Delegates open-ended research to a sub-agent with its own disposable
 * context. The actual runner is injected by the Agent via ToolContext.explore
 * (the tool layer has no OpenRouter client of its own), and is absent inside
 * sub-agents so explore can never recurse.
 */
export const exploreTool: Tool = {
  name: "explore",
  description:
    "Delegate an open-ended research question about this codebase to a fast research sub-agent. It greps, reads, and traces code in a SEPARATE context and returns only a concise digest (files, line numbers, how the pieces connect) — keeping this conversation small and cheap. Use it for questions like 'how does auth work here?', 'where is X handled end-to-end?', or 'what would I need to touch to add Y?'. Do NOT use it to read one specific file you already know (use read_file), or for trivial single greps.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The research question, with enough context to be answered independently (the sub-agent cannot see this conversation).",
      },
    },
    required: ["question"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.explore) {
      return {
        content: "The explore tool is not available in this context.",
        isError: true,
      };
    }
    if (typeof args.question !== "string" || !args.question.trim()) {
      return { content: "explore requires a non-empty question.", isError: true };
    }
    const digest = await ctx.explore(args.question.trim());
    return { content: digest };
  },
};
