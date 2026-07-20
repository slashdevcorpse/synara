import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import {
  awaitAcpSessionTeardown,
  makeAcpSessionTeardownState,
  runAcpSessionTeardown,
} from "./AcpSessionTeardown.ts";

describe("AcpSessionTeardown", () => {
  it("replays scope-close failure without running success cleanup", async () => {
    const failure = new Error("process-tree exit was not proven");
    let startCount = 0;
    let deleted = false;
    let gracefulExitEmitted = false;

    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* makeAcpSessionTeardownState();
        const first = yield* runAcpSessionTeardown({
          state,
          onStart: () => {
            startCount += 1;
          },
          teardown: Effect.die(failure).pipe(
            Effect.andThen(
              Effect.sync(() => {
                deleted = true;
                gracefulExitEmitted = true;
              }),
            ),
          ),
        }).pipe(Effect.exit);
        const replay = yield* awaitAcpSessionTeardown(state).pipe(Effect.exit);

        expect(Exit.isFailure(first)).toBe(true);
        expect(Exit.isFailure(replay)).toBe(true);
        if (Exit.isFailure(first)) expect(Cause.squash(first.cause)).toBe(failure);
        if (Exit.isFailure(replay)) expect(Cause.squash(replay.cause)).toBe(failure);
      }),
    );

    expect(startCount).toBe(1);
    expect(deleted).toBe(false);
    expect(gracefulExitEmitted).toBe(false);
  });

  it("makes concurrent callers await the same teardown outcome", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* makeAcpSessionTeardownState();
        let closeCount = 0;
        const teardown = runAcpSessionTeardown({
          state,
          onStart: () => undefined,
          teardown: Effect.sync(() => {
            closeCount += 1;
          }),
        });
        const first = yield* teardown.pipe(Effect.forkChild);
        const second = yield* teardown.pipe(Effect.forkChild);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(closeCount).toBe(1);
      }),
    );
  });
});
