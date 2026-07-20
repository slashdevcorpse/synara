// FILE: AcpSessionTeardown.ts
// Purpose: Coordinates one authoritative ACP session-scope close and replays its exact outcome.
// Layer: Provider ACP lifecycle coordination

import { Deferred, Effect, Exit } from "effect";

export interface AcpSessionTeardownState {
  started: boolean;
  readonly completion: Deferred.Deferred<Exit.Exit<void, never>>;
}

export const makeAcpSessionTeardownState = Effect.fn("makeAcpSessionTeardownState")(function* () {
  return {
    started: false,
    completion: yield* Deferred.make<Exit.Exit<void, never>>(),
  } satisfies AcpSessionTeardownState;
});

export const awaitAcpSessionTeardown = (
  state: AcpSessionTeardownState,
): Effect.Effect<void> =>
  Deferred.await(state.completion).pipe(
    Effect.flatMap((outcome) =>
      Exit.isFailure(outcome) ? Effect.failCause(outcome.cause) : Effect.void,
    ),
  );

export function beginAcpSessionTeardown(
  state: AcpSessionTeardownState,
  onStart: () => void,
): boolean {
  if (state.started) return false;
  state.started = true;
  onStart();
  return true;
}

export const completeAcpSessionTeardown = (
  state: AcpSessionTeardownState,
  teardown: Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(teardown);
      yield* Deferred.succeed(state.completion, outcome);
      if (Exit.isFailure(outcome)) {
        return yield* Effect.failCause(outcome.cause);
      }
    }),
  );

/**
 * Runs teardown once, publishes its exact Exit to every waiter, and permanently remembers failure.
 * The failure channel is a defect because Scope finalizers are typed as infallible even though
 * process-exit proof can fail during finalization.
 */
export const runAcpSessionTeardown = (input: {
  readonly state: AcpSessionTeardownState;
  readonly onStart: () => void;
  readonly teardown: Effect.Effect<void>;
}): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.suspend(() =>
      beginAcpSessionTeardown(input.state, input.onStart)
        ? completeAcpSessionTeardown(input.state, input.teardown)
        : awaitAcpSessionTeardown(input.state),
    ),
  );
