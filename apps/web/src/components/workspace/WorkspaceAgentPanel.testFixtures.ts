// FILE: WorkspaceAgentPanel.testFixtures.ts
// Purpose: Shared typed fixtures for unit and browser coverage of workspace agent presentation.
// Layer: Workspace agent sidebar tests

import { ProjectId, ThreadId, TurnId } from "@synara/contracts";

import type {
  AgentThreadEntry,
  AgentThreadTreeNode,
  WorkspaceAgentActivity,
  WorkspaceAgentSummary,
} from "../../hooks/useWorkspaceAgentActivity";

export const WORKSPACE_AGENT_PANEL_TEST_PROJECT_ID =
  ProjectId.makeUnsafe("project-workspace-panel");

export function makeWorkspaceAgentEntry(
  overrides: Partial<AgentThreadEntry> = {},
): AgentThreadEntry {
  return {
    threadId: ThreadId.makeUnsafe("thread-workspace-panel"),
    projectId: WORKSPACE_AGENT_PANEL_TEST_PROJECT_ID,
    projectTitle: "Synara",
    projectCwd: "C:/src/synara",
    threadTitle: "Implement workspace agents",
    parentThreadId: null,
    isSubagent: false,
    subagentNickname: null,
    subagentRole: null,
    modelLabel: "GPT-5.6",
    effortLabel: "high",
    providerKind: "codex",
    status: "thinking",
    duration: 61_500,
    latestTool: null,
    streamPreview: null,
    associatedWorktreeBranch: null,
    createdAt: 1,
    lastActivityAt: 2,
    turnId: TurnId.makeUnsafe("turn-workspace-panel"),
    ...overrides,
  };
}

function summarize(entries: ReadonlyArray<AgentThreadEntry>): WorkspaceAgentSummary {
  return {
    total: entries.length,
    running: entries.filter(
      (entry) =>
        entry.status === "thinking" ||
        entry.status === "streaming" ||
        entry.status === "tool-running",
    ).length,
    queued: entries.filter((entry) => entry.status === "queued").length,
    completed: entries.filter((entry) => entry.status === "completed").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
  };
}

export function makeWorkspaceAgentActivity(
  entries: AgentThreadEntry[],
  nodes: AgentThreadTreeNode[],
): WorkspaceAgentActivity {
  const first = entries[0];
  const summary = summarize(entries);
  return {
    threads: entries,
    groups: [
      {
        projectId: first?.projectId ?? WORKSPACE_AGENT_PANEL_TEST_PROJECT_ID,
        projectTitle: first?.projectTitle ?? "Synara",
        projectCwd: first?.projectCwd ?? "C:/src/synara",
        nodes,
        summary,
      },
    ],
    summary,
  };
}
