import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Cause, Duration, Effect, Fiber, Option, Queue, Semaphore, Stream } from "effect";

import type { SnapshotLiveStreamItem } from "../wsSnapshotLiveStream";
import { isProjectVisibilityEvent, toProjectVisibilityShellEvent } from "../wsShellVisibility";

export const SHELL_SYNC_COALESCE_WINDOW = Duration.millis(50);
export const SHELL_SYNC_MAX_BATCH_SIZE = 512;
export const SHELL_SYNC_PROJECTION_CONCURRENCY = 8;
export const SHELL_SYNC_RESUME_REPLAY_LIMIT = 1_000;

export type ShellProjectionReadResult<A, E> =
  | { readonly kind: "present"; readonly value: A }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly error: E };

export interface ShellProjectionReadFailure<E> {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: string;
  readonly error: E;
}

export interface ShellProjectionQueries<E> {
  readonly getProjectShellById: (
    projectId: OrchestrationProjectShell["id"],
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, E>;
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, E>;
  readonly onPersistentFailure?: (failure: ShellProjectionReadFailure<E>) => Effect.Effect<void>;
}

export function retryShellProjectionRead<A, E>(
  read: Effect.Effect<Option.Option<A>, E>,
): Effect.Effect<ShellProjectionReadResult<A, E>> {
  const fromProjection = (projection: Option.Option<A>): ShellProjectionReadResult<A, E> =>
    Option.match(projection, {
      onNone: () => ({ kind: "absent" }),
      onSome: (value) => ({ kind: "present", value }),
    });
  const secondAttempt = read.pipe(
    Effect.match({
      onFailure: (error): ShellProjectionReadResult<A, E> => ({ kind: "failed", error }),
      onSuccess: fromProjection,
    }),
  );
  return read.pipe(
    Effect.matchEffect({
      onFailure: () => secondAttempt,
      onSuccess: (projection) => Effect.succeed(fromProjection(projection)),
    }),
  );
}

function defaultPersistentFailureReporter<E>(
  failure: ShellProjectionReadFailure<E>,
): Effect.Effect<void> {
  return Effect.logWarning("Shell projection read failed after retry").pipe(
    Effect.annotateLogs({
      aggregateKind: failure.aggregateKind,
      aggregateId: failure.aggregateId,
      cause: Cause.pretty(Cause.fail(failure.error)),
    }),
  );
}

function projectReadResult<A, E>(input: {
  readonly result: ShellProjectionReadResult<A, E>;
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: string;
  readonly present: (value: A) => OrchestrationShellStreamEvent;
  readonly absent: () => OrchestrationShellStreamEvent;
  readonly onPersistentFailure?: ShellProjectionQueries<E>["onPersistentFailure"];
}): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, ShellProjectionReadFailure<E>> {
  switch (input.result.kind) {
    case "present":
      return Effect.succeed(Option.some(input.present(input.result.value)));
    case "absent":
      return Effect.succeed(Option.some(input.absent()));
    case "failed": {
      const failure = {
        aggregateKind: input.aggregateKind,
        aggregateId: input.aggregateId,
        error: input.result.error,
      } as const;
      return (input.onPersistentFailure ?? defaultPersistentFailureReporter)(failure).pipe(
        Effect.andThen(Effect.fail(failure)),
      );
    }
  }
}

export function projectShellEvent<E>(
  event: OrchestrationEvent,
  queries: ShellProjectionQueries<E>,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, ShellProjectionReadFailure<E>> {
  if (isProjectVisibilityEvent(event)) {
    return Effect.succeed(Option.some(toProjectVisibilityShellEvent(event)));
  }
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
      return retryShellProjectionRead(queries.getProjectShellById(event.payload.projectId)).pipe(
        Effect.flatMap((result) =>
          projectReadResult({
            result,
            aggregateKind: "project",
            aggregateId: event.payload.projectId,
            present: (project) => ({
              kind: "project-upserted",
              sequence: event.sequence,
              project,
            }),
            absent: () => ({
              kind: "project-removed",
              sequence: event.sequence,
              projectId: event.payload.projectId,
            }),
            ...(queries.onPersistentFailure === undefined
              ? {}
              : { onPersistentFailure: queries.onPersistentFailure }),
          }),
        ),
      );
    case "project.deleted":
      return Effect.succeed(
        Option.some({
          kind: "project-removed",
          sequence: event.sequence,
          projectId: event.payload.projectId,
        }),
      );
    case "thread.deleted":
      return Effect.succeed(
        Option.some({
          kind: "thread-removed",
          sequence: event.sequence,
          threadId: event.payload.threadId,
        }),
      );
    default: {
      if (event.aggregateKind !== "thread") return Effect.succeed(Option.none());
      const threadId = ThreadId.makeUnsafe(String(event.aggregateId));
      return retryShellProjectionRead(queries.getThreadShellById(threadId)).pipe(
        Effect.flatMap((result) =>
          projectReadResult({
            result,
            aggregateKind: "thread",
            aggregateId: threadId,
            present: (thread) => ({
              kind: "thread-upserted",
              sequence: event.sequence,
              thread,
            }),
            absent: () => ({
              kind: "thread-removed",
              sequence: event.sequence,
              threadId,
            }),
            ...(queries.onPersistentFailure === undefined
              ? {}
              : { onPersistentFailure: queries.onPersistentFailure }),
          }),
        ),
      );
    }
  }
}

export function coalesceShellEventBatch<E>(
  events: ReadonlyArray<OrchestrationEvent>,
  project: (
    event: OrchestrationEvent,
  ) => Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, E>,
): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, E> {
  const latestByAggregate = new Map<string, OrchestrationEvent>();
  for (const event of events) {
    const key = `${event.aggregateKind}:${event.aggregateId}`;
    const previous = latestByAggregate.get(key);
    if (previous === undefined || event.sequence > previous.sequence) {
      latestByAggregate.set(key, event);
    }
  }
  const latestEvents = Array.from(latestByAggregate.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );

  return Effect.forEach(latestEvents, project, {
    concurrency: SHELL_SYNC_PROJECTION_CONCURRENCY,
  }).pipe(
    Effect.map((projected) =>
      projected
        .flatMap((item) => (Option.isSome(item) ? [item.value] : []))
        .sort((left, right) => left.sequence - right.sequence),
    ),
  );
}

function groupShellSyncItems<E, R>(
  stream: Stream.Stream<SnapshotLiveStreamItem<OrchestrationShellSnapshot>, E, R>,
): Stream.Stream<ReadonlyArray<SnapshotLiveStreamItem<OrchestrationShellSnapshot>>, E, R> {
  return Stream.callback(
    (output) =>
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        let pending: SnapshotLiveStreamItem<OrchestrationShellSnapshot>[] = [];
        let timer: Fiber.Fiber<void> | null = null;
        let timerGeneration = 0;

        const flushLocked = (cancelTimer: boolean) =>
          Effect.gen(function* () {
            const activeTimer = timer;
            timer = null;
            timerGeneration += 1;
            if (cancelTimer && activeTimer !== null) {
              yield* Fiber.interrupt(activeTimer);
            }
            if (pending.length === 0) return;
            const batch = pending;
            pending = [];
            yield* Queue.offer(output, batch);
          });

        const scheduleFlushLocked = Effect.gen(function* () {
          const generation = ++timerGeneration;
          timer = yield* Effect.sleep(SHELL_SYNC_COALESCE_WINDOW).pipe(
            Effect.andThen(
              lock.withPermits(1)(
                Effect.gen(function* () {
                  if (generation !== timerGeneration) return;
                  timer = null;
                  timerGeneration += 1;
                  if (pending.length === 0) return;
                  const batch = pending;
                  pending = [];
                  yield* Queue.offer(output, batch);
                }),
              ),
            ),
            Effect.forkScoped,
          );
        });

        const sourceExit = yield* stream.pipe(
          Stream.runForEach((item) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                pending.push(item);
                if (pending.length === 1) yield* scheduleFlushLocked;
                if (pending.length >= SHELL_SYNC_MAX_BATCH_SIZE) {
                  yield* flushLocked(true);
                }
              }),
            ),
          ),
          Effect.exit,
        );

        yield* lock.withPermits(1)(flushLocked(true));
        if (sourceExit._tag === "Failure") {
          return yield* Effect.failCause(sourceExit.cause);
        }
        yield* Queue.end(output);
      }),
    { bufferSize: 1, strategy: "suspend" },
  );
}

export function coalesceShellStream<E, E2, E3>(
  stream: Stream.Stream<SnapshotLiveStreamItem<OrchestrationShellSnapshot>, E>,
  project: (
    event: OrchestrationEvent,
  ) => Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, E2>,
  ensureProjectionReady: (throughSequenceInclusive: number) => Effect.Effect<void, E3>,
): Stream.Stream<OrchestrationShellStreamItem, E | E2 | E3> {
  return groupShellSyncItems(stream).pipe(
    Stream.mapEffect((batch) =>
      Effect.gen(function* () {
        const output: OrchestrationShellStreamItem[] = [];
        let pendingEvents: OrchestrationEvent[] = [];
        const flush = Effect.gen(function* () {
          if (pendingEvents.length === 0) return;
          const throughSequenceInclusive = pendingEvents.reduce(
            (maximum, event) => Math.max(maximum, event.sequence),
            0,
          );
          yield* ensureProjectionReady(throughSequenceInclusive);
          const projected = yield* coalesceShellEventBatch(pendingEvents, project);
          output.push(...projected);
          pendingEvents = [];
        });

        for (const item of batch) {
          if (item.kind === "event") {
            pendingEvents.push(item.event);
            continue;
          }
          yield* flush;
          output.push({ kind: "snapshot", snapshot: item.snapshot });
        }
        yield* flush;
        return output;
      }),
    ),
    Stream.flatMap(Stream.fromIterable),
  );
}
