// FILE: workspaceAgentActivity.ts
// Purpose: Reduce global orchestration activity and derive workspace-wide agent rows.
// Layer: Pure web domain logic
// Exports: activity types, bounded reducer, labels, timing, and project/thread tree derivation

import type {
  ModelSelection,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationSessionStatus,
  ProjectId,
  ProviderKind,
  ThreadId,
  TurnId,
} from "@synara/contracts";

import { formatSubagentModelLabel } from "./subagentPresentation";

export type AgentStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool-running"
  | "queued"
  | "completed"
  | "failed"
  | "stopped";

export interface AgentToolActivity {
  name: string;
  state: "running" | "done";
}

export interface AgentThreadEntry {
  threadId: ThreadId;
  projectId: ProjectId;
  projectTitle: string;
  projectCwd: string;
  threadTitle: string;
  parentThreadId: ThreadId | null;
  isSubagent: boolean;
  subagentNickname: string | null;
  subagentRole: string | null;
  modelLabel: string;
  effortLabel: string | null;
  providerKind: ProviderKind;
  status: AgentStatus;
  duration: number;
  latestTool: AgentToolActivity | null;
  streamPreview: string | null;
  associatedWorktreeBranch: string | null;
  createdAt: number;
  lastActivityAt: number;
  turnId: TurnId | null;
}

export interface AgentThreadTreeNode {
  entry: AgentThreadEntry;
  children: AgentThreadTreeNode[];
}

export interface WorkspaceAgentSummary {
  total: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
}

export interface AgentProjectGroup {
  projectId: ProjectId;
  projectTitle: string;
  projectCwd: string;
  nodes: AgentThreadTreeNode[];
  summary: WorkspaceAgentSummary;
}

export interface WorkspaceAgentActivity {
  threads: AgentThreadEntry[];
  groups: AgentProjectGroup[];
  summary: WorkspaceAgentSummary;
}

export interface WorkspaceAgentShellProject {
  projectId: ProjectId;
  projectTitle: string;
  projectCwd: string;
}

export interface WorkspaceAgentShellSession {
  providerKind: ProviderKind | null;
  status: OrchestrationSessionStatus;
  activeTurnId: TurnId | null;
  lastError: string | null;
  updatedAt: string;
}

export interface WorkspaceAgentShellThread {
  threadId: ThreadId;
  projectId: ProjectId;
  threadTitle: string;
  parentThreadId: ThreadId | null;
  subagentAgentId: string | null;
  subagentNickname: string | null;
  subagentRole: string | null;
  modelSelection: ModelSelection;
  session: WorkspaceAgentShellSession | null;
  latestTurn: OrchestrationLatestTurn | null;
  hasLiveTailWork: boolean;
  associatedWorktreeBranch: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface WorkspaceAgentInterruptSnapshot {
  threadId: ThreadId;
  parentThreadId: ThreadId | null;
  session: Pick<WorkspaceAgentShellSession, "status" | "activeTurnId"> | null;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null;
  hasLiveTailWork: boolean;
}

export interface WorkspaceAgentQueuedMessage {
  messageId: string;
  sequence: number;
  createdAt: string;
}

export interface WorkspaceAgentStreamingMessage {
  messageId: string;
  turnId: TurnId;
  text: string;
  sequence: number;
  updatedAt: string;
}

export interface WorkspaceAgentOpenTool {
  key: string;
  turnId: TurnId;
  name: string;
  count: number;
  sequence: number;
  updatedAt: string;
}

export interface WorkspaceAgentCompletedTool {
  turnId: TurnId;
  name: string;
  sequence: number;
  updatedAt: string;
}

export interface WorkspaceAgentThreadEventState {
  queuedMessages: Record<string, WorkspaceAgentQueuedMessage>;
  streamingMessages: Record<string, WorkspaceAgentStreamingMessage>;
  openTools: Record<string, WorkspaceAgentOpenTool>;
  latestCompletedToolByTurn: Record<string, WorkspaceAgentCompletedTool>;
  lastActivityAt: string | null;
}

export interface WorkspaceAgentEventState {
  events: OrchestrationEvent[];
  lastSequence: number;
  generation: number;
  threads: Record<string, WorkspaceAgentThreadEventState>;
}

export const WORKSPACE_AGENT_EVENT_BUFFER_LIMIT = 200;
const STREAM_TEXT_LIMIT = 512;

const EMPTY_SUMMARY: WorkspaceAgentSummary = {
  total: 0,
  running: 0,
  queued: 0,
  completed: 0,
  failed: 0,
};

const EMPTY_ACTIVITY: WorkspaceAgentActivity = {
  threads: [],
  groups: [],
  summary: EMPTY_SUMMARY,
};

export function createInitialWorkspaceAgentEventState(generation = 0): WorkspaceAgentEventState {
  return {
    events: [],
    lastSequence: -1,
    generation,
    threads: {},
  };
}

export function createWorkspaceAgentEventStateAtSequence(
  lastSequence: number,
  generation = 0,
): WorkspaceAgentEventState {
  return {
    ...createInitialWorkspaceAgentEventState(generation),
    lastSequence,
  };
}

function emptyThreadEventState(): WorkspaceAgentThreadEventState {
  return {
    queuedMessages: {},
    streamingMessages: {},
    openTools: {},
    latestCompletedToolByTurn: {},
    lastActivityAt: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function activityProviderItemId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const nested = nestedRecord(payload, "data");
  return (
    optionalString(payload, "providerItemId") ??
    optionalString(payload, "toolUseId") ??
    optionalString(payload, "toolCallId") ??
    optionalString(payload, "callId") ??
    optionalString(payload, "callID") ??
    optionalString(nested, "toolUseId") ??
    optionalString(nested, "toolCallId") ??
    optionalString(nested, "callId") ??
    optionalString(nested, "callID")
  );
}

function activityToolName(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const nested = nestedRecord(payload, "data");
  return (
    optionalString(payload, "toolName") ??
    optionalString(nested, "toolName") ??
    optionalString(payload, "title") ??
    optionalString(payload, "name") ??
    optionalString(nested, "title") ??
    optionalString(nested, "name") ??
    fallback
  );
}

function legacyToolKey(input: { turnId: TurnId; payload: unknown }): string {
  const record = isRecord(input.payload) ? input.payload : {};
  const itemType = optionalString(record, "itemType") ?? "tool";
  const signature = itemType.trim().toLowerCase().replace(/\s+/g, " ");
  return `${input.turnId}:legacy:${signature}`;
}

function legacyToolKeyForIdentityUpgrade(input: {
  openTools: Readonly<Record<string, WorkspaceAgentOpenTool>>;
  turnId: TurnId;
  payload: unknown;
}): string | null {
  const exactKey = legacyToolKey(input);
  if (input.openTools[exactKey]) return exactKey;
  const candidates = Object.entries(input.openTools).filter(
    ([key, tool]) => tool.turnId === input.turnId && key.startsWith(`${input.turnId}:legacy:`),
  );
  return candidates.length === 1 ? (candidates[0]?.[0] ?? null) : null;
}

function consumeOneOpenTool(
  openTools: Readonly<Record<string, WorkspaceAgentOpenTool>>,
  key: string,
  sequence: number,
  updatedAt: string,
): Record<string, WorkspaceAgentOpenTool> {
  const tool = openTools[key];
  if (!tool) return { ...openTools };
  if (tool.count > 1) {
    return {
      ...openTools,
      [key]: { ...tool, count: tool.count - 1, sequence, updatedAt },
    };
  }
  const { [key]: _consumed, ...remaining } = openTools;
  return remaining;
}

function pruneTelemetryForTurn(
  thread: WorkspaceAgentThreadEventState,
  turnId: TurnId | null,
): WorkspaceAgentThreadEventState {
  if (turnId === null) {
    return { ...thread, openTools: {}, streamingMessages: {} };
  }
  return {
    ...thread,
    openTools: Object.fromEntries(
      Object.entries(thread.openTools).filter(([, tool]) => tool.turnId !== turnId),
    ),
    streamingMessages: Object.fromEntries(
      Object.entries(thread.streamingMessages).filter(([, message]) => message.turnId !== turnId),
    ),
  };
}

function retainOnlyTurnTelemetry(
  thread: WorkspaceAgentThreadEventState,
  turnId: TurnId,
): WorkspaceAgentThreadEventState {
  return {
    ...thread,
    openTools: Object.fromEntries(
      Object.entries(thread.openTools).filter(([, tool]) => tool.turnId === turnId),
    ),
    streamingMessages: Object.fromEntries(
      Object.entries(thread.streamingMessages).filter(([, message]) => message.turnId === turnId),
    ),
    latestCompletedToolByTurn: Object.fromEntries(
      Object.entries(thread.latestCompletedToolByTurn).filter(([, tool]) => tool.turnId === turnId),
    ),
  };
}

function applyEventToThread(
  current: WorkspaceAgentThreadEventState,
  event: OrchestrationEvent,
): WorkspaceAgentThreadEventState {
  const occurredAt = event.occurredAt;

  switch (event.type) {
    case "thread.turn-queued": {
      const messageId = String(event.payload.messageId);
      return {
        ...current,
        queuedMessages: {
          ...current.queuedMessages,
          [messageId]: {
            messageId,
            sequence: event.sequence,
            createdAt: event.payload.createdAt,
          },
        },
        lastActivityAt: occurredAt,
      };
    }
    case "thread.turn-start-requested": {
      const messageId = String(event.payload.messageId);
      const { [messageId]: _started, ...queuedMessages } = current.queuedMessages;
      return { ...current, queuedMessages, lastActivityAt: occurredAt };
    }
    case "thread.message-sent": {
      if (event.payload.role !== "assistant") {
        return { ...current, lastActivityAt: occurredAt };
      }
      const messageId = String(event.payload.messageId);
      if (!event.payload.streaming) {
        const { [messageId]: _completed, ...streamingMessages } = current.streamingMessages;
        return { ...current, streamingMessages, lastActivityAt: occurredAt };
      }
      if (event.payload.turnId === null) {
        return { ...current, lastActivityAt: occurredAt };
      }
      const previous = current.streamingMessages[messageId];
      const text = `${
        previous?.turnId === event.payload.turnId ? previous.text : ""
      }${event.payload.text}`;
      return {
        ...current,
        streamingMessages: {
          ...current.streamingMessages,
          [messageId]: {
            messageId,
            turnId: event.payload.turnId,
            text: text.slice(-STREAM_TEXT_LIMIT),
            sequence: event.sequence,
            updatedAt: event.payload.updatedAt,
          },
        },
        lastActivityAt: occurredAt,
      };
    }
    case "thread.activity-appended": {
      const { activity } = event.payload;
      const turnId = activity.turnId;
      if (turnId === null) {
        return { ...current, lastActivityAt: occurredAt };
      }
      if (activity.kind === "turn.completed" || activity.kind === "turn.aborted") {
        return {
          ...pruneTelemetryForTurn(current, turnId),
          lastActivityAt: occurredAt,
        };
      }
      if (
        activity.kind !== "tool.started" &&
        activity.kind !== "tool.updated" &&
        activity.kind !== "tool.completed"
      ) {
        return { ...current, lastActivityAt: occurredAt };
      }

      const providerItemId =
        event.metadata.providerItemId ?? activityProviderItemId(activity.payload);
      const name = activityToolName(activity.payload, activity.summary);
      const key = providerItemId
        ? `${turnId}:provider:${providerItemId}`
        : legacyToolKey({ turnId, payload: activity.payload });
      const identityUpgradeLegacyKey =
        providerItemId && activity.kind !== "tool.started" && current.openTools[key] === undefined
          ? legacyToolKeyForIdentityUpgrade({
              openTools: current.openTools,
              turnId,
              payload: activity.payload,
            })
          : null;
      const previous =
        current.openTools[key] ??
        (identityUpgradeLegacyKey ? current.openTools[identityUpgradeLegacyKey] : undefined);
      const latestCompletedToolByTurn =
        activity.kind === "tool.completed"
          ? {
              ...current.latestCompletedToolByTurn,
              [turnId]: {
                turnId,
                name,
                sequence: event.sequence,
                updatedAt: activity.createdAt,
              },
            }
          : current.latestCompletedToolByTurn;
      let openTools = identityUpgradeLegacyKey
        ? consumeOneOpenTool(
            current.openTools,
            identityUpgradeLegacyKey,
            event.sequence,
            activity.createdAt,
          )
        : current.openTools;
      if (activity.kind === "tool.completed") {
        if (previous && !providerItemId && previous.count > 1) {
          openTools = {
            ...openTools,
            [key]: {
              ...previous,
              count: previous.count - 1,
              sequence: event.sequence,
              updatedAt: activity.createdAt,
            },
          };
        } else if (previous && identityUpgradeLegacyKey === null) {
          const { [key]: _completed, ...remaining } = openTools;
          openTools = remaining;
        }
      } else {
        openTools = {
          ...openTools,
          [key]: {
            key,
            turnId,
            name,
            count:
              activity.kind === "tool.started" && !providerItemId
                ? (previous?.count ?? 0) + 1
                : activity.kind === "tool.updated" && !providerItemId
                  ? (previous?.count ?? 1)
                  : 1,
            sequence: event.sequence,
            updatedAt: activity.createdAt,
          },
        };
      }
      return { ...current, openTools, latestCompletedToolByTurn, lastActivityAt: occurredAt };
    }
    case "thread.session-set": {
      const { session } = event.payload;
      if (session.status === "running" && session.activeTurnId !== null) {
        return {
          ...retainOnlyTurnTelemetry(current, session.activeTurnId),
          lastActivityAt: occurredAt,
        };
      }
      const terminal =
        session.status === "interrupted" ||
        session.status === "stopped" ||
        session.status === "error";
      return {
        ...current,
        openTools: {},
        streamingMessages: {},
        queuedMessages: terminal ? {} : current.queuedMessages,
        lastActivityAt: occurredAt,
      };
    }
    case "thread.turn-diff-completed":
      return {
        ...pruneTelemetryForTurn(current, event.payload.turnId),
        lastActivityAt: occurredAt,
      };
    case "thread.reverted":
    case "thread.conversation-rolled-back":
      return {
        ...current,
        openTools: {},
        streamingMessages: {},
        queuedMessages: {},
        lastActivityAt: occurredAt,
      };
    default:
      return current;
  }
}

function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

function boundThreadEventState(
  threads: Record<string, WorkspaceAgentThreadEventState>,
  events: readonly OrchestrationEvent[],
): Record<string, WorkspaceAgentThreadEventState> {
  const retainedThreadIds = new Set(
    events.flatMap((event) => {
      const threadId = eventThreadId(event);
      return threadId === null ? [] : [String(threadId)];
    }),
  );
  const entries = Object.entries(threads);
  const shouldRetain = ([threadId, state]: [string, WorkspaceAgentThreadEventState]) =>
    retainedThreadIds.has(threadId) ||
    Object.keys(state.queuedMessages).length > 0 ||
    Object.keys(state.streamingMessages).length > 0 ||
    Object.keys(state.openTools).length > 0;
  if (entries.every(shouldRetain)) return threads;
  return Object.fromEntries(entries.filter(shouldRetain));
}

export function reduceWorkspaceAgentEventState(
  state: WorkspaceAgentEventState,
  event: OrchestrationEvent,
): WorkspaceAgentEventState {
  if (event.sequence <= state.lastSequence) return state;

  // Durable orchestration sequences are monotonic but not dense: a failed
  // transactional append can leave a sequence hole. Live callers validate a
  // jump with replay before reducing it; an ordered replay is authoritative.
  const base = state;
  const events = [...base.events, event].slice(-WORKSPACE_AGENT_EVENT_BUFFER_LIMIT);
  const threadId = eventThreadId(event);

  if (event.type === "thread.deleted") {
    const { [String(event.payload.threadId)]: _deleted, ...threads } = base.threads;
    return {
      ...base,
      events,
      lastSequence: event.sequence,
      threads: boundThreadEventState(threads, events),
    };
  }
  if (threadId === null) {
    return {
      ...base,
      events,
      lastSequence: event.sequence,
      threads: boundThreadEventState(base.threads, events),
    };
  }

  const current = base.threads[threadId] ?? emptyThreadEventState();
  const next = applyEventToThread(current, event);
  return {
    ...base,
    events,
    lastSequence: event.sequence,
    threads: boundThreadEventState(
      next === current ? base.threads : { ...base.threads, [threadId]: next },
      events,
    ),
  };
}

export function modelEffortLabel(selection: ModelSelection): string | null {
  switch (selection.provider) {
    case "claudeAgent":
      return selection.options?.effort ?? null;
    case "codex":
    case "cursor":
    case "antigravity":
    case "grok":
    case "droid":
      return selection.options?.reasoningEffort ?? null;
    case "pi":
      return selection.options?.thinkingLevel ?? null;
    case "opencode":
      return selection.options?.variant ?? null;
    case "kilo":
      return selection.options?.agent ?? null;
    case "commandCode":
      return null;
  }
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deriveAgentDuration(input: {
  status: AgentStatus;
  latestTurn: OrchestrationLatestTurn | null;
  nowMs: number;
  queuedAt?: string | null;
  sessionUpdatedAt?: string | null;
}): number {
  const turnStart =
    timestamp(input.latestTurn?.startedAt) || timestamp(input.latestTurn?.requestedAt);
  const start =
    input.status === "queued"
      ? timestamp(input.queuedAt) || timestamp(input.sessionUpdatedAt) || turnStart
      : turnStart || timestamp(input.queuedAt) || timestamp(input.sessionUpdatedAt);
  if (start === 0) return 0;
  const terminal =
    input.status === "completed" || input.status === "failed" || input.status === "stopped";
  const end = terminal
    ? timestamp(input.latestTurn?.completedAt) || timestamp(input.sessionUpdatedAt) || start
    : input.nowMs;
  return Math.max(0, end - start);
}

function isStrictLiveStatus(status: AgentStatus): boolean {
  return status === "thinking" || status === "streaming" || status === "tool-running";
}

function newestBySequence<T extends { sequence: number }>(values: readonly T[]): T | null {
  let newest: T | null = null;
  for (const value of values) {
    if (!newest || value.sequence > newest.sequence) newest = value;
  }
  return newest;
}

function oldestQueuedAt(state: WorkspaceAgentThreadEventState | undefined): string | null {
  if (!state) return null;
  let oldest: WorkspaceAgentQueuedMessage | null = null;
  for (const queued of Object.values(state.queuedMessages)) {
    if (!oldest || queued.sequence < oldest.sequence) oldest = queued;
  }
  return oldest?.createdAt ?? null;
}

function deriveStatus(
  thread: WorkspaceAgentShellThread,
  eventState: WorkspaceAgentThreadEventState | undefined,
): AgentStatus {
  const session = thread.session;
  const turn = thread.latestTurn;
  const hasQueuedMessages = Object.keys(eventState?.queuedMessages ?? {}).length > 0;
  if (session?.status === "error" && !hasQueuedMessages) return "failed";
  if ((session?.status === "interrupted" || session?.status === "stopped") && !hasQueuedMessages) {
    return "stopped";
  }
  const turnId = liveTurnId(thread);
  if (turnId !== null) {
    if (Object.values(eventState?.openTools ?? {}).some((tool) => tool.turnId === turnId)) {
      return "tool-running";
    }
    if (
      Object.values(eventState?.streamingMessages ?? {}).some(
        (message) => message.turnId === turnId,
      )
    ) {
      return "streaming";
    }
    return "thinking";
  }
  if (hasQueuedMessages || session?.status === "starting") return "queued";
  if (thread.hasLiveTailWork && (turn === null || turn.state === "running")) return "thinking";
  if (turn?.state === "error") return "failed";
  if (turn?.state === "interrupted") return "stopped";
  if (turn?.state === "completed") return "completed";
  return "idle";
}

function liveTurnId(thread: WorkspaceAgentShellThread): TurnId | null {
  if (
    thread.session?.status === "error" ||
    thread.session?.status === "interrupted" ||
    thread.session?.status === "stopped"
  ) {
    return null;
  }
  if (
    (thread.session?.status === "starting" || thread.session?.status === "running") &&
    thread.session.activeTurnId !== null
  ) {
    return thread.session.activeTurnId;
  }
  if (
    thread.session?.status !== "starting" &&
    thread.hasLiveTailWork &&
    thread.latestTurn?.state === "running"
  ) {
    return thread.latestTurn.turnId;
  }
  if (thread.session === null && thread.latestTurn?.state === "running") {
    return thread.latestTurn.turnId;
  }
  return null;
}

export function resolveWorkspaceAgentInterruptTurnId(
  thread: WorkspaceAgentInterruptSnapshot,
): TurnId | null {
  const session = thread.session;
  if (
    session?.status === "error" ||
    session?.status === "interrupted" ||
    session?.status === "stopped"
  ) {
    return null;
  }
  if (
    (session?.status === "starting" || session?.status === "running") &&
    session.activeTurnId !== null
  ) {
    return session.activeTurnId;
  }
  if (thread.latestTurn?.state !== "running") {
    return null;
  }
  if (session !== null) {
    return session.status !== "starting" && thread.hasLiveTailWork
      ? thread.latestTurn.turnId
      : null;
  }
  const rawThreadId = thread.threadId as string;
  return thread.parentThreadId !== null || rawThreadId.startsWith("subagent:")
    ? thread.latestTurn.turnId
    : null;
}

function createEntry(input: {
  thread: WorkspaceAgentShellThread;
  project: WorkspaceAgentShellProject;
  eventState: WorkspaceAgentThreadEventState | undefined;
  nowMs: number;
}): AgentThreadEntry {
  const { thread, project, eventState } = input;
  const status = deriveStatus(thread, eventState);
  const activeTurnId = liveTurnId(thread);
  const interruptTurnId = resolveWorkspaceAgentInterruptTurnId(thread);
  const turnId =
    interruptTurnId ??
    (status === "completed" || status === "failed" || status === "stopped"
      ? (thread.latestTurn?.turnId ?? null)
      : null);
  const openTool = activeTurnId
    ? newestBySequence(
        Object.values(eventState?.openTools ?? {}).filter((tool) => tool.turnId === activeTurnId),
      )
    : null;
  const completedTool = turnId ? eventState?.latestCompletedToolByTurn[turnId] : undefined;
  const streamingMessage = activeTurnId
    ? newestBySequence(
        Object.values(eventState?.streamingMessages ?? {}).filter(
          (message) => message.turnId === activeTurnId,
        ),
      )
    : null;
  const createdAt = timestamp(thread.createdAt);
  const lastActivityAt = Math.max(
    createdAt,
    timestamp(eventState?.lastActivityAt),
    timestamp(thread.session?.updatedAt),
    timestamp(thread.latestTurn?.requestedAt),
    timestamp(thread.latestTurn?.startedAt),
    timestamp(thread.latestTurn?.completedAt),
  );
  return {
    threadId: thread.threadId,
    projectId: thread.projectId,
    projectTitle: project.projectTitle,
    projectCwd: project.projectCwd,
    threadTitle: thread.threadTitle,
    parentThreadId: thread.parentThreadId,
    isSubagent:
      thread.parentThreadId !== null ||
      thread.subagentAgentId !== null ||
      thread.subagentNickname !== null ||
      thread.subagentRole !== null,
    subagentNickname: thread.subagentNickname,
    subagentRole: thread.subagentRole,
    modelLabel:
      formatSubagentModelLabel(thread.modelSelection.model) ?? thread.modelSelection.model,
    effortLabel: modelEffortLabel(thread.modelSelection),
    providerKind: thread.session?.providerKind ?? thread.modelSelection.provider,
    status,
    duration: deriveAgentDuration({
      status,
      latestTurn: thread.latestTurn,
      nowMs: input.nowMs,
      queuedAt: oldestQueuedAt(eventState),
      sessionUpdatedAt: thread.session?.updatedAt ?? null,
    }),
    latestTool: openTool
      ? { name: openTool.name, state: "running" }
      : completedTool
        ? { name: completedTool.name, state: "done" }
        : null,
    streamPreview: streamingMessage?.text.trim().slice(-80) || null,
    associatedWorktreeBranch: thread.associatedWorktreeBranch,
    createdAt,
    lastActivityAt,
    turnId,
  };
}

const STATUS_ORDER: Record<AgentStatus, number> = {
  "tool-running": 0,
  streaming: 1,
  thinking: 2,
  queued: 3,
  failed: 4,
  stopped: 5,
  completed: 6,
  idle: 7,
};

function compareEntries(left: AgentThreadEntry, right: AgentThreadEntry): number {
  const status = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  if (status !== 0) return status;
  const activity = right.lastActivityAt - left.lastActivityAt;
  if (activity !== 0) return activity;
  const created = right.createdAt - left.createdAt;
  if (created !== 0) return created;
  return String(left.threadId).localeCompare(String(right.threadId));
}

function summarize(entries: readonly AgentThreadEntry[]): WorkspaceAgentSummary {
  return entries.reduce<WorkspaceAgentSummary>(
    (summary, entry) => {
      summary.total += 1;
      if (isStrictLiveStatus(entry.status)) summary.running += 1;
      if (entry.status === "queued") summary.queued += 1;
      if (entry.status === "completed") summary.completed += 1;
      if (entry.status === "failed") summary.failed += 1;
      return summary;
    },
    { total: 0, running: 0, queued: 0, completed: 0, failed: 0 },
  );
}

function effectiveParents(entries: readonly AgentThreadEntry[]): Map<ThreadId, ThreadId | null> {
  const byId = new Map(entries.map((entry) => [entry.threadId, entry]));
  const parents = new Map<ThreadId, ThreadId | null>();
  for (const entry of entries) {
    const parent = entry.parentThreadId;
    parents.set(
      entry.threadId,
      parent && parent !== entry.threadId && byId.get(parent)?.projectId === entry.projectId
        ? parent
        : null,
    );
  }

  for (const start of [...byId.keys()].sort((a, b) => String(a).localeCompare(String(b)))) {
    const path: ThreadId[] = [];
    const position = new Map<ThreadId, number>();
    let current: ThreadId | null = start;
    while (current !== null) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        const breaker = path
          .slice(cycleStart)
          .sort((a, b) => String(a).localeCompare(String(b)))[0];
        if (breaker) parents.set(breaker, null);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = parents.get(current) ?? null;
    }
  }
  return parents;
}

function familyRoot(threadId: ThreadId, parents: ReadonlyMap<ThreadId, ThreadId | null>): ThreadId {
  let current = threadId;
  const visited = new Set<ThreadId>();
  while (!visited.has(current)) {
    visited.add(current);
    const parent = parents.get(current) ?? null;
    if (parent === null) return current;
    current = parent;
  }
  return current;
}

function buildTree(
  entries: readonly AgentThreadEntry[],
  parents: ReadonlyMap<ThreadId, ThreadId | null>,
): AgentThreadTreeNode[] {
  const nodes = new Map<ThreadId, AgentThreadTreeNode>(
    entries.map((entry) => [entry.threadId, { entry, children: [] }]),
  );
  const roots: AgentThreadTreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.threadId)!;
    const parentNode = nodes.get(parents.get(entry.threadId) ?? ("" as ThreadId));
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: AgentThreadTreeNode[]) => {
    items.sort((left, right) => compareEntries(left.entry, right.entry));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}

export function deriveWorkspaceAgentActivity(input: {
  projects: readonly WorkspaceAgentShellProject[];
  threads: readonly WorkspaceAgentShellThread[];
  eventState: WorkspaceAgentEventState;
  nowMs: number;
  projectIds?: readonly ProjectId[];
}): WorkspaceAgentActivity {
  const requestedProjects = input.projectIds ? new Set(input.projectIds) : null;
  const projects = input.projects.filter(
    (project) => requestedProjects === null || requestedProjects.has(project.projectId),
  );
  const projectById = new Map(projects.map((project) => [project.projectId, project]));
  const visibleShellThreads = input.threads.filter(
    (thread) => thread.archivedAt === null && projectById.has(thread.projectId),
  );
  const shellThreadById = new Map(visibleShellThreads.map((thread) => [thread.threadId, thread]));
  const allEntries = visibleShellThreads.map((thread) =>
    createEntry({
      thread,
      project: projectById.get(thread.projectId)!,
      eventState: input.eventState.threads[thread.threadId],
      nowMs: input.nowMs,
    }),
  );
  const hasCurrentWork = allEntries.some(
    (entry) => isStrictLiveStatus(entry.status) || entry.status === "queued",
  );
  if (!hasCurrentWork) return EMPTY_ACTIVITY;

  const parents = effectiveParents(allEntries);
  const liveRoots = new Set(
    allEntries
      .filter((entry) => isStrictLiveStatus(entry.status) || entry.status === "queued")
      .map((entry) => familyRoot(entry.threadId, parents)),
  );
  const requiredAncestors = new Set<ThreadId>();
  const activeBoundaryByRoot = new Map<ThreadId, number>();
  for (const entry of allEntries) {
    if (!isStrictLiveStatus(entry.status) && entry.status !== "queued") continue;
    let current: ThreadId | null = entry.threadId;
    while (current !== null) {
      requiredAncestors.add(current);
      current = parents.get(current) ?? null;
    }
    const root = familyRoot(entry.threadId, parents);
    const shellThread = shellThreadById.get(entry.threadId);
    const queuedAt = timestamp(oldestQueuedAt(input.eventState.threads[entry.threadId]));
    const boundary =
      entry.status === "queued"
        ? queuedAt ||
          timestamp(shellThread?.session?.updatedAt) ||
          timestamp(shellThread?.latestTurn?.requestedAt) ||
          entry.lastActivityAt
        : timestamp(shellThread?.latestTurn?.requestedAt) ||
          timestamp(shellThread?.session?.updatedAt) ||
          entry.lastActivityAt;
    const previousBoundary = activeBoundaryByRoot.get(root);
    if (previousBoundary === undefined || boundary < previousBoundary) {
      activeBoundaryByRoot.set(root, boundary);
    }
  }
  const visible = allEntries.filter((entry) => {
    const root = familyRoot(entry.threadId, parents);
    if (!liveRoots.has(root)) return false;
    if (requiredAncestors.has(entry.threadId)) return true;
    if (entry.status === "idle") return false;
    return entry.lastActivityAt >= (activeBoundaryByRoot.get(root) ?? Number.POSITIVE_INFINITY);
  });

  const groups: AgentProjectGroup[] = [];
  for (const project of projects) {
    const projectEntries = visible.filter((entry) => entry.projectId === project.projectId);
    if (projectEntries.length === 0) continue;
    groups.push({
      projectId: project.projectId,
      projectTitle: project.projectTitle,
      projectCwd: project.projectCwd,
      nodes: buildTree(projectEntries, parents),
      summary: summarize(projectEntries),
    });
  }
  const flatten = (nodes: readonly AgentThreadTreeNode[]): AgentThreadEntry[] =>
    nodes.flatMap((node) => [node.entry, ...flatten(node.children)]);
  const threads = groups.flatMap((group) => flatten(group.nodes));
  return { threads, groups, summary: summarize(threads) };
}
