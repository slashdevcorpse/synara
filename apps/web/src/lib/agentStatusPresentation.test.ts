import { describe, expect, it } from "vitest";

import { agentStatusToSubagentStatusKind } from "./agentStatusPresentation";
import type { SubagentStatusKind } from "./subagentPresentation";
import type { AgentStatus } from "./workspaceAgentActivity";

describe("agentStatusToSubagentStatusKind", () => {
  it.each<[AgentStatus, SubagentStatusKind]>([
    ["idle", "idle"],
    ["connecting", "running"],
    ["thinking", "running"],
    ["streaming", "running"],
    ["tool-running", "running"],
    ["queued", "queued"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "stopped"],
  ])("maps %s to %s", (status, expected) => {
    expect(agentStatusToSubagentStatusKind(status)).toBe(expected);
  });
});
