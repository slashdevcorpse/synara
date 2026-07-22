import { ThreadId } from "@synara/contracts";
import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeDroidSessionTeardownGate } from "./DroidSessionTeardownGate.ts";
import { makeAcpSessionTeardownState, runAcpSessionTeardown } from "./AcpSessionTeardown.ts";

describe("DroidSessionTeardownGate", () => {
  it("blocks replacement work until the tracked teardown completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeDroidSessionTeardownGate();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const teardown = yield* makeAcpSessionTeardownState();
        let replacementStarted = false;
        gate.track(threadId, teardown);
        expect(gate.isPending(threadId)).toBe(true);

        const replacement = yield* gate.awaitPending(threadId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementStarted = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(replacementStarted).toBe(false);

        yield* runAcpSessionTeardown({
          state: teardown,
          onStart: () => undefined,
          teardown: Effect.void,
        });
        yield* gate.release(threadId, teardown);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
        expect(gate.isPending(threadId)).toBe(false);
      }),
    );
  });

  it("does not let stale cleanup clear a newer teardown gate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeDroidSessionTeardownGate();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const oldTeardown = yield* makeAcpSessionTeardownState();
        const newTeardown = yield* makeAcpSessionTeardownState();
        let replacementStarted = false;
        gate.track(threadId, oldTeardown);
        gate.track(threadId, newTeardown);

        yield* runAcpSessionTeardown({
          state: oldTeardown,
          onStart: () => undefined,
          teardown: Effect.void,
        });
        yield* gate.release(threadId, oldTeardown);
        expect(gate.isPending(threadId)).toBe(true);
        const replacement = yield* gate.awaitPending(threadId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementStarted = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(replacementStarted).toBe(false);

        yield* runAcpSessionTeardown({
          state: newTeardown,
          onStart: () => undefined,
          teardown: Effect.void,
        });
        yield* gate.release(threadId, newTeardown);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
      }),
    );
  });

  it("retains and replays a failed teardown instead of admitting a replacement", async () => {
    const failure = new Error("Droid process-tree exit was not proven");

    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeDroidSessionTeardownGate();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const teardown = yield* makeAcpSessionTeardownState();
        gate.track(threadId, teardown);

        const close = yield* runAcpSessionTeardown({
          state: teardown,
          onStart: () => undefined,
          teardown: Effect.die(failure),
        }).pipe(Effect.exit);
        const replacement = yield* gate.awaitPending(threadId).pipe(Effect.exit);

        expect(Exit.isFailure(close)).toBe(true);
        expect(Exit.isFailure(replacement)).toBe(true);
        if (Exit.isFailure(close)) expect(Cause.squash(close.cause)).toBe(failure);
        if (Exit.isFailure(replacement)) expect(Cause.squash(replacement.cause)).toBe(failure);
        expect(gate.isPending(threadId)).toBe(true);
      }),
    );
  });
});
