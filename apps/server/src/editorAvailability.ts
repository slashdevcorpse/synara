// FILE: editorAvailability.ts
// Purpose: Own a bounded, non-blocking snapshot of installed editor integrations.
// Layer: Server runtime utility
// Exports: scoped single-flight editor discovery with stale-while-refresh semantics.

import type { EditorId } from "@synara/contracts";
import {
  Deferred,
  Effect,
  Exit,
  PubSub,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import {
  discoverAvailableEditors,
  resolveEditorDiscoveryIdentity,
  type EditorDiscoveryFailureCategory,
  type EditorDiscoveryResult,
} from "./open";

export const EDITOR_AVAILABILITY_REFRESH_AFTER_MS = 5 * 60 * 1_000;
export const EDITOR_AVAILABILITY_RETRY_AFTER_MS = 2_000;

export interface EditorAvailabilitySnapshot {
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly status: "idle" | "refreshing" | "ready" | "failed";
  readonly revision: number;
  readonly confirmedAt: number | null;
  readonly failureCategory: EditorDiscoveryFailureCategory | null;
  readonly retryAt: number | null;
}

export interface EditorAvailability {
  /** Reads the current snapshot without scheduling work. */
  readonly getCurrent: Effect.Effect<EditorAvailabilitySnapshot>;
  /** Reads immediately and starts a due refresh in the service-owned scope. */
  readonly getSnapshotAndSchedule: Effect.Effect<EditorAvailabilitySnapshot>;
  /** Joins the current refresh or requests one, subject to the failure retry floor. */
  readonly refresh: Effect.Effect<EditorAvailabilitySnapshot>;
  /** Clears freshness and failure backoff while retaining the last confirmed snapshot. */
  readonly clearRefreshState: Effect.Effect<void>;
  /** Replays the latest confirmed revision, then emits each newer successful refresh once. */
  readonly streamChanges: Stream.Stream<EditorAvailabilitySnapshot>;
}

export interface EditorAvailabilityOptions {
  readonly discover?: (
    signal: AbortSignal,
    identity: string,
  ) => Promise<EditorDiscoveryResult>;
  readonly identity?: () => string;
  readonly now?: () => number;
  readonly refreshAfterMs?: number;
  readonly retryAfterMs?: number;
}

interface MutableEditorAvailabilityState {
  availableEditors: ReadonlyArray<EditorId>;
  status: EditorAvailabilitySnapshot["status"];
  revision: number;
  confirmedAt: number | null;
  confirmedIdentity: string | null;
  lastAttemptIdentity: string | null;
  failureCategory: EditorDiscoveryFailureCategory | null;
  retryAt: number | null;
}

interface InFlightRefresh {
  readonly identity: string;
  readonly discover: (signal: AbortSignal) => Promise<EditorDiscoveryResult>;
  readonly completed: Deferred.Deferred<EditorAvailabilitySnapshot>;
  readonly waiters: Deferred.Deferred<EditorAvailabilitySnapshot>[];
}

interface PendingRefresh {
  request: EditorDiscoveryRequest;
  readonly completed: Deferred.Deferred<EditorAvailabilitySnapshot>;
}

interface EditorDiscoveryRequest {
  readonly identity: string;
  readonly discover: (signal: AbortSignal) => Promise<EditorDiscoveryResult>;
}

interface SettledRefresh {
  readonly snapshot: EditorAvailabilitySnapshot;
  readonly publish: boolean;
  readonly complete: ReadonlyArray<Deferred.Deferred<EditorAvailabilitySnapshot>>;
}

function toSnapshot(state: MutableEditorAvailabilityState): EditorAvailabilitySnapshot {
  return {
    availableEditors: [...state.availableEditors],
    status: state.status,
    revision: state.revision,
    confirmedAt: state.confirmedAt,
    failureCategory: state.failureCategory,
    retryAt: state.retryAt,
  };
}

export const makeEditorAvailability = (
  options: EditorAvailabilityOptions = {},
): Effect.Effect<EditorAvailability, never, Scope.Scope> =>
  Effect.gen(function* () {
    const captureRequest = (): EditorDiscoveryRequest => {
      if (options.discover || options.identity) {
        const requestIdentity = options.identity?.() ?? resolveEditorDiscoveryIdentity();
        const discover =
          options.discover ??
          ((signal: AbortSignal) => discoverAvailableEditors({ signal }));
        return {
          identity: requestIdentity,
          discover: (signal) => discover(signal, requestIdentity),
        };
      }

      const platform = process.platform;
      const env = { ...process.env };
      const cwd = process.cwd();
      return {
        identity: resolveEditorDiscoveryIdentity({ platform, env, cwd }),
        discover: (signal) => discoverAvailableEditors({ platform, env, cwd, signal }),
      };
    };
    const now = options.now ?? Date.now;
    const refreshAfterMs = Math.max(
      0,
      options.refreshAfterMs ?? EDITOR_AVAILABILITY_REFRESH_AFTER_MS,
    );
    const retryAfterMs = Math.max(
      EDITOR_AVAILABILITY_RETRY_AFTER_MS,
      options.retryAfterMs ?? EDITOR_AVAILABILITY_RETRY_AFTER_MS,
    );
    const lock = yield* Semaphore.make(1);
    const changes = yield* PubSub.unbounded<EditorAvailabilitySnapshot>();
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() =>
      Scope.close(workerScope, Exit.void).pipe(Effect.andThen(PubSub.shutdown(changes))),
    );

    const state: MutableEditorAvailabilityState = {
      availableEditors: [],
      status: "idle",
      revision: 0,
      confirmedAt: null,
      confirmedIdentity: null,
      lastAttemptIdentity: null,
      failureCategory: null,
      retryAt: null,
    };
    let inFlight: InFlightRefresh | null = null;
    let pending: PendingRefresh | null = null;
    let requestCaptureRetryAt: number | null = null;

    const captureFailureSnapshot = (retryAt: number): EditorAvailabilitySnapshot => ({
      ...toSnapshot(state),
      status: "failed",
      failureCategory: "filesystem_transient",
      retryAt,
    });
    const setCaptureFailureState = (retryAt: number): EditorAvailabilitySnapshot => {
      requestCaptureRetryAt = retryAt;
      state.status = "failed";
      state.failureCategory = "filesystem_transient";
      state.retryAt = retryAt;
      return toSnapshot(state);
    };
    const recordCaptureFailure = (attemptedAt: number): EditorAvailabilitySnapshot =>
      setCaptureFailureState(attemptedAt + retryAfterMs);

    const getCurrent = lock.withPermits(1)(Effect.sync(() => toSnapshot(state)));

    let settle: (
      entry: InFlightRefresh,
      result: EditorDiscoveryResult,
    ) => Effect.Effect<void>;
    const startRefreshLocked = (
      request: EditorDiscoveryRequest,
      completed: Deferred.Deferred<EditorAvailabilitySnapshot>,
      waiters: Deferred.Deferred<EditorAvailabilitySnapshot>[] = [],
    ): Effect.Effect<InFlightRefresh> =>
      Effect.gen(function* () {
        const start = yield* Deferred.make<void>();
        const entry: InFlightRefresh = {
          identity: request.identity,
          discover: request.discover,
          completed,
          waiters,
        };
        inFlight = entry;
        state.status = "refreshing";
        yield* Effect.gen(function* () {
          yield* Deferred.await(start);
          const result = yield* Effect.tryPromise({
            try: (signal) => entry.discover(signal),
            catch: () => undefined,
          }).pipe(
            Effect.catch(() =>
              Effect.succeed<EditorDiscoveryResult>({
                status: "failure",
                category: "filesystem_transient",
                fileSystemOperations: 0,
                subprocessCount: 0,
              }),
            ),
          );
          yield* settle(entry, result);
        }).pipe(Effect.forkIn(workerScope));
        yield* Deferred.succeed(start, undefined).pipe(Effect.asVoid);
        return entry;
      });

    settle = (entry: InFlightRefresh, result: EditorDiscoveryResult): Effect.Effect<void> =>
      Effect.gen(function* () {
        const settled: SettledRefresh | null = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (inFlight !== entry) return null;
            const pendingRefresh = pending;
            const captureAttemptedAt = now();
            let currentRequest: EditorDiscoveryRequest;
            try {
              currentRequest = captureRequest();
              requestCaptureRetryAt = null;
            } catch {
              inFlight = null;
              pending = null;
              const snapshot = recordCaptureFailure(captureAttemptedAt);
              return {
                snapshot,
                publish: false,
                complete: [
                  entry.completed,
                  ...entry.waiters,
                  ...(pendingRefresh ? [pendingRefresh.completed] : []),
                ],
              } satisfies SettledRefresh;
            }
            inFlight = null;
            pending = null;
            if (pendingRefresh !== null || currentRequest.identity !== entry.identity) {
              const continuationRequest =
                pendingRefresh?.request.identity === currentRequest.identity
                  ? pendingRefresh.request
                  : currentRequest;
              const retryBlocked =
                state.lastAttemptIdentity === continuationRequest.identity &&
                state.retryAt !== null &&
                state.retryAt > now();
              if (retryBlocked) {
                state.status = "failed";
                const snapshot = toSnapshot(state);
                return {
                  snapshot,
                  publish: false,
                  complete: [
                    entry.completed,
                    ...entry.waiters,
                    ...(pendingRefresh ? [pendingRefresh.completed] : []),
                  ],
                } satisfies SettledRefresh;
              }

              const continuation =
                pendingRefresh?.completed ??
                (yield* Deferred.make<EditorAvailabilitySnapshot>());
              yield* startRefreshLocked(continuationRequest, continuation, [
                entry.completed,
                ...entry.waiters,
              ]);
              return null;
            }

            state.lastAttemptIdentity = entry.identity;
            if (result.status === "success") {
              const settledAt = now();
              state.availableEditors = [...result.availableEditors];
              state.status = "ready";
              state.revision += 1;
              state.confirmedAt = settledAt;
              state.confirmedIdentity = entry.identity;
              state.failureCategory = null;
              state.retryAt = null;
              return {
                snapshot: toSnapshot(state),
                publish: true,
                complete: [entry.completed, ...entry.waiters],
              } satisfies SettledRefresh;
            }

            state.status = "failed";
            state.failureCategory = result.category;
            state.retryAt = now() + retryAfterMs;
            return {
              snapshot: toSnapshot(state),
              publish: false,
              complete: [entry.completed, ...entry.waiters],
            } satisfies SettledRefresh;
          }),
        );
        if (settled === null) return;
        if (settled.publish) {
          yield* PubSub.publish(changes, settled.snapshot).pipe(Effect.asVoid);
        }
        yield* Effect.forEach(
          settled.complete,
          (waiter) => Deferred.succeed(waiter, settled.snapshot),
          { discard: true },
        );
      });

    const selectRefresh = (force: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const requestedAt = now();
          if (requestCaptureRetryAt !== null && requestCaptureRetryAt > requestedAt) {
            return {
              snapshot:
                inFlight === null
                  ? setCaptureFailureState(requestCaptureRetryAt)
                  : captureFailureSnapshot(requestCaptureRetryAt),
              completed: null,
            };
          }
          let request: EditorDiscoveryRequest;
          const recoveringCaptureFailure = requestCaptureRetryAt !== null;
          try {
            request = captureRequest();
            requestCaptureRetryAt = null;
          } catch {
            const retryAt = requestedAt + retryAfterMs;
            requestCaptureRetryAt = retryAt;
            return {
              snapshot:
                inFlight === null
                  ? setCaptureFailureState(retryAt)
                  : captureFailureSnapshot(retryAt),
              completed: null,
            };
          }
          const requestedIdentity = request.identity;
          if (inFlight !== null) {
            if (pending !== null) {
              pending.request = request;
              return {
                snapshot: toSnapshot(state),
                completed: pending.completed,
              };
            }
            if (inFlight.identity === requestedIdentity) {
              return {
                snapshot: toSnapshot(state),
                completed: inFlight.completed,
              };
            }
            const completed = yield* Deferred.make<EditorAvailabilitySnapshot>();
            pending = { request, completed };
            return {
              snapshot: toSnapshot(state),
              completed,
            };
          }

          const retryBlocked =
            state.lastAttemptIdentity === requestedIdentity &&
            state.retryAt !== null &&
            state.retryAt > requestedAt;
          const fresh =
            state.confirmedIdentity === requestedIdentity &&
            state.confirmedAt !== null &&
            state.confirmedAt + refreshAfterMs > requestedAt;
          if (retryBlocked || (!force && fresh && !recoveringCaptureFailure)) {
            return { snapshot: toSnapshot(state), completed: null };
          }

          const completed = yield* Deferred.make<EditorAvailabilitySnapshot>();
          yield* startRefreshLocked(request, completed);
          return { snapshot: toSnapshot(state), completed };
        }),
      );

    const getSnapshotAndSchedule = selectRefresh(false).pipe(
      Effect.map((selection) => selection.snapshot),
    );
    const refresh = Effect.gen(function* () {
      const selection = yield* selectRefresh(true);
      return selection.completed === null
        ? selection.snapshot
        : yield* Deferred.await(selection.completed);
    });
    const clearRefreshState = lock.withPermits(1)(
      Effect.sync(() => {
        state.confirmedAt = null;
        state.confirmedIdentity = null;
        state.lastAttemptIdentity = null;
        state.failureCategory = null;
        state.retryAt = null;
        requestCaptureRetryAt = null;
        state.status = inFlight !== null ? "refreshing" : state.revision > 0 ? "ready" : "idle";
      }),
    );

    const streamChanges = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* getCurrent;
        let lastRevision = 0;
        return Stream.concat(
          current.revision > 0 ? Stream.succeed(current) : Stream.empty,
          Stream.fromSubscription(subscription),
        ).pipe(
          Stream.filter((snapshot) => {
            if (snapshot.revision <= lastRevision) return false;
            lastRevision = snapshot.revision;
            return true;
          }),
        );
      }),
    );

    return {
      getCurrent,
      getSnapshotAndSchedule,
      refresh,
      clearRefreshState,
      streamChanges,
    };
  });
