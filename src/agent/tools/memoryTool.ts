import { Tool, ToolResult } from "./types";
import { applyStickyUpdate, stickyIsEmpty } from "../stickyMemory";

/**
 * Update the session scratchpad that survives compaction. Prefer this for
 * durable-within-session facts (goal, decisions, known test command) rather
 * than re-deriving them after every compact.
 */
export const updateMemoryTool: Tool = {
  name: "update_memory",
  description:
    "Update the session scratchpad (goal, decisions, files, errors, next step, commands). Survives compaction.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "Current high-level goal." },
      decisions: {
        type: "array",
        items: { type: "string" },
        description: "Decisions to record.",
      },
      files_touched: {
        type: "array",
        items: { type: "string" },
        description: "Paths touched.",
      },
      open_errors: {
        type: "array",
        items: { type: "string" },
        description: "Known failures / blockers.",
      },
      clear_errors: {
        type: "boolean",
        description: "Clear open_errors first.",
      },
      next_step: { type: "string", description: "What to do next." },
      commands: {
        type: "object",
        additionalProperties: { type: "string" },
        description: 'Named commands, e.g. { "test": "npm test" }.',
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.stickyMemory) {
      return { content: "Session scratchpad is not available.", isError: true };
    }
    applyStickyUpdate(ctx.stickyMemory, {
      goal: args.goal,
      decisions: args.decisions,
      filesTouched: args.files_touched,
      openErrors: args.open_errors,
      clearErrors: !!args.clear_errors,
      nextStep: args.next_step,
      commands: args.commands,
    });
    if (stickyIsEmpty(ctx.stickyMemory)) {
      return { content: "Scratchpad is empty (nothing recorded)." };
    }
    // Short ack only: the full scratchpad is appended to the conversation
    // automatically on every call — echoing it here would persist a growing
    // copy in the transcript, re-sent on every subsequent request.
    const changed: string[] = [];
    if (args.goal) changed.push("goal");
    if (Array.isArray(args.decisions) && args.decisions.length) {
      changed.push(`+${args.decisions.length} decision(s)`);
    }
    if (Array.isArray(args.files_touched) && args.files_touched.length) {
      changed.push(`+${args.files_touched.length} file(s)`);
    }
    if (Array.isArray(args.open_errors) && args.open_errors.length) {
      changed.push(`+${args.open_errors.length} error(s)`);
    }
    if (args.clear_errors) changed.push("errors cleared");
    if (args.next_step) changed.push("next_step");
    if (args.commands && Object.keys(args.commands).length) changed.push("commands");
    return {
      content: `Scratchpad updated (${changed.join(", ") || "no changes"}). The current scratchpad is appended to the conversation automatically.`,
    };
  },
};
