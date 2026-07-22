// FILE: DroidSessionTeardownGate.ts
// Purpose: Prevents a replacement Droid ACP runtime from starting before its predecessor exits.
// Layer: Provider ACP lifecycle coordination

import type { ThreadId } from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Scope } from "effect";

import { ProviderAdapterProcessError } from "../Errors.ts";

export const closeAcpSessionAfterProcessTeardown = (input: {
  readonly provider: string;
  readonly providerLabel: string;
  readonly threadId: ThreadId;
  readonly processTeardown: Effect.Effect<unknown>;
  readonly scope: Scope.Closeable;
}): Effect.Effect<void, ProviderAdapterProcessError> => {
  let scopeCloseCompleted = false;
  let scopeCloseFailure: ProviderAdapterProcessError | undefined;

  return Effect.gen(function* () {
    if (scopeCloseFailure !== undefined) {
      return yield* scopeCloseFailure;
    }
    if (scopeCloseCompleted) {
      return;
    }

    const processTeardownExit = yield* Effect.exit(input.processTeardown);
    if (Exit.isFailure(processTeardownExit)) {
      return yield* new ProviderAdapterProcessError({
        provider: input.provider,
        threadId: input.threadId,
        detail: `Failed to prove the ${input.providerLabel} ACP process tree exited.`,
        cause: Cause.squash(processTeardownExit.cause),
      });
    }

    const scopeCloseExit = yield* Effect.exit(Scope.close(input.scope, Exit.void));
    if (Exit.isFailure(scopeCloseExit)) {
      scopeCloseFailure = new ProviderAdapterProcessError({
        provider: input.provider,
        threadId: input.threadId,
        detail: `Failed to close the ${input.providerLabel} ACP session scope.`,
        cause: Cause.squash(scopeCloseExit.cause),
      });
      return yield* scopeCloseFailure;
    }
    scopeCloseCompleted = true;
  });
};

export const stopExistingAcpSessionOwner = <Context, E>(
  sessions: ReadonlyMap<ThreadId, Context>,
  threadId: ThreadId,
  stop: (context: Context) => Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  Effect.suspend(() => {
    const existing = sessions.get(threadId);
    return existing === undefined ? Effect.void : stop(existing);
  });

export interface AcpStartupCleanupOwner {
  readonly captureProcessTeardown: (teardown: Effect.Effect<unknown>) => void;
  readonly cleanup: Effect.Effect<void, ProviderAdapterProcessError>;
}

export const makeAcpStartupCleanupOwner = (input: {
  readonly provider: string;
  readonly providerLabel: string;
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
}): AcpStartupCleanupOwner => {
  let processTeardown: Effect.Effect<unknown> | undefined;
  const cleanup = closeAcpSessionAfterProcessTeardown({
    ...input,
    processTeardown: Effect.suspend(() => processTeardown ?? Effect.void),
  });

  return {
    captureProcessTeardown: (teardown) => {
      processTeardown = teardown;
    },
    cleanup,
  };
};

export const retryRetainedAcpStartupOwner = (
  retainedOwners: Map<ThreadId, AcpStartupCleanupOwner>,
  threadId: ThreadId,
): Effect.Effect<void, ProviderAdapterProcessError> =>
  Effect.suspend(() => {
    const owner = retainedOwners.get(threadId);
    if (owner === undefined) return Effect.void;
    return owner.cleanup.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (retainedOwners.get(threadId) === owner) {
            retainedOwners.delete(threadId);
          }
        }),
      ),
    );
  });

export const failAcpStartupCauseAfterCleanup = <E>(input: {
  readonly provider: string;
  readonly providerLabel: string;
  readonly threadId: ThreadId;
  readonly startupCause: Cause.Cause<E>;
  readonly owner: AcpStartupCleanupOwner;
  readonly retainedOwners: Map<ThreadId, AcpStartupCleanupOwner>;
}): Effect.Effect<never, E | ProviderAdapterProcessError> =>
  Effect.uninterruptible(
    Effect.exit(input.owner.cleanup).pipe(
      Effect.flatMap((cleanupExit) => {
        if (Exit.isSuccess(cleanupExit)) {
          return Effect.failCause(input.startupCause);
        }
        const startupError = Cause.squash(input.startupCause);
        const cleanupError = Cause.squash(cleanupExit.cause);
        input.retainedOwners.set(input.threadId, input.owner);
        return Effect.fail(
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: input.threadId,
            detail: `${input.providerLabel} ACP startup failed and its process-tree cleanup remains unproven.`,
            cause: new AggregateError(
              [startupError, cleanupError],
              `${input.providerLabel} ACP startup and cleanup both failed.`,
            ),
          }),
        );
      }),
    ),
  );

export const failAcpStartupAfterCleanup = <E>(input: {
  readonly provider: string;
  readonly providerLabel: string;
  readonly threadId: ThreadId;
  readonly startupError: E;
  readonly owner: AcpStartupCleanupOwner;
  readonly retainedOwners: Map<ThreadId, AcpStartupCleanupOwner>;
}): Effect.Effect<never, E | ProviderAdapterProcessError> =>
  failAcpStartupCauseAfterCleanup({
    ...input,
    startupCause: Cause.fail(input.startupError),
  });

export interface AcpCleanupOwner {
  readonly threadId: ThreadId;
  readonly cleanup: Effect.Effect<void, ProviderAdapterProcessError>;
}

export const cleanupAllAcpOwners = (input: {
  readonly provider: string;
  readonly providerLabel: string;
  readonly owners: Iterable<AcpCleanupOwner>;
}): Effect.Effect<void, ProviderAdapterProcessError> => {
  const owners = Array.from(input.owners);
  return Effect.uninterruptible(
    Effect.forEach(owners, (owner) => Effect.exit(owner.cleanup), {
      concurrency: "unbounded",
    }).pipe(
      Effect.flatMap((exits) => {
        const failures = exits.flatMap((exit, index) =>
          Exit.isFailure(exit)
            ? [{ threadId: owners[index]!.threadId, cause: Cause.squash(exit.cause) }]
            : [],
        );
        if (failures.length === 0) return Effect.void;
        return Effect.fail(
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: failures.map((failure) => failure.threadId).join(","),
            detail: `Failed to prove cleanup for ${String(failures.length)} ${input.providerLabel} ACP owner(s).`,
            cause: new AggregateError(
              failures.map((failure) => failure.cause),
              `Failed to clean up every ${input.providerLabel} ACP owner.`,
            ),
          }),
        );
      }),
    ),
  );
};

interface PendingDroidSessionTeardown<E> {
  readonly completion: Deferred.Deferred<void>;
  readonly cleanup: Effect.Effect<void, E>;
  activeAttempt: Deferred.Deferred<void, E> | undefined;
}

export interface DroidSessionTeardownGate<E> {
  readonly track: (
    threadId: ThreadId,
    completion: Deferred.Deferred<void>,
    cleanup: Effect.Effect<void, E>,
  ) => void;
  readonly isPending: (threadId: ThreadId) => boolean;
  readonly awaitPending: (threadId: ThreadId) => Effect.Effect<void, E>;
  readonly run: (threadId: ThreadId, completion: Deferred.Deferred<void>) => Effect.Effect<void, E>;
}

export function makeAcpSessionTeardownGate<E>(): DroidSessionTeardownGate<E> {
  const pendingByThreadId = new Map<ThreadId, PendingDroidSessionTeardown<E>>();

  const runPending = (
    threadId: ThreadId,
    pending: PendingDroidSessionTeardown<E>,
  ): Effect.Effect<void, E> =>
    Effect.suspend(() => {
      if (pending.activeAttempt !== undefined) {
        return Deferred.await(pending.activeAttempt);
      }

      const attempt = Deferred.makeUnsafe<void, E>();
      pending.activeAttempt = attempt;
      return pending.cleanup.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              Deferred.doneUnsafe(pending.completion, Effect.void);
              if (pendingByThreadId.get(threadId) === pending) {
                pendingByThreadId.delete(threadId);
              }
              Deferred.doneUnsafe(attempt, Effect.void);
              return;
            }
            Deferred.doneUnsafe(attempt, Effect.failCause(exit.cause));
            if (pending.activeAttempt === attempt) {
              pending.activeAttempt = undefined;
            }
          }),
        ),
        Effect.forkDetach,
        Effect.andThen(Deferred.await(attempt)),
      );
    });

  return {
    track: (threadId, completion, cleanup) => {
      pendingByThreadId.set(threadId, {
        completion,
        cleanup,
        activeAttempt: undefined,
      });
    },
    isPending: (threadId) => pendingByThreadId.has(threadId),
    awaitPending: (threadId) =>
      Effect.suspend(() => {
        const pending = pendingByThreadId.get(threadId);
        return pending === undefined ? Effect.void : runPending(threadId, pending);
      }),
    run: (threadId, completion) =>
      Effect.suspend(() => {
        const pending = pendingByThreadId.get(threadId);
        return pending === undefined || pending.completion !== completion
          ? Deferred.await(completion)
          : runPending(threadId, pending);
      }),
  };
}

export const makeDroidSessionTeardownGate = makeAcpSessionTeardownGate;
