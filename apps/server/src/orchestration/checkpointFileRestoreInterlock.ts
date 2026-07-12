import { Effect, Semaphore } from "effect";

const checkpointFileRestoreInterlock = Semaphore.makeUnsafe(1);

export function withCheckpointFileRestoreInterlock<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return checkpointFileRestoreInterlock.withPermits(1)(effect);
}
