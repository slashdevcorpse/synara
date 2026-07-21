// FILE: agentStatusPresentation.ts
// Purpose: Maps detailed workspace-agent lifecycle states to shared compact status styling.
// Layer: Pure web presentation logic

import type { SubagentStatusKind } from "./subagentPresentation";
import { isLiveAgentStatus, type AgentStatus } from "./workspaceAgentActivity";

export function agentStatusToSubagentStatusKind(status: AgentStatus): SubagentStatusKind {
  return isLiveAgentStatus(status) ? "running" : status;
}
