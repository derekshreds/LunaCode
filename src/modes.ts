export type AgentMode = "standard" | "auto" | "plan";

export interface ModeInfo {
  id: AgentMode;
  label: string;
  description: string;
  /** Whether mutating tools are permitted at all. */
  allowsMutation: boolean;
}

export const MODES: Record<AgentMode, ModeInfo> = {
  standard: {
    id: "standard",
    label: "Standard",
    description:
      "Approve each file edit and command before it runs. Safest, most controlled.",
    allowsMutation: true,
  },
  auto: {
    id: "auto",
    label: "Auto",
    description:
      "Runs edits and commands autonomously without prompting. Always-deny commands are still blocked.",
    allowsMutation: true,
  },
  plan: {
    id: "plan",
    label: "Plan",
    description:
      "Read-only. Researches the codebase and proposes a plan, but never edits files or runs mutating commands.",
    allowsMutation: false,
  },
};

export function isMode(value: string): value is AgentMode {
  return value === "standard" || value === "auto" || value === "plan";
}

/**
 * Progressive schemas are an opt-in prompt-cost optimization for Standard
 * mode. Auto must expose its complete write/exec surface from the first model
 * call; otherwise the model can correctly conclude that the tools promised by
 * the Auto-mode system prompt are unavailable and stop without acting.
 */
export function useProgressiveTools(mode: AgentMode, enabled: boolean): boolean {
  return enabled && mode === "standard";
}
