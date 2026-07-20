import type { ProviderKind, ProviderSession, ThreadId } from "@synara/contracts";
import { Data, Effect } from "effect";

import type { ProviderServiceShape } from "./Services/ProviderService.ts";

export class ProviderUpdateBlockedError extends Data.TaggedError("ProviderUpdateBlockedError")<{
  readonly provider: ProviderKind;
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

function sessionHasActiveTurn(session: ProviderSession): boolean {
  return (
    session.status === "connecting" ||
    session.status === "running" ||
    session.activeTurnId !== undefined
  );
}

/**
 * Stops only idle runtimes owned by Synara. Persisted bindings and resume
 * cursors remain intact so the next provider operation can recover lazily.
 */
export const quiesceProviderRuntimesForUpdate = Effect.fn(
  "quiesceProviderRuntimesForUpdate",
)(function* (input: {
  readonly provider: ProviderKind;
  readonly providerService: ProviderServiceShape;
  readonly stopIdleSessions?: boolean;
}) {
  if (input.providerService.prepareForMaintenance) {
    return yield* input.providerService
      .prepareForMaintenance({
        provider: input.provider,
        stopIdleSessions: input.stopIdleSessions ?? true,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new ProviderUpdateBlockedError({
              provider: input.provider,
              reason: error.message,
              cause: error,
            }),
        ),
      );
  }

  const sessions = (yield* input.providerService.listSessions()).filter(
    (session) => session.provider === input.provider && session.status !== "closed",
  );
  if (sessions.length === 0) {
    return [] as ReadonlyArray<ThreadId>;
  }

  if (input.stopIdleSessions === false) {
    return yield* new ProviderUpdateBlockedError({
      provider: input.provider,
      reason: `Cannot update '${input.provider}' while ${sessions.length} runtime${sessions.length === 1 ? " is" : "s are"} open because process ownership cannot be proven safely. Close the affected sessions and retry.`,
    });
  }

  const activeSessions = sessions.filter(sessionHasActiveTurn);
  const sessionsWithLiveTasks = input.providerService.hasLiveRuntimeTasks
    ? yield* Effect.filter(
        sessions,
        (session) => input.providerService.hasLiveRuntimeTasks!({ threadId: session.threadId }),
        { concurrency: "unbounded" },
      )
    : [];
  const blockedThreadIds = new Set([
    ...activeSessions.map((session) => session.threadId),
    ...sessionsWithLiveTasks.map((session) => session.threadId),
  ]);
  if (blockedThreadIds.size > 0) {
    return yield* new ProviderUpdateBlockedError({
      provider: input.provider,
      reason: `Cannot update '${input.provider}' while ${blockedThreadIds.size} Synara runtime${blockedThreadIds.size === 1 ? " has" : "s have"} active work. Wait for turns and background tasks to finish, then retry.`,
    });
  }

  const stopRuntimeSession = input.providerService.stopRuntimeSession;
  if (!stopRuntimeSession) {
    return yield* new ProviderUpdateBlockedError({
      provider: input.provider,
      reason: `Cannot update '${input.provider}' because this runtime cannot safely preserve sessions while stopping the CLI.`,
    });
  }

  yield* Effect.forEach(
    sessions,
    (session) => stopRuntimeSession({ threadId: session.threadId }),
    { concurrency: 1, discard: true },
  );

  const remaining = (yield* input.providerService.listSessions()).filter(
    (session) => session.provider === input.provider && session.status !== "closed",
  );
  if (remaining.length > 0) {
    return yield* new ProviderUpdateBlockedError({
      provider: input.provider,
      reason: `Cannot update '${input.provider}' because ${remaining.length} Synara runtime${remaining.length === 1 ? " is" : "s are"} still running after shutdown.`,
    });
  }

  return sessions.map((session) => session.threadId);
});
