import { Tool, ToolResult } from "./types";

/**
 * Model-maintained task checklist, rendered live in the chat UI. The tool
 * itself only validates; the Agent emits the UI event when it sees a
 * successful call (the tool layer has no UI channel).
 */
export const setTasksTool: Tool = {
  name: "set_tasks",
  description:
    "Create/update the visible task checklist. Replaces the whole list each call. Keep exactly one task 'active'.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short imperative step." },
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
