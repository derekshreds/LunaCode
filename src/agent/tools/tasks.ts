import { Tool, ToolResult } from "./types";

/**
 * Model-maintained task checklist, rendered live in the chat UI. The tool
 * itself only validates; the Agent emits the UI event when it sees a
 * successful call (the tool layer has no UI channel).
 */
export const setTasksTool: Tool = {
  name: "set_tasks",
  description:
    "Create or update your visible task checklist for multi-step work. Replaces the entire list each call. Use it at the start of any task with 3+ steps, mark exactly one task 'active' while working on it, and update statuses as you complete each step. Keeps the user informed during long autonomous runs.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short imperative step, e.g. 'Add config key'." },
            status: { type: "string", enum: ["pending", "active", "done"] },
          },
          required: ["label", "status"],
        },
      },
    },
    required: ["tasks"],
  },
  async execute(args): Promise<ToolResult> {
    if (!Array.isArray(args?.tasks)) {
      return { content: "set_tasks requires a tasks array.", isError: true };
    }
    const done = args.tasks.filter((t: any) => t?.status === "done").length;
    return { content: `Task list updated (${done}/${args.tasks.length} done).` };
  },
};
