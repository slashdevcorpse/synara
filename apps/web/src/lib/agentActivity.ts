// FILE: agentActivity.ts
// Purpose: Provider-agnostic agent activity derivation shared by chat, sidebar, hover, and workspace UI.
// Layer: Web presentation domain
// Exports: normalized activity state, phase derivation, and project process aggregation

import type {
  OrchestrationLatestTurn,
  OrchestrationSessionStatus,
  TurnId,
} from "@synara/contracts";

export type AgentActivityPhase =
  | "idle"
  | "connecting"
  | "thinking"
  | "streaming"
  | "tool-running"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped";

export interface AgentSubagentActivityState {
  readonly id: string;
  readonly phase: AgentActivityPhase;
  readonly latestToolName: string | null;
  readonly streamPreview: string | null;
}

export interface AgentActivityState {
  readonly phase: AgentActivityPhase;
  readonly queueCount: number;
  readonly toolCount: number;
  readonly subagentCount: number;
  readonly subagentRunningCount: number;
  readonly subagentStates: ReadonlyMap<string, AgentSubagentActivityState>;
  readonly latestToolName: string | null;
  readonly streamPreview: string | null;
  readonly durationMs: number;
  readonly lastEventTimestamp: string | null;
  readonly turnKey: string | null;
}

export interface AgentActivitySessionEvidence {
  readonly status: OrchestrationSessionStatus;
  readonly activeTurnId: TurnId | null;
  readonly updatedAt: string;
}

export type AgentActivityTerminalPhase = Extract<
  AgentActivityPhase,
  "completed" | "failed" | "interrupted" | "stopped"
>;

export interface AgentActivityDerivationInput {
  readonly threadId: string | null;
  readonly hasMessages: boolean;
  readonly localDispatchPending: boolean;
  readonly session: AgentActivitySessionEvidence | null;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "requestedAt" | "startedAt" | "completedAt"
  > | null;
  readonly hasLiveTailWork: boolean;
  readonly hasPendingInteraction: boolean;
  readonly threadError: string | null;
  readonly queueCount?: number;
  readonly activeToolCount?: number;
  readonly latestToolName?: string | null;
  readonly hasStreamingAssistantMessage?: boolean;
  readonly streamPreview?: string | null;
  readonly subagentStates?: ReadonlyMap<string, AgentSubagentActivityState>;
  readonly activityTerminalPhase?: AgentActivityTerminalPhase | null;
  readonly lastEventTimestamp?: string | null;
  readonly nowMs?: number;
}

const EMPTY_SUBAGENT_STATES: ReadonlyMap<string, AgentSubagentActivityState> = new Map();

export const IDLE_AGENT_ACTIVITY_STATE: AgentActivityState = Object.freeze({
  phase: "idle",
  queueCount: 0,
  toolCount: 0,
  subagentCount: 0,
  subagentRunningCount: 0,
  subagentStates: EMPTY_SUBAGENT_STATES,
  latestToolName: null,
  streamPreview: null,
  durationMs: 0,
  lastEventTimestamp: null,
  turnKey: null,
});

export function isLiveAgentActivityPhase(phase: AgentActivityPhase): boolean {
  return (
    phase === "connecting" ||
    phase === "thinking" ||
    phase === "streaming" ||
    phase === "tool-running"
  );
}

export function isTerminalAgentActivityPhase(phase: AgentActivityPhase): boolean {
  return (
    phase === "completed" ||
    phase === "failed" ||
    phase === "interrupted" ||
    phase === "stopped"
  );
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveActiveTurnId(input: AgentActivityDerivationInput): TurnId | null {
  if (
    input.session?.status === "running" &&
    input.session.activeTurnId !== null
  ) {
    return input.session.activeTurnId;
  }
  if (input.latestTurn?.state === "running" && input.latestTurn.completedAt === null) {
    return input.latestTurn.turnId;
  }
  return null;
}

function resolveTerminalPhase(
  input: AgentActivityDerivationInput,
  activeTurnId: TurnId | null,
): AgentActivityTerminalPhase | null {
  const latestTurnMatchesActive =
    activeTurnId === null || input.latestTurn === null || input.latestTurn.turnId === activeTurnId;
  if (
    input.threadError ||
    input.session?.status === "error" ||
    (latestTurnMatchesActive && input.latestTurn?.state === "error") ||
    input.activityTerminalPhase === "failed"
  ) {
    return "failed";
  }
  if (activeTurnId !== null && input.session?.status === "running") {
    return null;
  }
  if (input.session?.status === "stopped" || input.activityTerminalPhase === "stopped") {
    return "stopped";
  }
  if (
    input.session?.status === "interrupted" ||
    (latestTurnMatchesActive && input.latestTurn?.state === "interrupted") ||
    input.activityTerminalPhase === "interrupted"
  ) {
    return "interrupted";
  }
  if (input.activityTerminalPhase === "completed") return "completed";
  return latestTurnMatchesActive && input.latestTurn?.state === "completed" ? "completed" : null;
}

function deriveDurationMs(input: AgentActivityDerivationInput, phase: AgentActivityPhase): number {
  const start =
    phase === "connecting"
      ? timestamp(input.session?.updatedAt) || timestamp(input.latestTurn?.requestedAt)
      : timestamp(input.latestTurn?.startedAt) ||
        timestamp(input.latestTurn?.requestedAt) ||
        timestamp(input.session?.updatedAt);
  if (start === 0) return 0;
  const terminal = isTerminalAgentActivityPhase(phase);
  const end = terminal
    ? timestamp(input.latestTurn?.completedAt) || timestamp(input.lastEventTimestamp) || start
    : (input.nowMs ?? Date.now());
  return Math.max(0, end - start);
}

function withEvidence(
  input: AgentActivityDerivationInput,
  phase: AgentActivityPhase,
  turnKey: string | null,
): AgentActivityState {
  const subagentStates = input.subagentStates ?? EMPTY_SUBAGENT_STATES;
  const runningSubagents = [...subagentStates.values()].filter((state) =>
    isLiveAgentActivityPhase(state.phase),
  ).length;
  return {
    phase,
    queueCount: Math.max(0, input.queueCount ?? 0),
    toolCount: Math.max(0, input.activeToolCount ?? 0),
    subagentCount: subagentStates.size,
    subagentRunningCount: runningSubagents,
    subagentStates,
    latestToolName: input.latestToolName ?? null,
    streamPreview: input.streamPreview?.trim().slice(-80) || null,
    durationMs: deriveDurationMs(input, phase),
    lastEventTimestamp: input.lastEventTimestamp ?? null,
    turnKey,
  };
}

export function deriveAgentActivityState(
  input: AgentActivityDerivationInput,
): AgentActivityState {
  if (!input.threadId) return IDLE_AGENT_ACTIVITY_STATE;

  const subagentStates = input.subagentStates ?? EMPTY_SUBAGENT_STATES;
  const hasRunningSubagent = [...subagentStates.values()].some((state) =>
    isLiveAgentActivityPhase(state.phase),
  );
  const activeTurnId = resolveActiveTurnId(input);
  const sessionAwaitingTurn =
    input.session?.status === "running" &&
    input.session.activeTurnId === null &&
    input.latestTurn?.state !== "running";
  const beginningLifecycle =
    input.localDispatchPending || input.session?.status === "starting" || sessionAwaitingTurn;
  const projectedTurnId = activeTurnId ?? input.latestTurn?.turnId ?? null;
  const turnKey = beginningLifecycle
    ? `pending:${input.threadId}`
    : projectedTurnId === null
      ? null
      : String(projectedTurnId);

  if (!beginningLifecycle && !hasRunningSubagent) {
    const terminalPhase = resolveTerminalPhase(input, activeTurnId);
    if (terminalPhase !== null) return withEvidence(input, terminalPhase, turnKey);
  }
  if (!beginningLifecycle && hasRunningSubagent) {
    const terminalPhase = resolveTerminalPhase(input, activeTurnId);
    if (terminalPhase !== null && terminalPhase !== "completed") {
      return withEvidence(input, terminalPhase, turnKey);
    }
  }

  if (input.hasPendingInteraction && !hasRunningSubagent) {
    return { ...withEvidence(input, "idle", turnKey), toolCount: 0, latestToolName: null };
  }

  const live =
    beginningLifecycle ||
    activeTurnId !== null ||
    hasRunningSubagent ||
    (input.hasLiveTailWork &&
      (input.latestTurn === null || input.latestTurn.state === "running"));
  if (
    !live ||
    (!input.hasMessages && !beginningLifecycle && activeTurnId === null && !hasRunningSubagent)
  ) {
    return withEvidence(input, "idle", turnKey);
  }

  if ((input.activeToolCount ?? 0) > 0 || hasRunningSubagent) {
    return withEvidence(input, "tool-running", turnKey);
  }
  if (input.hasStreamingAssistantMessage) {
    return withEvidence(input, "streaming", turnKey);
  }
  return withEvidence(input, beginningLifecycle ? "connecting" : "thinking", turnKey);
}

export interface ProjectProcessAgentEvidence {
  readonly state: AgentActivityState;
  readonly isSubagent: boolean;
}

export interface ProjectProcessActivityInput {
  readonly agents: readonly ProjectProcessAgentEvidence[];
  readonly terminalProcessCount: number;
  readonly devServerRunning?: boolean;
  readonly gitActionRunning?: boolean;
}

export interface ProjectProcessActivitySummary {
  readonly agentCount: number;
  readonly agentRunningCount: number;
  readonly subagentCount: number;
  readonly subagentRunningCount: number;
  readonly terminalProcessCount: number;
  readonly devServerRunning: boolean;
  readonly gitActionRunning: boolean;
  readonly anyProcessRunning: boolean;
}

function isCurrentAgentState(state: AgentActivityState): boolean {
  return isLiveAgentActivityPhase(state.phase) || state.queueCount > 0;
}

export function deriveProjectProcessActivity(
  input: ProjectProcessActivityInput,
): ProjectProcessActivitySummary {
  const activeAgents = input.agents.filter((agent) => isCurrentAgentState(agent.state));
  const agents = activeAgents.filter((agent) => !agent.isSubagent);
  const subagents = activeAgents.filter((agent) => agent.isSubagent);
  const terminalProcessCount = Math.max(0, Math.floor(input.terminalProcessCount));
  const devServerRunning = input.devServerRunning === true;
  const gitActionRunning = input.gitActionRunning === true;
  const agentRunningCount = agents.filter((agent) =>
    isLiveAgentActivityPhase(agent.state.phase),
  ).length;
  const subagentRunningCount = subagents.filter((agent) =>
    isLiveAgentActivityPhase(agent.state.phase),
  ).length;
  return {
    agentCount: agents.length,
    agentRunningCount,
    subagentCount: subagents.length,
    subagentRunningCount,
    terminalProcessCount,
    devServerRunning,
    gitActionRunning,
    anyProcessRunning:
      agentRunningCount > 0 ||
      subagentRunningCount > 0 ||
      terminalProcessCount > 0 ||
      devServerRunning ||
      gitActionRunning,
  };
}

export function isAnyProcessRunning(input: ProjectProcessActivityInput): boolean {
  return deriveProjectProcessActivity(input).anyProcessRunning;
}
