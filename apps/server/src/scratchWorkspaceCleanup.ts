import { Effect, Layer, Semaphore, ServiceMap } from "effect";

import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { sweepStaleScratchWorkspaces } from "./scratchWorkspaces";

export const SCRATCH_WORKSPACE_CLEANUP_INTERVAL = "1 hour";

export interface ScratchWorkspaceCleanupShape {
  readonly runNow: Effect.Effect<void>;
}

export class ScratchWorkspaceCleanup extends ServiceMap.Service<
  ScratchWorkspaceCleanup,
  ScratchWorkspaceCleanupShape
>()("synara/ScratchWorkspaceCleanup") {}

export function makeScratchWorkspaceCleanupLive(
  options: {
    readonly rootDir?: string;
    readonly nowMs?: () => number;
    readonly maxIdleMs?: number;
  } = {},
) {
  return Layer.effect(
    ScratchWorkspaceCleanup,
    Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const cleanupLock = yield* Semaphore.make(1);
      const runNow = cleanupLock
        .withPermits(1)(
          Effect.gen(function* () {
            const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
            const result = yield* Effect.tryPromise({
              try: () =>
                sweepStaleScratchWorkspaces({
                  activeThreadIds: new Set(snapshot.threads.map((thread) => String(thread.id))),
                  ...(options.rootDir ? { rootDir: options.rootDir } : {}),
                  ...(options.nowMs ? { nowMs: options.nowMs() } : {}),
                  ...(options.maxIdleMs !== undefined ? { maxIdleMs: options.maxIdleMs } : {}),
                }),
              catch: (cause) => cause,
            });
            if (result.removed > 0 || result.preservedUnsafe > 0) {
              yield* Effect.logInfo("scratch workspace cleanup completed", result);
            }
          }),
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("scratch workspace cleanup failed", { cause: String(cause) }),
          ),
        );

      yield* runNow;
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(SCRATCH_WORKSPACE_CLEANUP_INTERVAL).pipe(Effect.andThen(runNow)),
        ),
      );
      return { runNow } satisfies ScratchWorkspaceCleanupShape;
    }),
  );
}

export const ScratchWorkspaceCleanupLive = makeScratchWorkspaceCleanupLive();
