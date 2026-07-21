import { describe, expect, it } from "vitest";

import {
  agentStatusPresentation,
  agentStatusToSubagentStatusKind,
} from "./agentStatusPresentation";
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
    ["interrupted", "stopped"],
    ["stopped", "stopped"],
  ])("maps %s to %s", (status, expected) => {
    expect(agentStatusToSubagentStatusKind(status)).toBe(expected);
  });
});

describe("agentStatusPresentation", () => {
  it.each([
    ["connecting", "text-info", "bg-info"],
    ["thinking", "text-warning", "bg-warning"],
    ["streaming", "text-primary", "bg-primary"],
    ["tool-running", "text-primary", "bg-primary"],
    ["interrupted", "text-warning", "bg-warning"],
    ["completed", "text-success", "bg-success"],
    ["failed", "text-destructive", "bg-destructive"],
  ] as const)("uses the explicit semantic palette for %s", (status, textClassName, dotClassName) => {
    expect(agentStatusPresentation(status)).toMatchObject({ textClassName, dotClassName });
  });
});
