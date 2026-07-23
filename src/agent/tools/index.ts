import { Tool } from "./types";
import { ToolDefinition } from "../../openrouter/types";
import { readFileTool, listDirTool, globTool, grepTool } from "./readTools";
import { writeFileTool, editFileTool, applyPatchTool } from "./writeTools";
import { runCommandTool } from "./runCommand";
import { readProcessTool, startProcessTool, stopProcessTool } from "./backgroundProcess";
import { diagnosticsTool, outlineTool, findReferencesTool } from "./vscodeTools";
import { exploreTool } from "./explore";
import { setTasksTool } from "./tasks";
import { gitStatusTool, gitDiffTool, gitLogTool } from "./gitTools";
import { askUserTool } from "./askUser";
import { updateMemoryTool } from "./memoryTool";
import { implementTool } from "./implement";
import { findSymbolTool } from "./findSymbol";
import { tournamentTool } from "./tournament";

export * from "./types";

export const ALL_TOOLS: Tool[] = [
  // read
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  outlineTool,
  findSymbolTool,
  diagnosticsTool,
  findReferencesTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  readProcessTool,
  // meta
  exploreTool,
  tournamentTool,
  setTasksTool,
  updateMemoryTool,
  askUserTool,
  implementTool,
  // edit
  writeFileTool,
  editFileTool,
  applyPatchTool,
  // exec
  runCommandTool,
  startProcessTool,
  stopProcessTool,
];

// Ensure every tool has a group for progressive loading.
for (const t of ALL_TOOLS) {
  if (!t.group) {
    if (t.name === "run_command" || t.name === "start_process" || t.name === "stop_process") {
      t.group = "exec";
    } else if (t.mutating) {
      t.group = "edit";
    } else if (
      t.name === "explore" ||
      t.name === "tournament" ||
      t.name === "set_tasks" ||
      t.name === "update_memory" ||
      t.name === "ask_user" ||
      t.name === "implement"
    ) {
      t.group = "meta";
    } else {
      t.group = "read";
    }
  }
}

/** Tools available in a given mode. Plan mode hides mutating tools entirely. */
export function toolsForMode(planMode: boolean): Tool[] {
  return planMode ? ALL_TOOLS.filter((t) => !t.mutating) : ALL_TOOLS;
}

/** Read-only tools a research sub-agent may use (no recursion, no UI tools). */
export function toolsForSubagent(): Tool[] {
  return ALL_TOOLS.filter(
    (t) =>
      !t.mutating &&
      t.name !== "explore" &&
      t.name !== "tournament" &&
      t.name !== "set_tasks" &&
      t.name !== "ask_user" &&
      t.name !== "implement" &&
      t.name !== "update_memory" &&
      // Niche tools — schema tax not worth it for research digests.
      t.name !== "read_process" &&
      t.name !== "get_diagnostics" &&
      t.name !== "git_status" &&
      t.name !== "git_log"
  );
}

/**
 * Write-capable tools for the implementer sub-agent (no nested explore/implement,
 * no ask_user, no process control — keep the sandbox tight).
 */
export function toolsForImplementer(): Tool[] {
  return ALL_TOOLS.filter(
    (t) =>
      t.name !== "explore" &&
      t.name !== "tournament" &&
      t.name !== "implement" &&
      t.name !== "ask_user" &&
      t.name !== "set_tasks" &&
      t.name !== "start_process" &&
      t.name !== "stop_process" &&
      t.name !== "read_process" &&
      t.name !== "update_memory" &&
      t.name !== "git_status" &&
      t.name !== "git_diff" &&
      t.name !== "git_log"
  );
}

/**
 * Progressive tool sets — keep schemas small until the agent needs them.
 * Changing the set mid-turn breaks prompt cache, so the agent only upgrades
 * at iteration boundaries after the model has started implementing.
 */
export type ToolPhase = "read" | "edit" | "all";

export function toolsForPhase(planMode: boolean, phase: ToolPhase): Tool[] {
  const base = toolsForMode(planMode);
  if (phase === "all") return base;
  if (phase === "read") {
    // Research + orchestration, no file writes / shell.
    return base.filter((t) =>
      (t.group === "read" || t.group === "meta") &&
      t.name !== "read_process" &&
      // High-value but deliberately on-demand: don't tax every routine call.
      t.name !== "tournament"
    );
  }
  if (planMode) return base;
  // edit: everything except heavy exec? Keep exec available once editing —
  // tests/builds are part of implement. "edit" phase = full non-plan set.
  return base;
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
