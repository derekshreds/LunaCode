import { Tool } from "./types";
import { ToolDefinition } from "../../openrouter/types";
import { readFileTool, listDirTool, globTool, grepTool } from "./readTools";
import { writeFileTool, editFileTool } from "./writeTools";
import { runCommandTool } from "./runCommand";
import { diagnosticsTool } from "./vscodeTools";

export * from "./types";

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  diagnosticsTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
];

/** Tools available in a given mode. Plan mode hides mutating tools entirely. */
export function toolsForMode(planMode: boolean): Tool[] {
  return planMode ? ALL_TOOLS.filter((t) => !t.mutating) : ALL_TOOLS;
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
