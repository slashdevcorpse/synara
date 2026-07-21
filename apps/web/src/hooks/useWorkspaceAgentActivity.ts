// FILE: useWorkspaceAgentActivity.ts
// Purpose: Bridge stable shell state and the global orchestration stream into workspace agent rows.
// Layer: React data hook
// Exports: workspace-wide and per-thread activity hooks, public activity types,
// live-status predicate, and test seams

import type {
  NativeApi,
  OrchestrationEvent,
  OrchestrationShellStreamItem,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { readNativeApi } from "../nativeApi";
import { type AppState, useStore } from "../store";
import type { Project, SidebarThreadSummary } from "../types";
import { addWsTransportStateListener, type WsTransportState } from "../wsTransportEvents";
import {
  createInitialWorkspaceAgentEventState,
  createWorkspaceAgentEventStateAtSequence,
  deriveWorkspaceAgentThreadActivity,
  deriveWorkspaceAgentActivity,
  isLiveAgentStatus,
  reduceWorkspaceAgentEventState,
  WORKSPACE_AGENT_EVENT_BUFFER_LIMIT,
  type AgentProjectGroup,
  type AgentStatus,
  type AgentThreadEntry,
  type AgentThreadTreeNode,
  type AgentToolActivity,
  type WorkspaceAgentActivity,
  type WorkspaceAgentEventState,
  type WorkspaceAgentShellProject,
  type WorkspaceAgentShellSession,
  type WorkspaceAgentShellThread,
  type WorkspaceAgentSummary,
  type WorkspaceAgentThreadActivity,
} from "../lib/workspaceAgentActivity";

export { isLiveAgentStatus };

export type {
  AgentProjectGroup,
  AgentStatus,
  AgentThreadEntry,
  AgentThreadTreeNode,
  AgentToolActivity,
  WorkspaceAgentActivity,
  WorkspaceAgentSummary,
  WorkspaceAgentThreadActivity,
};

const ASSISTANT_PUBLICATION_INTERVAL_MS = 500;
const CLOCK_INTERVAL_MS = 500;
const RECOVERY_RETRY_MIN_MS = 250;
const RECOVERY_RETRY_MAX_MS = 5_000;

export interface WorkspaceAgentEventPublisher {
  subscribe(listener: () => void): () => void;
  push(event: OrchestrationEvent): void;
  replace(state: WorkspaceAgentEventState): boolean;
  advanceCursor(sequence: number): void;
  getCurrentSequence(): number;
  reset(): void;
  getSnapshot(): WorkspaceAgentEventState;
  dispose(): void;
}

function isCoalescedAssistantDelta(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" &&
    event.payload.role === "assistant" &&
    event.payload.streaming
  );
}

export function createWorkspaceAgentEventPublisher(): WorkspaceAgentEventPublisher {
  let latest = createInitialWorkspaceAgentEventState();
  let published = latest;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const publish = () => {
    cancelTimer();
    published = latest;
    for (const listener of listeners) listener();
  };
  const publishReset = (generation: number) => {
    cancelTimer();
    latest = createInitialWorkspaceAgentEventState(generation);
    publish();
  };

  return {
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(event) {
      if (disposed || event.sequence <= latest.lastSequence) return;
      latest = reduceWorkspaceAgentEventState(latest, event);
      if (!isCoalescedAssistantDelta(event)) {
        publish();
        return;
      }
      if (timer === null) {
        timer = setTimeout(publish, ASSISTANT_PUBLICATION_INTERVAL_MS);
      }
    },
    replace(state) {
      if (
        disposed ||
        state.generation < latest.generation ||
        (state.generation === latest.generation && state.lastSequence < latest.lastSequence)
      ) {
        return false;
      }
      cancelTimer();
      latest = state;
      publish();
      return true;
    },
    advanceCursor(sequence) {
      if (disposed || sequence <= latest.lastSequence) return;
      latest = { ...latest, lastSequence: sequence };
      publish();
    },
    getCurrentSequence() {
      return latest.lastSequence;
    },
    reset() {
      if (disposed) return;
      publishReset(latest.generation + 1);
    },
    getSnapshot() {
      return published;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      latest = createInitialWorkspaceAgentEventState(latest.generation + 1);
      published = latest;
      listeners.clear();
    },
  };
}

type WorkspaceAgentOrchestrationSource = Pick<
  NativeApi["orchestration"],
  "getShellSnapshot" | "replayEvents" | "onDomainEvent" | "onShellEvent"
>;

export interface WorkspaceAgentEventConnectionDependencies {
  orchestration: WorkspaceAgentOrchestrationSource;
  addTransportStateListener: (listener: (state: WsTransportState) => void) => () => void;
}

export function connectWorkspaceAgentEventPublisher(
  publisher: WorkspaceAgentEventPublisher,
  dependencies: WorkspaceAgentEventConnectionDependencies,
): () => void {
  let cleaned = false;
  let online = true;
  let epoch = 0;
  let cursor = -1;
  let needsBootstrap = true;
  let requestedBoundary: number | null = null;
  let requestedWatermark = -1;
  let rerunRequested = false;
  let reconcilePromise: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  const pendingLive = new Map<number, OrchestrationEvent>();

  const sortedEvents = (events: Iterable<OrchestrationEvent>): OrchestrationEvent[] =>
    Array.from(new Map(Array.from(events, (event) => [event.sequence, event])).values()).toSorted(
      (left, right) => left.sequence - right.sequence,
    );

  const replayThroughTarget = async (
    fromSequenceExclusive: number,
    targetSequence: number,
    runEpoch: number,
  ): Promise<OrchestrationEvent[] | null> => {
    const replayed = new Map<number, OrchestrationEvent>();
    let replayCursor = fromSequenceExclusive;
    while (!cleaned && online && runEpoch === epoch) {
      const page = sortedEvents(
        (await dependencies.orchestration.replayEvents(replayCursor)).filter(
          (event) => event.sequence > replayCursor,
        ),
      );
      if (cleaned || !online || runEpoch !== epoch) return null;
      if (page.length === 0) break;
      for (const event of page) replayed.set(event.sequence, event);
      const nextCursor = page.at(-1)!.sequence;
      if (nextCursor <= replayCursor) break;
      replayCursor = nextCursor;
      if (replayCursor >= targetSequence) break;
    }
    return sortedEvents(replayed.values());
  };

  const highestPendingSequence = (): number => {
    let highest = -1;
    for (const sequence of pendingLive.keys()) highest = Math.max(highest, sequence);
    return highest;
  };

  const cancelRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (cleaned || !online || retryTimer !== null) return;
    const delay = Math.min(RECOVERY_RETRY_MAX_MS, RECOVERY_RETRY_MIN_MS * 2 ** retryAttempt);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestReconcile();
    }, delay);
  };

  const drainPendingLive = () => {
    for (const event of sortedEvents(pendingLive.values())) {
      if (event.sequence <= cursor) {
        pendingLive.delete(event.sequence);
        continue;
      }
      if (event.sequence !== cursor + 1) break;
      pendingLive.delete(event.sequence);
      publisher.push(event);
      cursor = event.sequence;
    }
  };

  const runBootstrap = async (runEpoch: number): Promise<boolean> => {
    const suppliedBoundary = requestedBoundary;
    requestedBoundary = null;
    const boundary =
      suppliedBoundary ?? (await dependencies.orchestration.getShellSnapshot()).snapshotSequence;
    if (cleaned || !online || runEpoch !== epoch) return false;
    const replayStart = Math.max(0, boundary - WORKSPACE_AGENT_EVENT_BUFFER_LIMIT);
    const replayTarget = Math.max(boundary, highestPendingSequence());
    const replayed = await replayThroughTarget(replayStart, replayTarget, runEpoch);
    if (replayed === null || cleaned || !online || runEpoch !== epoch) return false;

    let recovered = createWorkspaceAgentEventStateAtSequence(
      replayStart,
      publisher.getSnapshot().generation + 1,
    );
    for (const event of replayed) {
      recovered = reduceWorkspaceAgentEventState(recovered, event);
    }
    recovered = {
      ...recovered,
      lastSequence: Math.max(boundary, recovered.lastSequence),
    };
    if (!publisher.replace(recovered)) return false;
    cursor = recovered.lastSequence;
    requestedWatermark = Math.max(requestedWatermark, boundary);
    drainPendingLive();
    return true;
  };

  const runCatchup = async (runEpoch: number): Promise<boolean> => {
    const replayTarget = Math.max(requestedWatermark, highestPendingSequence());
    if (replayTarget <= cursor) {
      drainPendingLive();
      return true;
    }
    const replayed = await replayThroughTarget(cursor, replayTarget, runEpoch);
    if (replayed === null || cleaned || !online || runEpoch !== epoch) return false;
    for (const event of replayed) {
      if (event.sequence <= cursor) continue;
      publisher.push(event);
      cursor = event.sequence;
    }
    if (requestedWatermark > cursor) {
      cursor = requestedWatermark;
      publisher.advanceCursor(cursor);
    }
    drainPendingLive();
    return true;
  };

  function requestReconcile(): void {
    if (cleaned || !online) return;
    cancelRetry();
    if (reconcilePromise !== null) {
      rerunRequested = true;
      return;
    }
    const runEpoch = epoch;
    const bootstrap = needsBootstrap;
    needsBootstrap = false;
    rerunRequested = false;
    let succeeded = false;
    let failed = false;
    reconcilePromise = (bootstrap ? runBootstrap(runEpoch) : runCatchup(runEpoch))
      .then((result) => {
        succeeded = result;
        if (result) {
          retryAttempt = 0;
          cancelRetry();
        }
      })
      .catch(() => {
        failed = true;
        if (bootstrap && runEpoch === epoch) needsBootstrap = true;
      })
      .finally(() => {
        if (runEpoch !== epoch) return;
        reconcilePromise = null;
        if (cleaned || !online) return;
        const boundaryNeedsCatchup = requestedBoundary !== null && requestedBoundary > cursor;
        if (boundaryNeedsCatchup) {
          requestedWatermark = Math.max(requestedWatermark, requestedBoundary!);
        }
        requestedBoundary = null;
        if (failed) {
          rerunRequested = false;
          scheduleRetry();
        } else if (rerunRequested || (boundaryNeedsCatchup && succeeded)) {
          rerunRequested = false;
          requestReconcile();
        }
      });
  }

  const unsubscribeDomain = dependencies.orchestration.onDomainEvent((event) => {
    if (cleaned || !online || event.sequence <= cursor) return;
    if (needsBootstrap || reconcilePromise !== null || event.sequence !== cursor + 1) {
      pendingLive.set(event.sequence, event);
      requestReconcile();
      return;
    }
    publisher.push(event);
    cursor = event.sequence;
  });
  const unsubscribeShell = dependencies.orchestration.onShellEvent(
    (item: OrchestrationShellStreamItem) => {
      if (cleaned || !online || item.kind !== "snapshot") return;
      const boundary = item.snapshot.snapshotSequence;
      if (cursor < 0 || needsBootstrap) {
        requestedBoundary = Math.max(requestedBoundary ?? 0, boundary);
        requestReconcile();
      } else if (boundary > cursor) {
        requestedWatermark = Math.max(requestedWatermark, boundary);
        requestReconcile();
      }
    },
  );
  const unsubscribeTransport = dependencies.addTransportStateListener((state) => {
    if (cleaned) return;
    if (state === "open") {
      cancelRetry();
      epoch += 1;
      online = true;
      cursor = -1;
      needsBootstrap = true;
      requestedBoundary = null;
      requestedWatermark = -1;
      rerunRequested = false;
      reconcilePromise = null;
      pendingLive.clear();
      requestReconcile();
      return;
    }
    if (online) {
      cancelRetry();
      epoch += 1;
      online = false;
      cursor = -1;
      needsBootstrap = true;
      requestedBoundary = null;
      requestedWatermark = -1;
      rerunRequested = false;
      reconcilePromise = null;
      pendingLive.clear();
    }
  });

  requestReconcile();
  return () => {
    if (cleaned) return;
    cleaned = true;
    cancelRetry();
    unsubscribeTransport();
    unsubscribeShell();
    unsubscribeDomain();
    publisher.reset();
  };
}

export interface WorkspaceAgentShellSnapshot {
  projects: readonly WorkspaceAgentShellProject[];
  threads: readonly WorkspaceAgentShellThread[];
}

function shellSession(summary: SidebarThreadSummary): WorkspaceAgentShellSession | null {
  const session = summary.session;
  if (!session) return null;
  return {
    providerKind: session.provider,
    status: session.orchestrationStatus,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    updatedAt: session.updatedAt,
  };
}

function shellProject(project: Project): WorkspaceAgentShellProject {
  return {
    projectId: project.id,
    projectTitle: project.localName ?? project.name,
    projectCwd: project.cwd,
  };
}

function shellThread(summary: SidebarThreadSummary): WorkspaceAgentShellThread {
  return {
    threadId: summary.id,
    projectId: summary.projectId,
    threadTitle: summary.title,
    parentThreadId: summary.parentThreadId ?? null,
    subagentAgentId: summary.subagentAgentId ?? null,
    subagentNickname: summary.subagentNickname ?? null,
    subagentRole: summary.subagentRole ?? null,
    modelSelection: summary.modelSelection,
    session: shellSession(summary),
    latestTurn: summary.latestTurn,
    hasLiveTailWork: summary.hasLiveTailWork,
    associatedWorktreeBranch: summary.associatedWorktreeBranch ?? null,
    createdAt: summary.createdAt,
    archivedAt: summary.archivedAt ?? null,
  };
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalShellProject(
  left: WorkspaceAgentShellProject,
  right: WorkspaceAgentShellProject,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.projectTitle === right.projectTitle &&
    left.projectCwd === right.projectCwd
  );
}

function equalShellSession(
  left: WorkspaceAgentShellSession | null,
  right: WorkspaceAgentShellSession | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.providerKind === right.providerKind &&
    left.status === right.status &&
    left.activeTurnId === right.activeTurnId &&
    left.lastError === right.lastError &&
    left.updatedAt === right.updatedAt
  );
}

function equalShellThread(
  left: WorkspaceAgentShellThread,
  right: WorkspaceAgentShellThread,
): boolean {
  return (
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.threadTitle === right.threadTitle &&
    left.parentThreadId === right.parentThreadId &&
    left.subagentAgentId === right.subagentAgentId &&
    left.subagentNickname === right.subagentNickname &&
    left.subagentRole === right.subagentRole &&
    equalJson(left.modelSelection, right.modelSelection) &&
    equalShellSession(left.session, right.session) &&
    equalJson(left.latestTurn, right.latestTurn) &&
    left.hasLiveTailWork === right.hasLiveTailWork &&
    left.associatedWorktreeBranch === right.associatedWorktreeBranch &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt
  );
}

function equalShellSnapshot(
  left: WorkspaceAgentShellSnapshot,
  right: WorkspaceAgentShellSnapshot,
): boolean {
  return (
    left.projects.length === right.projects.length &&
    left.threads.length === right.threads.length &&
    left.projects.every((project, index) => equalShellProject(project, right.projects[index]!)) &&
    left.threads.every((thread, index) => equalShellThread(thread, right.threads[index]!))
  );
}

export function createWorkspaceAgentShellSelector(): (
  state: AppState,
) => WorkspaceAgentShellSnapshot {
  let previous: WorkspaceAgentShellSnapshot = { projects: [], threads: [] };
  let previousProjects: AppState["projects"] | undefined;
  let previousThreadIds: AppState["threadIds"];
  let previousSummaryById: AppState["sidebarThreadSummaryById"] | undefined;
  return (state) => {
    if (
      state.projects === previousProjects &&
      state.threadIds === previousThreadIds &&
      state.sidebarThreadSummaryById === previousSummaryById
    ) {
      return previous;
    }
    previousProjects = state.projects;
    previousThreadIds = state.threadIds;
    previousSummaryById = state.sidebarThreadSummaryById;
    const next: WorkspaceAgentShellSnapshot = {
      projects: state.projects.map(shellProject),
      threads: (state.threadIds ?? []).flatMap((threadId) => {
        const summary = state.sidebarThreadSummaryById[threadId];
        if (!summary) return [];
        return [shellThread(summary)];
      }),
    };
    if (equalShellSnapshot(previous, next)) return previous;
    previous = next;
    return next;
  };
}

export function createWorkspaceAgentThreadShellSelector(
  threadId: ThreadId,
): (state: AppState) => WorkspaceAgentShellSnapshot {
  let previous: WorkspaceAgentShellSnapshot = { projects: [], threads: [] };
  return (state) => {
    const target = state.sidebarThreadSummaryById[threadId];
    if (!target) {
      if (previous.projects.length === 0 && previous.threads.length === 0) return previous;
      previous = { projects: [], threads: [] };
      return previous;
    }

    const relatedThreadIds = new Set<ThreadId>([target.id]);
    if (target.parentThreadId) relatedThreadIds.add(target.parentThreadId);
    for (const candidateId of state.threadIds ?? []) {
      const candidate = state.sidebarThreadSummaryById[candidateId];
      if (candidate?.parentThreadId === target.id) relatedThreadIds.add(candidate.id);
    }
    const summaries = [...relatedThreadIds].flatMap((relatedThreadId) => {
      const summary = state.sidebarThreadSummaryById[relatedThreadId];
      return summary ? [summary] : [];
    });
    const projectIds = new Set(summaries.map((summary) => summary.projectId));
    const next: WorkspaceAgentShellSnapshot = {
      projects: state.projects.filter((project) => projectIds.has(project.id)).map(shellProject),
      threads: summaries.map(shellThread),
    };
    if (equalShellSnapshot(previous, next)) return previous;
    previous = next;
    return next;
  };
}

const publisher = createWorkspaceAgentEventPublisher();
let publisherSubscriberCount = 0;
let disconnectPublisher: (() => void) | null = null;

function subscribePublisher(listener: () => void): () => void {
  const unsubscribe = publisher.subscribe(listener);
  publisherSubscriberCount += 1;
  if (publisherSubscriberCount === 1) {
    const api = readNativeApi();
    if (api) {
      disconnectPublisher = connectWorkspaceAgentEventPublisher(publisher, {
        orchestration: api.orchestration,
        addTransportStateListener: addWsTransportStateListener,
      });
    }
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    unsubscribe();
    publisherSubscriberCount = Math.max(0, publisherSubscriberCount - 1);
    if (publisherSubscriberCount === 0) {
      disconnectPublisher?.();
      disconnectPublisher = null;
      publisher.reset();
    }
  };
}

export interface WorkspaceAgentClock {
  subscribe(listener: () => void): () => void;
  getSnapshot(): number;
}

export function createWorkspaceAgentClock(now: () => number = Date.now): WorkspaceAgentClock {
  let current = now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === null) {
        current = now();
        timer = setInterval(() => {
          current = now();
          for (const clockListener of listeners) clockListener();
        }, CLOCK_INTERVAL_MS);
      }
      let cleaned = false;
      return () => {
        if (cleaned) return;
        cleaned = true;
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot() {
      return current;
    },
  };
}

const workspaceAgentClock = createWorkspaceAgentClock();
const subscribeClock = workspaceAgentClock.subscribe;
const getClockSnapshot = workspaceAgentClock.getSnapshot;

const subscribeDisabledClock = () => () => undefined;
const getDisabledClockSnapshot = () => 0;
const SERVER_EVENT_SNAPSHOT = createInitialWorkspaceAgentEventState();
const getServerEventSnapshot = () => SERVER_EVENT_SNAPSHOT;
const selectWorkspaceAgentShell = createWorkspaceAgentShellSelector();

export function useWorkspaceAgentActivity(
  projectIds?: readonly ProjectId[],
): WorkspaceAgentActivity {
  const shell = useStore(selectWorkspaceAgentShell);
  const eventState = useSyncExternalStore(
    subscribePublisher,
    publisher.getSnapshot,
    getServerEventSnapshot,
  );
  const initialActivity = useMemo(
    () =>
      deriveWorkspaceAgentActivity({
        ...shell,
        eventState,
        nowMs: getClockSnapshot(),
      }),
    [eventState, shell],
  );
  const hasCurrentWork = initialActivity.summary.running + initialActivity.summary.queued > 0;
  const nowMs = useSyncExternalStore(
    hasCurrentWork ? subscribeClock : subscribeDisabledClock,
    hasCurrentWork ? getClockSnapshot : getDisabledClockSnapshot,
    getDisabledClockSnapshot,
  );
  const projectKey = projectIds ? JSON.stringify(projectIds) : null;
  const selectedProjectIds = useMemo(
    () => (projectKey === null ? undefined : (JSON.parse(projectKey) as ProjectId[])),
    [projectKey],
  );
  return useMemo(() => {
    const currentNow = hasCurrentWork ? nowMs : getClockSnapshot();
    if (!selectedProjectIds && !hasCurrentWork) return initialActivity;
    return deriveWorkspaceAgentActivity({
      ...shell,
      eventState,
      nowMs: currentNow,
      ...(selectedProjectIds ? { projectIds: selectedProjectIds } : {}),
    });
  }, [eventState, hasCurrentWork, initialActivity, nowMs, selectedProjectIds, shell]);
}

export function useWorkspaceAgentThreadActivity(
  threadId: ThreadId,
): WorkspaceAgentThreadActivity {
  const selectThreadShell = useMemo(
    () => createWorkspaceAgentThreadShellSelector(threadId),
    [threadId],
  );
  const shell = useStore(selectThreadShell);
  const eventState = useSyncExternalStore(
    subscribePublisher,
    publisher.getSnapshot,
    getServerEventSnapshot,
  );
  const initialActivity = useMemo(
    () =>
      deriveWorkspaceAgentThreadActivity({
        threadId,
        ...shell,
        eventState,
        nowMs: getClockSnapshot(),
      }),
    [eventState, shell, threadId],
  );
  const hasTimedActivity =
    initialActivity.entry?.status === "thinking" ||
    initialActivity.entry?.status === "streaming" ||
    initialActivity.entry?.status === "tool-running";
  const nowMs = useSyncExternalStore(
    hasTimedActivity ? subscribeClock : subscribeDisabledClock,
    hasTimedActivity ? getClockSnapshot : getDisabledClockSnapshot,
    getDisabledClockSnapshot,
  );

  return useMemo(() => {
    if (!hasTimedActivity) return initialActivity;
    return deriveWorkspaceAgentThreadActivity({
      threadId,
      ...shell,
      eventState,
      nowMs,
    });
  }, [eventState, hasTimedActivity, initialActivity, nowMs, shell, threadId]);
}
