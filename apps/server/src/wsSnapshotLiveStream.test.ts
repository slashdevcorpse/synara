import type { OrchestrationEvent } from "@synara/contracts";
import { Effect, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  canReplayIncrementally,
  isCompleteReplayRange,
  makeCursorSafeSnapshotLiveStream,
  ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
} from "./wsSnapshotLiveStream";

const event = (sequence: number) => ({ sequence }) as OrchestrationEvent;

describe("makeCursorSafeSnapshotLiveStream", () => {
  it("attaches before snapshot IO and deduplicates events covered by durable replay", async () => {
    const steps: string[] = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("attached"))),
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("snapshot"))),
              Effect.as({ snapshotSequence: 1 }),
            ),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () => Stream.succeed(replayed),
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(steps).toEqual(["attached", "snapshot"]);
    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
    ]);
  });

  it("emits the snapshot first, the fenced replay next, and newer live events last", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          const newerLive = event(3);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(Effect.as({ snapshotSequence: 1 })),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () =>
              Stream.concat(
                Stream.fromEffect(PubSub.publish(live, newerLive)).pipe(Stream.drain),
                Stream.succeed(replayed),
              ),
          }).pipe(Stream.take(3), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
      { kind: "event", event: event(3) },
    ]);
  });

  it("requires a fresh snapshot instead of replaying an unbounded attach gap", async () => {
    let replayStarted = false;
    const program = Effect.scoped(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.empty),
        snapshot: Effect.succeed({ snapshotSequence: 1 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
        replay: () => {
          replayStarted = true;
          return Stream.empty;
        },
      }).pipe(Stream.runDrain),
    );

    await expect(Effect.runPromise(program)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    expect(replayStarted).toBe(false);
  });

  it("requires a fresh snapshot when its bounded attachment replay is incomplete", async () => {
    const program = Effect.scoped(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.empty),
        snapshot: Effect.succeed({ snapshotSequence: 1 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(3),
        replay: () => Stream.succeed(event(3)),
      }).pipe(Stream.runDrain),
    );

    await expect(Effect.runPromise(program)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
  });

  it("validates mixed-aggregate replay before filtering events for a consumer", async () => {
    const unrelatedEvent = {
      sequence: 2,
      aggregateKind: "project",
      aggregateId: "project-1",
    } as OrchestrationEvent;
    const relevantEvent = {
      sequence: 3,
      aggregateKind: "thread",
      aggregateId: "thread-1",
    } as OrchestrationEvent;
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.succeed({ snapshotSequence: 1 }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(3),
          includeEvent: (item) =>
            item.aggregateKind === "thread" && item.aggregateId === "thread-1",
          replay: () => Stream.fromIterable([unrelatedEvent, relevantEvent]),
        }).pipe(Stream.runCollect),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: relevantEvent },
    ]);
  });

  it("resumes from a complete bounded cursor range without loading a snapshot", async () => {
    let snapshotLoaded = false;
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.sync(() => {
            snapshotLoaded = true;
            return { snapshotSequence: 2 };
          }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(2),
          afterSequence: 1,
          resumeReplayLimit: 1_000,
          replay: () => Stream.succeed(event(2)),
        }).pipe(Stream.runCollect),
      ),
    );

    expect(snapshotLoaded).toBe(false);
    expect(Array.from(items)).toEqual([{ kind: "event", event: event(2) }]);
  });

  it("attaches live delivery before cursor replay and emits the replay fence first", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          const newerLive = event(3);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: Effect.die("incremental replay should not load a snapshot"),
            snapshotSequence: (snapshot: { snapshotSequence: number }) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            afterSequence: 1,
            resumeReplayLimit: 1_000,
            replay: () =>
              Stream.concat(
                Stream.fromEffect(PubSub.publish(live, newerLive)).pipe(Stream.drain),
                Stream.succeed(replayed),
              ),
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "event", event: event(2) },
      { kind: "event", event: event(3) },
    ]);
  });

  it("falls back to a full snapshot when durable cursor history has a gap", async () => {
    let snapshotLoads = 0;
    const items = await Effect.runPromise(
      Effect.scoped(
        makeCursorSafeSnapshotLiveStream({
          subscribeLive: Effect.succeed(Stream.empty),
          snapshot: Effect.sync(() => {
            snapshotLoads += 1;
            return { snapshotSequence: 3 };
          }),
          snapshotSequence: (snapshot) => snapshot.snapshotSequence,
          getHighWaterSequence: Effect.succeed(3),
          afterSequence: 1,
          resumeReplayLimit: 1_000,
          replay: (afterSequence) =>
            afterSequence === 1 ? Stream.succeed(event(3)) : Stream.empty,
        }).pipe(Stream.runCollect),
      ),
    );

    expect(snapshotLoads).toBe(1);
    expect(Array.from(items)).toEqual([{ kind: "snapshot", snapshot: { snapshotSequence: 3 } }]);
  });

  it("accepts only non-negative, in-range cursor gaps within the replay limit", () => {
    expect(canReplayIncrementally(0, 1_000, 1_000)).toBe(true);
    expect(canReplayIncrementally(0, 1_001, 1_000)).toBe(false);
    expect(canReplayIncrementally(-1, 10, 1_000)).toBe(false);
    expect(canReplayIncrementally(11, 10, 1_000)).toBe(false);
    expect(canReplayIncrementally(10, 10, 1_000)).toBe(true);

    expect(isCompleteReplayRange([event(2), event(3)], 1, 3)).toBe(true);
    expect(isCompleteReplayRange([event(3)], 1, 3)).toBe(false);
    expect(isCompleteReplayRange([event(3), event(2)], 1, 3)).toBe(false);
  });

  it.each([
    { label: "negative", afterSequence: -1, highWaterSequence: 10 },
    { label: "ahead", afterSequence: 11, highWaterSequence: 10 },
    { label: "too old", afterSequence: 0, highWaterSequence: 1_001 },
  ])(
    "falls back to a snapshot for a $label cursor",
    async ({ afterSequence, highWaterSequence }) => {
      const items = await Effect.runPromise(
        Effect.scoped(
          makeCursorSafeSnapshotLiveStream({
            subscribeLive: Effect.succeed(Stream.empty),
            snapshot: Effect.succeed({ snapshotSequence: highWaterSequence }),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(highWaterSequence),
            afterSequence,
            resumeReplayLimit: 1_000,
            replay: () => Stream.empty,
          }).pipe(Stream.runCollect),
        ),
      );

      expect(Array.from(items)).toEqual([
        { kind: "snapshot", snapshot: { snapshotSequence: highWaterSequence } },
      ]);
    },
  );
});
