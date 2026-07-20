import { WsRpcError, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Queue, Scope, Stream } from "effect";

export const ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT = 4_096;

export type SnapshotLiveStreamItem<Snapshot> =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "event"; readonly event: OrchestrationEvent };

export function canReplayIncrementally(
  afterSequence: number,
  highWaterSequence: number,
  replayLimit: number,
): boolean {
  return (
    Number.isSafeInteger(afterSequence) &&
    afterSequence >= 0 &&
    afterSequence <= highWaterSequence &&
    highWaterSequence - afterSequence <= replayLimit
  );
}

export function isCompleteReplayRange(
  events: ReadonlyArray<OrchestrationEvent>,
  afterSequence: number,
  highWaterSequence: number,
): boolean {
  if (events.length !== highWaterSequence - afterSequence) return false;
  return events.every((event, index) => event.sequence === afterSequence + index + 1);
}

/**
 * Attach live delivery first, capture a snapshot and durable high-water fence,
 * replay the exact gap, then continue with strictly newer live events. A valid
 * bounded cursor skips the snapshot; invalid or incomplete history falls back
 * to the snapshot path.
 */
export function makeCursorSafeSnapshotLiveStream<Snapshot, E>(input: {
  readonly subscribeLive: Effect.Effect<Stream.Stream<OrchestrationEvent, E>, never, Scope.Scope>;
  readonly snapshot: Effect.Effect<Snapshot, E>;
  readonly snapshotSequence: (snapshot: Snapshot) => number;
  readonly getHighWaterSequence: Effect.Effect<number, E>;
  readonly afterSequence?: number;
  readonly resumeReplayLimit?: number;
  /** Applied only after durable replay continuity has been validated. */
  readonly includeEvent?: (event: OrchestrationEvent) => boolean;
  /** Must return every durable event in the requested raw sequence range. */
  readonly replay: (
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
  ) => Stream.Stream<OrchestrationEvent, E>;
}): Stream.Stream<SnapshotLiveStreamItem<Snapshot>, E | WsRpcError> {
  const stream = Stream.unwrap(
    Effect.gen(function* () {
      // The scoped subscription is registered synchronously before snapshot IO.
      // A one-item handoff queue keeps the bridge bounded; the caller's live
      // stream owns its slow-consumer/drop policy ahead of this queue.
      const live = yield* input.subscribeLive;
      const liveQueue = yield* Queue.bounded<OrchestrationEvent, E | Cause.Done>(1);
      yield* Stream.runIntoQueue(live, liveQueue).pipe(Effect.forkScoped);

      const liveAfterFence = (highWaterSequence: number) =>
        Stream.fromQueue(liveQueue).pipe(
          Stream.filter((event) => event.sequence > highWaterSequence),
          Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
        );
      const collectReplayRange = (afterSequence: number, highWaterSequence: number) =>
        input.replay(afterSequence, highWaterSequence).pipe(
          Stream.filter(
            (event) => event.sequence > afterSequence && event.sequence <= highWaterSequence,
          ),
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationEvent> => Array.from(events)),
        );

      const afterSequence = input.afterSequence;
      if (afterSequence !== undefined && input.resumeReplayLimit !== undefined) {
        const highWaterSequence = yield* input.getHighWaterSequence;
        if (canReplayIncrementally(afterSequence, highWaterSequence, input.resumeReplayLimit)) {
          const replayedEvents = yield* collectReplayRange(afterSequence, highWaterSequence);
          if (isCompleteReplayRange(replayedEvents, afterSequence, highWaterSequence)) {
            return Stream.concat(
              Stream.fromIterable(replayedEvents).pipe(
                Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
              ),
              liveAfterFence(highWaterSequence),
            );
          }
        }
      }

      const snapshot = yield* input.snapshot;
      const snapshotSequence = input.snapshotSequence(snapshot);
      const highWaterSequence = yield* input.getHighWaterSequence;
      const replayCount = Math.max(0, highWaterSequence - snapshotSequence);
      if (replayCount > ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT) {
        return yield* new WsRpcError({
          message: `Orchestration snapshot is ${replayCount} events behind; restart the stream for a fresh snapshot.`,
          code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
          retryable: true,
        });
      }

      const replayedEvents = yield* collectReplayRange(snapshotSequence, highWaterSequence);
      if (!isCompleteReplayRange(replayedEvents, snapshotSequence, highWaterSequence)) {
        return yield* new WsRpcError({
          message:
            "Orchestration snapshot attachment replay is incomplete; restart the stream for a fresh snapshot.",
          code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
          retryable: true,
        });
      }
      const replay = Stream.fromIterable(replayedEvents).pipe(
        Stream.map((event): SnapshotLiveStreamItem<Snapshot> => ({ kind: "event", event })),
      );

      return Stream.concat(
        Stream.succeed<SnapshotLiveStreamItem<Snapshot>>({ kind: "snapshot", snapshot }),
        Stream.concat(replay, liveAfterFence(highWaterSequence)),
      );
    }),
  );
  const includeEvent = input.includeEvent;
  return includeEvent === undefined
    ? stream
    : stream.pipe(Stream.filter((item) => item.kind === "snapshot" || includeEvent(item.event)));
}
