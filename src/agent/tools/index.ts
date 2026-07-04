import { Tool } from "./types";
import { ToolDefinition } from "../../openrouter/types";
import { readFileTool, listDirTool, globTool, grepTool } from "./readTools";
import { writeFileTool, editFileTool, applyPatchTool } from "./writeTools";
import { runCommandTool } from "./runCommand";
import { readProcessTool, startProcessTool, stopProcessTool } from "./backgroundProcess";
import { diagnosticsTool, outlineTool } from "./vscodeTools";
import { exploreTool } from "./explore";
import { setTasksTool } from "./tasks";

export * from "./types";

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  outlineTool,
  diagnosticsTool,
  exploreTool,
  setTasksTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  runCommandTool,
  startProcessTool,
  readProcessTool,
  stopProcessTool,
];

/** Tools available in a given mode. Plan mode hides mutating tools entirely. */
export function toolsForMode(planMode: boolean): Tool[] {
  return planMode ? ALL_TOOLS.filter((t) => !t.mutating) : ALL_TOOLS;
}

/** Read-only tools a research sub-agent may use (no recursion, no UI tools). */
export function toolsForSubagent(): Tool[] {
  return ALL_TOOLS.filter(
    (t) => !t.mutating && t.name !== "explore" && t.name !== "set_tasks"
  );
}

export function toolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** Convert tools to the OpenRouter/OpenAI function-tool schema. */
export function toToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
