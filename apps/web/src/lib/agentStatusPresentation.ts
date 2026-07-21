// FILE: agentStatusPresentation.ts
// Purpose: Maps detailed workspace-agent lifecycle states to shared compact status styling.
// Layer: Pure web presentation logic

import type { SubagentStatusKind } from "./subagentPresentation";
import { isLiveAgentStatus, type AgentStatus } from "./workspaceAgentActivity";

export interface AgentStatusPresentation {
  readonly label: string;
  readonly textClassName: string;
  readonly dotClassName: string;
}

const AGENT_STATUS_PRESENTATION: Record<AgentStatus, AgentStatusPresentation> = {
  idle: {
    label: "Idle",
    textClassName: "text-muted-foreground/55",
    dotClassName: "bg-muted-foreground/25",
  },
  connecting: { label: "Connecting", textClassName: "text-info", dotClassName: "bg-info" },
  thinking: { label: "Thinking", textClassName: "text-warning", dotClassName: "bg-warning" },
  streaming: { label: "Streaming", textClassName: "text-primary", dotClassName: "bg-primary" },
  "tool-running": {
    label: "Tool running",
    textClassName: "text-primary",
    dotClassName: "bg-primary",
  },
  queued: {
    label: "Queued",
    textClassName: "text-violet-300/85",
    dotClassName: "bg-violet-300/80",
  },
  interrupted: {
    label: "Interrupted",
    textClassName: "text-warning",
    dotClassName: "bg-warning",
  },
  stopped: { label: "Stopped", textClassName: "text-warning", dotClassName: "bg-warning" },
  completed: { label: "Completed", textClassName: "text-success", dotClassName: "bg-success" },
  failed: { label: "Failed", textClassName: "text-destructive", dotClassName: "bg-destructive" },
};

export function agentStatusPresentation(status: AgentStatus): AgentStatusPresentation {
  return AGENT_STATUS_PRESENTATION[status];
}

export function agentStatusToSubagentStatusKind(status: AgentStatus): SubagentStatusKind {
  if (isLiveAgentStatus(status)) return "running";
  return status === "interrupted" ? "stopped" : status;
}
