import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
} from "@synara/contracts";

import {
  connectWorkspaceAgentEventPublisher,
  createWorkspaceAgentClock,
  createWorkspaceAgentEventPublisher,
  createWorkspaceAgentShellSelector,
  createWorkspaceAgentThreadShellSelector,
  isLiveAgentStatus,
} from "./useWorkspaceAgentActivity";
import { createWorkspaceAgentEventStateAtSequence } from "../lib/workspaceAgentActivity";
import type { AppState } from "../store";
import type { Project, SidebarThreadSummary } from "../types";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const BASE_TIME = "2026-07-20T12:00:00.000Z";

function assistantEvent(sequence: number, text: string): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: new Date(Date.parse(BASE_TIME) + sequence * 10).toISOString(),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId: MessageId.makeUnsafe("assistant-1"),
      role: "assistant",
      text,
      turnId: TURN_ID,
      streaming: true,
      source: "native",
      createdAt: BASE_TIME,
      updatedAt: new Date(Date.parse(BASE_TIME) + sequence * 10).toISOString(),
    },
  };
}

function toolEvent(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: new Date(Date.parse(BASE_TIME) + sequence * 10).toISOString(),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId: THREAD_ID,
      activity: {
        id: EventId.makeUnsafe(`activity-${sequence}`),
        tone: "tool",
        kind: "tool.started",
        summary: "Read file",
        payload: { providerItemId: "tool-1", title: "Read file" },
        turnId: TURN_ID,
        createdAt: new Date(Date.parse(BASE_TIME) + sequence * 10).toISOString(),
      },
    },
  };
}

function shellSnapshot(snapshotSequence: number): OrchestrationShellSnapshot {
  return {
    snapshotSequence,
    projects: [],
    threads: [],
    updatedAt: BASE_TIME,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workspace agent event publication", () => {
  it("coalesces assistant delta publication to one trailing update per 500ms", () => {
    vi.useFakeTimers();
    const publisher = createWorkspaceAgentEventPublisher();
    const listener = vi.fn();
    const unsubscribe = publisher.subscribe(listener);

    publisher.push(assistantEvent(1, "one"));
    publisher.push(assistantEvent(2, " two"));
    publisher.push(assistantEvent(3, " three"));

    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(publisher.getSnapshot().threads[THREAD_ID]?.streamingMessages["assistant-1"]?.text).toBe(
      "one two three",
    );

    unsubscribe();
    publisher.dispose();
  });

  it("publishes tool events immediately and flushes pending assistant state", () => {
    vi.useFakeTimers();
    const publisher = createWorkspaceAgentEventPublisher();
    const listener = vi.fn();
    publisher.subscribe(listener);

    publisher.push(assistantEvent(1, "one"));
    publisher.push(toolEvent(2));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(publisher.getSnapshot().threads[THREAD_ID]?.openTools).toHaveProperty(
      `${TURN_ID}:provider:tool-1`,
    );
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(1);

    publisher.dispose();
  });

  it("cancels pending publication and clears stale telemetry on reset/dispose", () => {
    vi.useFakeTimers();
    const publisher = createWorkspaceAgentEventPublisher();
    const listener = vi.fn();
    publisher.subscribe(listener);

    publisher.push(assistantEvent(1, "stale"));
    publisher.reset();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(publisher.getSnapshot().events).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(1);

    publisher.dispose();
    expect(publisher.getSnapshot().events).toEqual([]);
  });

  it("accepts a trusted sparse sequence without publishing an empty reset", () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const snapshots: number[][] = [];
    publisher.subscribe(() => {
      snapshots.push(publisher.getSnapshot().events.map((event) => event.sequence));
    });

    publisher.push(toolEvent(1));
    publisher.push({ ...toolEvent(3), eventId: EventId.makeUnsafe("event-3-gap") });

    expect(snapshots).toEqual([[1], [1, 3]]);
    publisher.dispose();
  });

  it("accepts a lower cursor only from a newer recovery generation", () => {
    const publisher = createWorkspaceAgentEventPublisher();

    publisher.push(toolEvent(10));

    expect(publisher.replace(createWorkspaceAgentEventStateAtSequence(9, 0))).toBe(false);
    expect(publisher.replace(createWorkspaceAgentEventStateAtSequence(1, 1))).toBe(true);
    expect(publisher.getCurrentSequence()).toBe(1);
    expect(publisher.replace(createWorkspaceAgentEventStateAtSequence(20, 0))).toBe(false);
    expect(publisher.getCurrentSequence()).toBe(1);
    publisher.dispose();
  });

  it("preserves telemetry on transport loss and removes every injected listener on cleanup", async () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const listener = vi.fn();
    publisher.subscribe(listener);
    let domainListener: ((event: OrchestrationEvent) => void) | null = null;
    let transportListener: ((state: "closed") => void) | null = null;
    const unsubscribeDomain = vi.fn();
    const unsubscribeShell = vi.fn();
    const unsubscribeTransport = vi.fn();
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot: async () => shellSnapshot(0),
        replayEvents: async () => [],
        onDomainEvent(callback) {
          domainListener = callback;
          return unsubscribeDomain;
        },
        onShellEvent() {
          return unsubscribeShell;
        },
      },
      addTransportStateListener(callback) {
        transportListener = callback as (state: "closed") => void;
        return unsubscribeTransport;
      },
    });

    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(0));
    domainListener!(toolEvent(1));
    expect(publisher.getSnapshot().events).toHaveLength(1);
    transportListener!("closed");
    expect(publisher.getSnapshot().events).toHaveLength(1);

    cleanup();
    cleanup();
    expect(unsubscribeDomain).toHaveBeenCalledTimes(1);
    expect(unsubscribeShell).toHaveBeenCalledTimes(1);
    expect(unsubscribeTransport).toHaveBeenCalledTimes(1);
    publisher.dispose();
  });

  it("buffers live-before-snapshot overlap and publishes it exactly once", async () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const snapshotRequest = deferred<OrchestrationShellSnapshot>();
    let domainListener: ((event: OrchestrationEvent) => void) | null = null;
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) =>
      fromSequenceExclusive === 0 ? [toolEvent(1)] : [],
    );
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot: () => snapshotRequest.promise,
        replayEvents,
        onDomainEvent(callback) {
          domainListener = callback;
          return () => undefined;
        },
        onShellEvent() {
          return () => undefined;
        },
      },
      addTransportStateListener: () => () => undefined,
    });

    domainListener!(toolEvent(1));
    snapshotRequest.resolve(shellSnapshot(1));

    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(1));
    expect(publisher.getSnapshot().events.map((event) => event.sequence)).toEqual([1]);
    expect(
      publisher.getSnapshot().threads[THREAD_ID]?.openTools[`${TURN_ID}:provider:tool-1`]?.count,
    ).toBe(1);
    expect(replayEvents).toHaveBeenCalledWith(0);
    cleanup();
    publisher.dispose();
  });

  it("replays the bounded tail on mount to recover an already-running tool", async () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const started = { ...toolEvent(5), eventId: EventId.makeUnsafe("mounted-tool") };
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) =>
      fromSequenceExclusive < 5 ? [started] : [],
    );
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot: async () => shellSnapshot(5),
        replayEvents,
        onDomainEvent() {
          return () => undefined;
        },
        onShellEvent() {
          return () => undefined;
        },
      },
      addTransportStateListener: () => () => undefined,
    });

    await vi.waitFor(() =>
      expect(publisher.getSnapshot().threads[THREAD_ID]?.openTools).toHaveProperty(
        `${TURN_ID}:provider:tool-1`,
      ),
    );
    expect(replayEvents).toHaveBeenCalledWith(0);
    cleanup();
    publisher.dispose();
  });

  it("rebuilds a reconnect epoch without blanking or duplicating live overlap", async () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const reconnectSnapshot = deferred<OrchestrationShellSnapshot>();
    const durableEvents = [toolEvent(1)];
    let snapshotCalls = 0;
    let domainListener: ((event: OrchestrationEvent) => void) | null = null;
    let shellListener: ((item: OrchestrationShellStreamItem) => void) | null = null;
    let transportListener: ((state: "closed" | "open") => void) | null = null;
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) =>
      durableEvents.filter((event) => event.sequence > fromSequenceExclusive),
    );
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot() {
          snapshotCalls += 1;
          return snapshotCalls === 1
            ? Promise.resolve(shellSnapshot(1))
            : reconnectSnapshot.promise;
        },
        replayEvents,
        onDomainEvent(callback) {
          domainListener = callback;
          return () => undefined;
        },
        onShellEvent(callback) {
          shellListener = callback;
          return () => undefined;
        },
      },
      addTransportStateListener(callback) {
        transportListener = callback as (state: "closed" | "open") => void;
        return () => undefined;
      },
    });

    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(1));
    transportListener!("closed");
    expect(publisher.getSnapshot().events.map((event) => event.sequence)).toEqual([1]);
    transportListener!("open");
    const update = { ...toolEvent(2), eventId: EventId.makeUnsafe("reconnect-update") };
    durableEvents.push(update);
    domainListener!(update);
    reconnectSnapshot.resolve(shellSnapshot(1));

    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(2));
    expect(publisher.getSnapshot().events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(
      publisher.getSnapshot().threads[THREAD_ID]?.openTools[`${TURN_ID}:provider:tool-1`]?.count,
    ).toBe(1);
    const generation = publisher.getSnapshot().generation;
    shellListener!({ kind: "snapshot", snapshot: shellSnapshot(1) });
    await Promise.resolve();
    expect(publisher.getSnapshot().generation).toBe(generation);
    cleanup();
    publisher.dispose();
  });

  it("validates a live jump with persisted replay and accepts a legitimate sparse sequence", async () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const sparse = { ...toolEvent(3), eventId: EventId.makeUnsafe("sparse-3") };
    const durableEvents = [toolEvent(1)];
    let domainListener: ((event: OrchestrationEvent) => void) | null = null;
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) =>
      durableEvents.filter((event) => event.sequence > fromSequenceExclusive),
    );
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot: async () => shellSnapshot(1),
        replayEvents,
        onDomainEvent(callback) {
          domainListener = callback;
          return () => undefined;
        },
        onShellEvent() {
          return () => undefined;
        },
      },
      addTransportStateListener: () => () => undefined,
    });

    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(1));
    durableEvents.push(sparse);
    domainListener!(sparse);

    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(3));
    expect(publisher.getSnapshot().generation).toBe(1);
    expect(publisher.getSnapshot().events.map((event) => event.sequence)).toEqual([1, 3]);
    expect(replayEvents).toHaveBeenCalledWith(1);
    cleanup();
    publisher.dispose();
  });

  it("ignores stale bootstrap completion after a newer transport epoch recovers", async () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const firstSnapshot = deferred<OrchestrationShellSnapshot>();
    const secondSnapshot = deferred<OrchestrationShellSnapshot>();
    let snapshotCalls = 0;
    let transportListener: ((state: "closed" | "open") => void) | null = null;
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) =>
      fromSequenceExclusive === 0 ? [toolEvent(1)] : [],
    );
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot() {
          snapshotCalls += 1;
          return snapshotCalls === 1 ? firstSnapshot.promise : secondSnapshot.promise;
        },
        replayEvents,
        onDomainEvent() {
          return () => undefined;
        },
        onShellEvent() {
          return () => undefined;
        },
      },
      addTransportStateListener(callback) {
        transportListener = callback as (state: "closed" | "open") => void;
        return () => undefined;
      },
    });

    expect(snapshotCalls).toBe(1);
    transportListener!("closed");
    transportListener!("open");
    expect(snapshotCalls).toBe(2);

    secondSnapshot.resolve(shellSnapshot(1));
    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(1));
    const recoveredGeneration = publisher.getSnapshot().generation;

    firstSnapshot.resolve(shellSnapshot(9));
    await Promise.resolve();
    await Promise.resolve();

    expect(publisher.getCurrentSequence()).toBe(1);
    expect(publisher.getSnapshot().generation).toBe(recoveredGeneration);
    expect(publisher.getSnapshot().events.map((event) => event.sequence)).toEqual([1]);
    expect(replayEvents).toHaveBeenCalledTimes(1);
    cleanup();
    publisher.dispose();
  });

  it("retries a rejected catch-up with backoff and cancels a later retry on cleanup", async () => {
    vi.useFakeTimers();
    const publisher = createWorkspaceAgentEventPublisher();
    const durableEvents = [toolEvent(1)];
    let catchupAttempts = 0;
    let domainListener: ((event: OrchestrationEvent) => void) | null = null;
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) => {
      if (fromSequenceExclusive === 0) return [durableEvents[0]!];
      catchupAttempts += 1;
      if (catchupAttempts === 1 || catchupAttempts === 3) {
        throw new Error("transient replay failure");
      }
      return durableEvents.filter((event) => event.sequence > fromSequenceExclusive);
    });
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot: async () => shellSnapshot(1),
        replayEvents,
        onDomainEvent(callback) {
          domainListener = callback;
          return () => undefined;
        },
        onShellEvent() {
          return () => undefined;
        },
      },
      addTransportStateListener: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.getCurrentSequence()).toBe(1);

    const sparse = { ...toolEvent(3), eventId: EventId.makeUnsafe("retry-sparse-3") };
    durableEvents.push(sparse);
    domainListener!(sparse);
    await vi.advanceTimersByTimeAsync(0);

    expect(publisher.getCurrentSequence()).toBe(1);
    expect(replayEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(replayEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(publisher.getCurrentSequence()).toBe(3);
    expect(replayEvents).toHaveBeenCalledTimes(3);

    const later = { ...toolEvent(5), eventId: EventId.makeUnsafe("retry-sparse-5") };
    durableEvents.push(later);
    domainListener!(later);
    await vi.advanceTimersByTimeAsync(0);
    expect(replayEvents).toHaveBeenCalledTimes(4);

    cleanup();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replayEvents).toHaveBeenCalledTimes(4);
    publisher.dispose();
  });

  it("pages bounded bootstrap replay until it reaches the shell watermark", async () => {
    const publisher = createWorkspaceAgentEventPublisher();
    const first = { ...toolEvent(1_100), eventId: EventId.makeUnsafe("page-1") };
    const second = { ...assistantEvent(1_200, "page-2"), eventId: EventId.makeUnsafe("page-2") };
    const replayEvents = vi.fn(async (fromSequenceExclusive: number) => {
      if (fromSequenceExclusive === 1_000) return [first];
      if (fromSequenceExclusive === 1_100) return [second];
      return [];
    });
    const cleanup = connectWorkspaceAgentEventPublisher(publisher, {
      orchestration: {
        getShellSnapshot: async () => shellSnapshot(1_200),
        replayEvents,
        onDomainEvent() {
          return () => undefined;
        },
        onShellEvent() {
          return () => undefined;
        },
      },
      addTransportStateListener: () => () => undefined,
    });

    await vi.waitFor(() => expect(publisher.getCurrentSequence()).toBe(1_200));
    expect(replayEvents.mock.calls.map(([cursor]) => cursor)).toEqual([1_000, 1_100]);
    expect(publisher.getSnapshot().events.map((event) => event.sequence)).toEqual([1_100, 1_200]);
    cleanup();
    publisher.dispose();
  });
});

describe("workspace agent shell selection", () => {
  it("keeps its snapshot reference across updatedAt and token-only summary churn", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const summary = {
      id: THREAD_ID,
      projectId,
      title: "Agent thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.6-sol",
        options: { reasoningEffort: "high" },
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: TURN_ID,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        orchestrationStatus: "running",
      },
      createdAt: BASE_TIME,
      archivedAt: null,
      updatedAt: BASE_TIME,
      latestTurn: {
        turnId: TURN_ID,
        state: "running",
        requestedAt: BASE_TIME,
        startedAt: BASE_TIME,
        completedAt: null,
        assistantMessageId: null,
      },
      latestUserMessageAt: BASE_TIME,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      hasLiveTailWork: true,
    } satisfies SidebarThreadSummary;
    const project = {
      id: projectId,
      kind: "project",
      name: "Synara",
      remoteName: "Synara",
      folderName: "synara",
      localName: null,
      cwd: "C:\\src\\synara",
      defaultModelSelection: null,
      expanded: true,
      scripts: [],
    } satisfies Project;
    const selector = createWorkspaceAgentShellSelector();
    const state = {
      projects: [project],
      threadsHydrated: true,
      threadIds: [THREAD_ID],
      sidebarThreadSummaryById: { [THREAD_ID]: summary },
    } as AppState;
    const first = selector(state);
    const churnedSummary = {
      ...summary,
      updatedAt: "2026-07-20T12:00:09.000Z",
      latestUserMessageAt: "2026-07-20T12:00:08.000Z",
      usageTokens: 42_000,
    } as SidebarThreadSummary;
    const second = selector({
      ...state,
      sidebarThreadSummaryById: { [THREAD_ID]: churnedSummary },
    });

    expect(second).toBe(first);

    const presentationOnlyChange = selector({
      ...state,
      sidebarThreadSummaryById: {
        [THREAD_ID]: { ...churnedSummary, runtimeMode: "approval-required" },
      },
    });
    expect(presentationOnlyChange).toBe(second);

    const liveTailChanged = selector({
      ...state,
      sidebarThreadSummaryById: {
        [THREAD_ID]: { ...churnedSummary, hasLiveTailWork: false },
      },
    });
    expect(liveTailChanged).not.toBe(second);
    expect(liveTailChanged.threads[0]?.hasLiveTailWork).toBe(false);
  });

  it("selects only the target, its parent, and its direct children", () => {
    const projectId = ProjectId.makeUnsafe("project-thread-scope");
    const parentId = ThreadId.makeUnsafe("thread-parent");
    const targetId = ThreadId.makeUnsafe("thread-target");
    const childId = ThreadId.makeUnsafe("thread-child");
    const grandchildId = ThreadId.makeUnsafe("thread-grandchild");
    const unrelatedId = ThreadId.makeUnsafe("thread-unrelated");
    const base = {
      id: targetId,
      projectId,
      title: "Target",
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      session: null,
      createdAt: BASE_TIME,
      archivedAt: null,
      latestTurn: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      hasLiveTailWork: false,
    } satisfies SidebarThreadSummary;
    const summaries: SidebarThreadSummary[] = [
      { ...base, id: parentId, title: "Parent" },
      { ...base, parentThreadId: parentId },
      { ...base, id: childId, parentThreadId: targetId, title: "Child" },
      { ...base, id: grandchildId, parentThreadId: childId, title: "Grandchild" },
      { ...base, id: unrelatedId, title: "Unrelated" },
    ];
    const project = {
      id: projectId,
      kind: "project",
      name: "Synara",
      remoteName: "Synara",
      folderName: "synara",
      localName: null,
      cwd: "C:\\src\\synara",
      defaultModelSelection: null,
      expanded: true,
      scripts: [],
    } satisfies Project;
    const threadIds = summaries.map((summary) => summary.id);
    const summaryRecord = Object.fromEntries(
      summaries.map((summary) => [summary.id, summary]),
    ) as AppState["sidebarThreadSummaryById"];
    let summaryReadCount = 0;
    const sidebarThreadSummaryById = new Proxy(summaryRecord, {
      get(target, property, receiver) {
        if (typeof property === "string") summaryReadCount += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const state = {
      projects: [project],
      threadsHydrated: true,
      threadIds,
      sidebarThreadSummaryById,
    } as AppState;
    const selector = createWorkspaceAgentThreadShellSelector(targetId);
    const selected = selector(state);

    expect(selected.threads.map((thread) => thread.threadId)).toEqual([
      targetId,
      parentId,
      childId,
    ]);

    summaryReadCount = 0;
    expect(selector({ ...state, threadsHydrated: false })).toBe(selected);
    expect(summaryReadCount).toBe(0);

    const replacementSummaryById = new Proxy(
      { ...summaryRecord },
      {
        get(target, property, receiver) {
          if (typeof property === "string") summaryReadCount += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    selector({ ...state, sidebarThreadSummaryById: replacementSummaryById });
    expect(summaryReadCount).toBeGreaterThan(0);
  });
});

describe("workspace agent clock", () => {
  it("advances one shared snapshot every 500ms while subscribed and stops after cleanup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const clock = createWorkspaceAgentClock();
    const listener = vi.fn();
    const unsubscribe = clock.subscribe(listener);

    vi.advanceTimersByTime(500);
    expect(clock.getSnapshot()).toBe(Date.parse(BASE_TIME) + 500);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("isLiveAgentStatus", () => {
  it("returns true for visually live states while excluding queued and terminal states", () => {
    expect(isLiveAgentStatus("connecting")).toBe(true);
    expect(isLiveAgentStatus("thinking")).toBe(true);
    expect(isLiveAgentStatus("streaming")).toBe(true);
    expect(isLiveAgentStatus("tool-running")).toBe(true);
    expect(isLiveAgentStatus("queued")).toBe(false);
    expect(isLiveAgentStatus("idle")).toBe(false);
    expect(isLiveAgentStatus("completed")).toBe(false);
    expect(isLiveAgentStatus("failed")).toBe(false);
    expect(isLiveAgentStatus("stopped")).toBe(false);
  });
});
