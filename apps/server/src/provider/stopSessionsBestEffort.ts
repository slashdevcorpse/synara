import { Cause, Effect, Exit } from "effect";

/**
 * Attempts a snapshot of every session stop and re-raises the first failure only after all were
 * tried. Preserving the full cause keeps defects and interruptions intact for the caller.
 */
export function stopSessionsBestEffort<Session, Error, Requirements>(
  sessions: Iterable<Session>,
  stopSession: (session: Session) => Effect.Effect<void, Error, Requirements>,
): Effect.Effect<void, Error, Requirements> {
  return Effect.gen(function* () {
    let firstFailure: Cause.Cause<Error> | undefined;
    for (const session of Array.from(sessions)) {
      const exit = yield* Effect.exit(stopSession(session));
      if (Exit.isFailure(exit) && firstFailure === undefined) {
        firstFailure = exit.cause;
      }
    }
    if (firstFailure !== undefined) {
      return yield* Effect.failCause(firstFailure);
    }
  });
}
