// FILE: agentActivityPulse.logic.ts
// Purpose: Derive provider-agnostic agent activity phases from the normalized thread projection.
// Layer: Chat presentation logic
// Exports: activity phase/state types and pure state derivation

import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  TurnId,
} from "@synara/contracts";
import {
  decodeSubagentAgentStates,
  decodeSubagentReceiverAgents,
  decodeSubagentReceiverThreadIds,
} from "@synara/shared/subagents";

import type { ChatMessage, ThreadSession } from "../../types";

export type AgentActivityPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool-running"
  | "interrupted"
  | "completed"
  | "failed";

export interface AgentActivityState {
  phase: AgentActivityPhase;
  toolCount: number;
  subagentCount: number;
  lastEventTimestamp: string | null;
  turnKey: string | null;
}

type AgentActivityLike = Pick<
  OrchestrationThreadActivity,
  "kind" | "payload" | "summary" | "turnId" | "createdAt"
> &
  Partial<Pick<OrchestrationThreadActivity, "id" | "sequence">>;

export interface AgentActivityInput {
  threadId: string | null;
  hasMessages: boolean;
  localDispatchPending: boolean;
  session: Pick<
    ThreadSession,
    "activeTurnId" | "orchestrationStatus" | "status" | "updatedAt"
  > | null;
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "requestedAt" | "startedAt" | "completedAt"
  > | null;
  messages: ReadonlyArray<
    Pick<ChatMessage, "role" | "text" | "streaming" | "turnId" | "createdAt" | "completedAt">
  >;
  activities: ReadonlyArray<AgentActivityLike>;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null;
}

export const IDLE_AGENT_ACTIVITY_STATE: AgentActivityState = Object.freeze({
  phase: "idle",
  toolCount: 0,
  subagentCount: 0,
  lastEventTimestamp: null,
  turnKey: null,
});

export function isLiveAgentActivityPhase(phase: AgentActivityPhase): boolean {
  return phase === "thinking" || phase === "streaming" || phase === "tool-running";
}

export function isTerminalAgentActivityPhase(phase: AgentActivityPhase): boolean {
  return phase === "interrupted" || phase === "completed" || phase === "failed";
}

export function deriveAgentActivityState(input: AgentActivityInput): AgentActivityState {
  if (!input.threadId) {
    return IDLE_AGENT_ACTIVITY_STATE;
  }

  const sessionIsStarting = input.session?.orchestrationStatus === "starting";
  const sessionIsAwaitingTurnProjection =
    (input.session?.orchestrationStatus === "running" || input.session?.status === "running") &&
    !input.session.activeTurnId &&
    input.latestTurn?.state !== "running";
  const beginningLifecycle =
    input.localDispatchPending || sessionIsStarting || sessionIsAwaitingTurnProjection;
  const activeTurnId = resolveActiveTurnId(input.session, input.latestTurn);
  const projectedTurnId = activeTurnId ?? input.latestTurn?.turnId ?? null;
  const turnKey = beginningLifecycle
    ? `pending:${input.threadId}`
    : projectedTurnId
      ? String(projectedTurnId)
      : null;
  const relevantActivities = orderActivities(
    filterTurnActivities(input.activities, projectedTurnId),
  );
  const relevantMessages = filterTurnMessages(input.messages, projectedTurnId);
  const lastEventTimestamp = latestTimestamp([
    input.session?.updatedAt ?? null,
    input.latestTurn?.requestedAt ?? null,
    input.latestTurn?.startedAt ?? null,
    input.latestTurn?.completedAt ?? null,
    ...relevantActivities.map((activity) => activity.createdAt),
    ...relevantMessages.map((message) => message.completedAt ?? message.createdAt),
  ]);

  // A local dispatch or provider-starting state begins a new lifecycle while
  // latestTurn can still describe the previous completed/interrupted turn.
  if (!beginningLifecycle) {
    const terminalPhase = resolveTerminalPhase(input, relevantActivities, activeTurnId);
    if (terminalPhase) {
      return {
        phase: terminalPhase,
        toolCount: 0,
        subagentCount: 0,
        lastEventTimestamp,
        turnKey,
      };
    }
  }

  // Approval and user-input requests are user-blocked states, not live provider
  // output. Keep the pulse idle without discarding the lifecycle's turn key.
  if (input.hasPendingApproval || input.hasPendingUserInput) {
    return {
      ...IDLE_AGENT_ACTIVITY_STATE,
      lastEventTimestamp,
      turnKey,
    };
  }

  const live = beginningLifecycle || isAuthoritativelyLive(input, activeTurnId);
  // hasMessages only suppresses genuinely empty, idle projections. An optimistic
  // first send is represented by localDispatchPending before its message is persisted.
  if (!live || (!input.hasMessages && !beginningLifecycle && activeTurnId === null)) {
    return {
      ...IDLE_AGENT_ACTIVITY_STATE,
      lastEventTimestamp,
      turnKey,
    };
  }

  const { activeToolCount, activeSubagentCount } =
    activeTurnId === null
      ? { activeToolCount: 0, activeSubagentCount: 0 }
      : deriveActiveLifecycleCounts(relevantActivities);
  if (activeToolCount > 0 || activeSubagentCount > 0) {
    return {
      phase: "tool-running",
      toolCount: activeToolCount,
      subagentCount: activeSubagentCount,
      lastEventTimestamp,
      turnKey,
    };
  }

  if (hasStreamingAssistantMessage(relevantMessages, activeTurnId, input.latestTurn)) {
    return {
      phase: "streaming",
      toolCount: 0,
      subagentCount: activeSubagentCount,
      lastEventTimestamp,
      turnKey,
    };
  }

  return {
    phase: "thinking",
    toolCount: 0,
    subagentCount: activeSubagentCount,
    lastEventTimestamp,
    turnKey,
  };
}

function resolveActiveTurnId(
  session: AgentActivityInput["session"],
  latestTurn: AgentActivityInput["latestTurn"],
): TurnId | null {
  if (session?.orchestrationStatus === "running" && session.activeTurnId) {
    return session.activeTurnId;
  }
  if (latestTurn?.state === "running" && latestTurn.completedAt === null) {
    return latestTurn.turnId;
  }
  return null;
}

function resolveTerminalPhase(
  input: AgentActivityInput,
  relevantActivities: ReadonlyArray<AgentActivityLike>,
  activeTurnId: TurnId | null,
): Extract<AgentActivityPhase, "interrupted" | "completed" | "failed"> | null {
  const latestTurnMatchesActive =
    activeTurnId === null || input.latestTurn === null || input.latestTurn.turnId === activeTurnId;
  if (
    input.threadError ||
    (latestTurnMatchesActive && input.latestTurn?.state === "error") ||
    input.session?.orchestrationStatus === "error" ||
    input.session?.status === "error"
  ) {
    return "failed";
  }
  if (
    (latestTurnMatchesActive && input.latestTurn?.state === "interrupted") ||
    input.session?.orchestrationStatus === "interrupted" ||
    (input.session?.orchestrationStatus === "stopped" &&
      latestTurnMatchesActive &&
      input.latestTurn?.state === "running")
  ) {
    return "interrupted";
  }

  const activityTerminalPhase = latestActivityTerminalPhase(relevantActivities);
  if (activityTerminalPhase) {
    return activityTerminalPhase;
  }
  return latestTurnMatchesActive && input.latestTurn?.state === "completed" ? "completed" : null;
}

function latestActivityTerminalPhase(
  activities: ReadonlyArray<AgentActivityLike>,
): Extract<AgentActivityPhase, "interrupted" | "completed" | "failed"> | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "turn.completed" && activity.kind !== "turn.aborted")) {
      continue;
    }
    if (activity.kind === "turn.aborted") {
      return "interrupted";
    }
    const payload = asRecord(activity.payload);
    const state = normalizeStatus(firstString(payload?.state, payload?.status));
    if (["failed", "error", "errored"].includes(state)) {
      return "failed";
    }
    if (["interrupted", "cancelled", "canceled", "aborted", "stopped"].includes(state)) {
      return "interrupted";
    }
    if (["completed", "complete", "succeeded", "success"].includes(state)) {
      return "completed";
    }
  }
  return null;
}

function isAuthoritativelyLive(input: AgentActivityInput, activeTurnId: TurnId | null): boolean {
  if (activeTurnId === null) {
    return false;
  }
  return (
    (input.session?.orchestrationStatus === "running" &&
      input.session.activeTurnId === activeTurnId) ||
    (input.latestTurn?.state === "running" &&
      input.latestTurn.turnId === activeTurnId &&
      input.latestTurn.completedAt === null)
  );
}

function hasStreamingAssistantMessage(
  messages: AgentActivityInput["messages"],
  activeTurnId: TurnId | null,
  latestTurn: AgentActivityInput["latestTurn"],
): boolean {
  if (activeTurnId === null || latestTurn?.completedAt) {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === "assistant" && message.streaming && message.turnId === activeTurnId,
  );
}

function filterTurnActivities(
  activities: AgentActivityInput["activities"],
  turnId: TurnId | null,
): AgentActivityLike[] {
  if (turnId === null) {
    return [];
  }
  return activities.filter((activity) => activity.turnId === turnId);
}

function filterTurnMessages(
  messages: AgentActivityInput["messages"],
  turnId: TurnId | null,
): AgentActivityInput["messages"] {
  if (turnId === null) {
    return [];
  }
  return messages.filter((message) => message.turnId === turnId);
}

function orderActivities(activities: ReadonlyArray<AgentActivityLike>): AgentActivityLike[] {
  return activities
    .map((activity, index) => ({ activity, index }))
    .sort((left, right) => {
      const leftSequence = left.activity.sequence;
      const rightSequence = right.activity.sequence;
      if (
        leftSequence !== undefined &&
        rightSequence !== undefined &&
        leftSequence !== rightSequence
      ) {
        return leftSequence - rightSequence;
      }
      const timeOrder = left.activity.createdAt.localeCompare(right.activity.createdAt);
      return timeOrder !== 0 ? timeOrder : left.index - right.index;
    })
    .map(({ activity }) => activity);
}

function deriveActiveLifecycleCounts(activities: ReadonlyArray<AgentActivityLike>): {
  activeToolCount: number;
  activeSubagentCount: number;
} {
  const openToolCounts = new Map<string, number>();
  const subagentActivityById = new Map<string, boolean>();

  for (const activity of activities) {
    if (!isToolLifecycleActivity(activity)) {
      continue;
    }

    const lifecycleKey = toolLifecycleKey(activity);
    const openCount = openToolCounts.get(lifecycleKey) ?? 0;
    const terminal = activity.kind === "tool.completed" || hasTerminalToolStatus(activity.payload);
    if (terminal) {
      if (openCount <= 1) {
        openToolCounts.delete(lifecycleKey);
      } else {
        openToolCounts.set(lifecycleKey, openCount - 1);
      }
    } else if (activity.kind === "tool.started") {
      openToolCounts.set(lifecycleKey, openCount + 1);
    } else if (openCount === 0) {
      // Some providers project an update as the first observable lifecycle edge.
      openToolCounts.set(lifecycleKey, 1);
    }

    applySubagentActivity(activity, subagentActivityById, terminal);
  }

  let activeToolCount = 0;
  for (const count of openToolCounts.values()) {
    activeToolCount += count;
  }
  let activeSubagentCount = 0;
  for (const active of subagentActivityById.values()) {
    if (active) activeSubagentCount += 1;
  }
  return { activeToolCount, activeSubagentCount };
}

function isToolLifecycleActivity(activity: AgentActivityLike): boolean {
  return (
    activity.kind === "tool.started" ||
    activity.kind === "tool.updated" ||
    activity.kind === "tool.completed"
  );
}

function toolLifecycleKey(activity: AgentActivityLike): string {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item) ?? asRecord(payload?.item);
  const stableId = firstString(
    payload?.itemId,
    payload?.toolCallId,
    payload?.callID,
    payload?.callId,
    payload?.toolUseId,
    data?.itemId,
    data?.toolCallId,
    data?.callID,
    data?.callId,
    data?.toolUseId,
    item?.id,
  );
  if (stableId) {
    return `id:${stableId}`;
  }

  const itemType =
    firstString(payload?.itemType, data?.itemType, item?.type, payload?.type) ?? "tool";
  const toolName = firstString(
    payload?.title,
    payload?.toolName,
    payload?.toolTitle,
    data?.toolName,
    data?.title,
    item?.name,
    item?.toolName,
  );
  const command = firstString(payload?.command, data?.command, item?.command);
  const changedFile = firstString(payload?.path, data?.path, item?.path);
  const label = normalizeLifecycleLabel(toolName ?? activity.summary);
  return `fallback:${normalizeKeyPart(itemType)}:${label}:${normalizeKeyPart(
    command ?? changedFile ?? "",
  )}`;
}

function hasTerminalToolStatus(payloadValue: unknown): boolean {
  const payload = asRecord(payloadValue);
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item) ?? asRecord(payload?.item);
  const status = normalizeStatus(firstString(payload?.status, data?.status, item?.status));
  return [
    "completed",
    "complete",
    "succeeded",
    "success",
    "failed",
    "error",
    "cancelled",
    "canceled",
    "interrupted",
    "stopped",
  ].includes(status);
}

function applySubagentActivity(
  activity: AgentActivityLike,
  target: Map<string, boolean>,
  lifecycleTerminal: boolean,
): void {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item) ?? data ?? asRecord(payload?.item);

  for (const candidate of [payload?.subagents, data?.subagents, payload?.agents, data?.agents]) {
    if (!Array.isArray(candidate)) continue;
    for (const value of candidate) {
      const subagent = asRecord(value);
      const id = firstString(
        subagent?.threadId,
        subagent?.resolvedThreadId,
        subagent?.providerThreadId,
        subagent?.agentId,
        subagent?.id,
      );
      if (!id) continue;
      const status = firstString(subagent?.status, subagent?.rawStatus, subagent?.state);
      target.set(id, status ? isActiveSubagentStatus(status) : !lifecycleTerminal);
    }
  }

  if (!item) return;
  const receiverIds = decodeSubagentReceiverThreadIds(item);
  for (const id of receiverIds) {
    if (!target.has(id) || lifecycleTerminal) {
      target.set(id, !lifecycleTerminal);
    }
  }
  for (const receiver of decodeSubagentReceiverAgents(item, receiverIds)) {
    if (!target.has(receiver.providerThreadId) || lifecycleTerminal) {
      target.set(receiver.providerThreadId, !lifecycleTerminal);
    }
  }
  for (const [id, state] of Object.entries(decodeSubagentAgentStates(item))) {
    target.set(id, state.status ? isActiveSubagentStatus(state.status) : !lifecycleTerminal);
  }
}

function isActiveSubagentStatus(status: string): boolean {
  return ["active", "inprogress", "pending", "queued", "running", "starting", "working"].includes(
    normalizeStatus(status),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function normalizeStatus(value: string | null): string {
  return value?.toLowerCase().replace(/[^a-z0-9]+/gu, "") ?? "";
}

function normalizeKeyPart(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeLifecycleLabel(value: string): string {
  return normalizeKeyPart(value).replace(
    /\s+(?:started|starting|updated|completed|complete|failed|finished)$/u,
    "",
  );
}

function latestTimestamp(values: ReadonlyArray<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value && (latest === null || value.localeCompare(latest) > 0)) {
      latest = value;
    }
  }
  return latest;
}
