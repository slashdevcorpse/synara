import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Deferred, Duration, Effect, Exit, Fiber, Option, PubSub, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeCursorSafeSnapshotLiveStream,
  type SnapshotLiveStreamItem,
} from "../wsSnapshotLiveStream";
import {
  coalesceShellEventBatch,
  coalesceShellStream,
  projectShellEvent,
  retryShellProjectionRead,
  SHELL_SYNC_COALESCE_WINDOW,
  SHELL_SYNC_MAX_BATCH_SIZE,
  SHELL_SYNC_PROJECTION_CONCURRENCY,
} from "./shellSync";

const event = (
  sequence: number,
  aggregateKind: "project" | "thread",
  aggregateId: string,
): OrchestrationEvent =>
  ({
    sequence,
    aggregateKind,
    aggregateId,
    type: aggregateKind === "project" ? "project.meta-updated" : "thread.meta-updated",
    payload:
      aggregateKind === "project"
        ? { projectId: ProjectId.makeUnsafe(aggregateId), patch: {} }
        : { threadId: ThreadId.makeUnsafe(aggregateId), patch: {} },
  }) as OrchestrationEvent;

const removalFor = (source: OrchestrationEvent): Option.Option<OrchestrationShellStreamEvent> =>
  Option.some(
    source.aggregateKind === "project"
      ? {
          kind: "project-removed",
          sequence: source.sequence,
          projectId: ProjectId.makeUnsafe(String(source.aggregateId)),
        }
      : {
          kind: "thread-removed",
          sequence: source.sequence,
          threadId: ThreadId.makeUnsafe(String(source.aggregateId)),
        },
  );

const projectionReady = () => Effect.void;

const proposedPlanEvent = (
  sequence: number,
  threadId: ThreadId,
  planId: string,
): OrchestrationEvent =>
  ({
    sequence,
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.proposed-plan-upserted",
    payload: {
      threadId,
      proposedPlan: {
        id: planId,
        turnId: null,
        planMarkdown: "# Ready plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    },
  }) as OrchestrationEvent;

describe("shell synchronization", () => {
  it("retries a failed projection read once and distinguishes absence from failure", async () => {
    let recoveredAttempts = 0;
    const recovered = await Effect.runPromise(
      retryShellProjectionRead(
        Effect.suspend(() => {
          recoveredAttempts += 1;
          return recoveredAttempts === 1
            ? Effect.fail("temporary")
            : Effect.succeed(Option.none<string>());
        }),
      ),
    );
    expect(recovered).toEqual({ kind: "absent" });
    expect(recoveredAttempts).toBe(2);

    let failedAttempts = 0;
    const failed = await Effect.runPromise(
      retryShellProjectionRead(
        Effect.suspend(() => {
          failedAttempts += 1;
          return Effect.fail("persistent");
        }),
      ),
    );
    expect(failed.kind).toBe("failed");
    expect(failedAttempts).toBe(2);
  });

  it("emits a removal for confirmed absence and fails distinctly on persistent read failure", async () => {
    const source = event(7, "project", "project-1");
    let absentAttempts = 0;
    const absent = await Effect.runPromise(
      projectShellEvent(source, {
        getProjectShellById: () =>
          Effect.suspend(() => {
            absentAttempts += 1;
            return absentAttempts === 1 ? Effect.fail("temporary") : Effect.succeed(Option.none());
          }),
        getThreadShellById: () => Effect.die("unexpected thread read"),
      }),
    );
    expect(Option.getOrNull(absent)).toEqual({
      kind: "project-removed",
      sequence: 7,
      projectId: "project-1",
    });

    const absentThread = await Effect.runPromise(
      projectShellEvent(event(8, "thread", "thread-1"), {
        getProjectShellById: () => Effect.die("unexpected project read"),
        getThreadShellById: () => Effect.succeed(Option.none()),
      }),
    );
    expect(Option.getOrNull(absentThread)).toEqual({
      kind: "thread-removed",
      sequence: 8,
      threadId: "thread-1",
    });

    let reportedFailures = 0;
    const failure = await Effect.runPromise(
      projectShellEvent(source, {
        getProjectShellById: () => Effect.fail("persistent"),
        getThreadShellById: () => Effect.die("unexpected thread read"),
        onPersistentFailure: () =>
          Effect.sync(() => {
            reportedFailures += 1;
          }),
      }).pipe(Effect.flip),
    );
    expect(failure).toEqual({
      aggregateKind: "project",
      aggregateId: "project-1",
      error: "persistent",
    });
    expect(reportedFailures).toBe(1);
  });

  it("does not advance delivery past a persistent projection failure", async () => {
    const deliveredSequences: number[] = [];
    const failure = {
      aggregateKind: "thread" as const,
      aggregateId: "thread-1",
      error: "persistent",
    };
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const firstDelivered = yield* Deferred.make<void>();
        const source = Stream.callback<SnapshotLiveStreamItem<OrchestrationShellSnapshot>>(
          (queue) =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "event",
                event: event(1, "thread", "thread-0"),
              });
              yield* Deferred.await(firstDelivered);
              yield* Queue.offer(queue, {
                kind: "event",
                event: event(2, "thread", "thread-1"),
              });
              yield* Queue.offer(queue, {
                kind: "event",
                event: event(3, "thread", "thread-2"),
              });
            }),
        );

        return yield* coalesceShellStream(
          source,
          (sourceEvent) =>
            sourceEvent.sequence === 2
              ? Effect.fail(failure)
              : Effect.succeed(removalFor(sourceEvent)),
          projectionReady,
        ).pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind === "snapshot") return;
              deliveredSequences.push(item.sequence);
              if (item.sequence === 1) yield* Deferred.succeed(firstDelivered, undefined);
            }),
          ),
          Stream.runDrain,
          Effect.exit,
        );
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(deliveredSequences).toEqual([1]);
  });

  it("suppresses stale rows until the coalesced projection fence recovers", async () => {
    const threadId = ThreadId.makeUnsafe("thread-projection-fence");
    const freshThread: OrchestrationThreadShell = {
      id: threadId,
      projectId: ProjectId.makeUnsafe("project-projection-fence"),
      title: "Projection fence",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      envMode: "local",
      branch: null,
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      createBranchFlowCompleted: false,
      isPinned: false,
      parentThreadId: null,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
      forkSourceThreadId: null,
      sidechatSourceThreadId: null,
      lastKnownPr: null,
      latestTurn: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: true,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:09.000Z",
      archivedAt: null,
      handoff: null,
      session: null,
    };
    const staleThread: OrchestrationThreadShell = {
      ...freshThread,
      hasActionableProposedPlan: false,
      updatedAt: "2026-07-20T00:00:08.000Z",
    };
    const sourceEvents = [
      proposedPlanEvent(8, threadId, "plan-8"),
      proposedPlanEvent(9, threadId, "plan-9"),
    ];
    const source = () =>
      Stream.fromIterable(
        sourceEvents.map((sourceEvent) => ({ kind: "event" as const, event: sourceEvent })),
      );
    let appliedSequence = 8;
    let persistedThread = staleThread;
    let projectionReads = 0;
    const fenceReads: number[] = [];
    const ensureProjectionReady = (throughSequenceInclusive: number) =>
      Effect.suspend(() => {
        fenceReads.push(throughSequenceInclusive);
        return appliedSequence >= throughSequenceInclusive
          ? Effect.void
          : Effect.fail("projection-not-ready" as const);
      });
    const project = (sourceEvent: OrchestrationEvent) =>
      projectShellEvent(sourceEvent, {
        getProjectShellById: () => Effect.die("unexpected project projection read"),
        getThreadShellById: () =>
          Effect.sync(() => {
            projectionReads += 1;
            return Option.some(persistedThread);
          }),
      });
    const deliveredWhileStale: OrchestrationShellStreamEvent[] = [];

    const staleExit = await Effect.runPromise(
      coalesceShellStream(source(), project, ensureProjectionReady).pipe(
        Stream.tap((item) =>
          Effect.sync(() => {
            if (item.kind !== "snapshot") deliveredWhileStale.push(item);
          }),
        ),
        Stream.runDrain,
        Effect.exit,
      ),
    );

    expect(Exit.isFailure(staleExit)).toBe(true);
    expect(fenceReads).toEqual([9]);
    expect(projectionReads).toBe(0);
    expect(deliveredWhileStale).toEqual([]);

    appliedSequence = 9;
    persistedThread = freshThread;
    const replayed = await Effect.runPromise(
      coalesceShellStream(source(), project, ensureProjectionReady).pipe(Stream.runCollect),
    );

    expect(fenceReads).toEqual([9, 9]);
    expect(projectionReads).toBe(1);
    expect(Array.from(replayed)).toEqual([
      { kind: "thread-upserted", sequence: 9, thread: freshThread },
    ]);
  });

  it("coalesces each aggregate to its latest event and emits in sequence order", async () => {
    const projectedSequences: number[] = [];
    const items = await Effect.runPromise(
      coalesceShellEventBatch(
        [
          event(1, "thread", "thread-1"),
          event(2, "project", "project-1"),
          event(3, "thread", "thread-1"),
        ],
        (source) =>
          Effect.sync(() => {
            projectedSequences.push(source.sequence);
            return removalFor(source);
          }),
      ),
    );

    expect(projectedSequences).toEqual([2, 3]);
    expect(items.map((item) => item.sequence)).toEqual([2, 3]);
  });

  it("coalesces same-aggregate events arriving within the 50ms window", async () => {
    const first = event(1, "thread", "thread-1");
    const second = event(2, "thread", "thread-1");
    let sourceFinalizations = 0;
    const source = Stream.callback<SnapshotLiveStreamItem<OrchestrationShellSnapshot>>((queue) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sourceFinalizations += 1;
          }),
        );
        yield* Queue.offer(queue, { kind: "event", event: first });
        yield* Effect.sleep(Duration.millis(10));
        yield* Queue.offer(queue, { kind: "event", event: second });
        yield* Effect.never;
      }),
    );
    let projectionReads = 0;

    const items = await Effect.runPromise(
      coalesceShellStream(
        source,
        (sourceEvent) =>
          Effect.sync(() => {
            projectionReads += 1;
            return removalFor(sourceEvent);
          }),
        projectionReady,
      ).pipe(Stream.take(1), Stream.runCollect),
    );

    expect(projectionReads).toBe(1);
    expect(Array.from(items)).toEqual([
      { kind: "thread-removed", sequence: 2, threadId: "thread-1" },
    ]);
    expect(sourceFinalizations).toBe(1);
  });

  it("coalesces a live burst published during snapshot synchronization", async () => {
    const second = event(2, "thread", "thread-1");
    const third = event(3, "thread", "thread-1");
    const snapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 1,
      projects: [],
      threads: [],
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    let projectionReads = 0;

    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const synchronized = makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.gen(function* () {
              yield* PubSub.publish(live, second);
              yield* PubSub.publish(live, third);
              return snapshot;
            }),
            snapshotSequence: (item) => item.snapshotSequence,
            getHighWaterSequence: Effect.succeed(3),
            replay: () => Stream.fromIterable([second, third]),
          });

          return yield* coalesceShellStream(
            synchronized,
            (sourceEvent) =>
              Effect.sync(() => {
                projectionReads += 1;
                return removalFor(sourceEvent);
              }),
            projectionReady,
          ).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(projectionReads).toBe(1);
    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot },
      { kind: "thread-removed", sequence: 3, threadId: "thread-1" },
    ]);
  });

  it("bounds parallel projection reads at eight while preserving output order", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const releaseReads = yield* Deferred.make<void>();
        const firstWaveStarted = yield* Deferred.make<void>();
        let activeReads = 0;
        let maximumActiveReads = 0;
        let startedReads = 0;
        const events = Array.from({ length: 24 }, (_, index) =>
          event(index + 1, "thread", `thread-${index + 1}`),
        );

        const fiber = yield* coalesceShellEventBatch(events, (source) =>
          Effect.gen(function* () {
            activeReads += 1;
            startedReads += 1;
            maximumActiveReads = Math.max(maximumActiveReads, activeReads);
            if (startedReads === SHELL_SYNC_PROJECTION_CONCURRENCY) {
              yield* Deferred.succeed(firstWaveStarted, undefined);
            }
            yield* Deferred.await(releaseReads);
            activeReads -= 1;
            return removalFor(source);
          }),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(firstWaveStarted);
        expect(activeReads).toBe(SHELL_SYNC_PROJECTION_CONCURRENCY);
        expect(maximumActiveReads).toBe(SHELL_SYNC_PROJECTION_CONCURRENCY);
        yield* Deferred.succeed(releaseReads, undefined);

        const projected = yield* Fiber.join(fiber);
        expect(projected.map((item) => item.sequence)).toEqual(events.map((item) => item.sequence));
        expect(maximumActiveReads).toBe(SHELL_SYNC_PROJECTION_CONCURRENCY);
      }),
    );
  });

  it("flushes a burst at 512 events and coalesces each completed batch", async () => {
    const sourceEvents = Array.from({ length: 1_025 }, (_, index) =>
      event(index + 1, "thread", "thread-1"),
    );
    const source: Stream.Stream<SnapshotLiveStreamItem<OrchestrationShellSnapshot>> =
      Stream.fromIterable(
        sourceEvents.map((sourceEvent) => ({ kind: "event" as const, event: sourceEvent })),
      );
    let projectionReads = 0;

    const items = await Effect.runPromise(
      coalesceShellStream(
        source,
        (sourceEvent) =>
          Effect.sync(() => {
            projectionReads += 1;
            return removalFor(sourceEvent);
          }),
        projectionReady,
      ).pipe(Stream.runCollect),
    );

    expect(SHELL_SYNC_MAX_BATCH_SIZE).toBe(512);
    expect(Duration.toMillis(SHELL_SYNC_COALESCE_WINDOW)).toBe(50);
    expect(projectionReads).toBe(3);
    expect(
      Array.from(items).map((item) => (item.kind === "snapshot" ? -1 : item.sequence)),
    ).toEqual([512, 1_024, 1_025]);
  });
});
