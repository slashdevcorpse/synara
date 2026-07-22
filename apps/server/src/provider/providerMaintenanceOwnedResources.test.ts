import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeProviderMaintenanceOwnedResourceCoordinator,
  ProviderMaintenanceOwnedResourceCloseError,
} from "./providerMaintenanceOwnedResources.ts";

describe("ProviderMaintenanceOwnedResourceCoordinator", () => {
  it("drains only resources owned by the selected provider", async () => {
    const closed: Array<string> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        yield* coordinator.register({
          provider: "opencode",
          resourceId: "opencode:warm-1",
          close: () => Effect.sync(() => closed.push("opencode")),
        });
        yield* coordinator.register({
          provider: "kilo",
          resourceId: "kilo:warm-1",
          close: () => Effect.sync(() => closed.push("kilo")),
        });

        yield* coordinator.drainProviderResources({ provider: "opencode" });
        expect(closed).toEqual(["opencode"]);

        yield* coordinator.drainProviderResources({ provider: "kilo" });
        expect(closed).toEqual(["opencode", "kilo"]);
      }),
    );
  });

  it("retains a failed resource and retries that exact registration", async () => {
    const firstFailure = new Error("process-tree exit remains unproven");
    let closeAttempts = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        yield* coordinator.register({
          provider: "opencode",
          resourceId: "opencode:warm-retry",
          close: () =>
            Effect.suspend(() => {
              closeAttempts += 1;
              return closeAttempts === 1 ? Effect.fail(firstFailure) : Effect.void;
            }),
        });

        const first = yield* coordinator
          .drainProviderResources({ provider: "opencode" })
          .pipe(Effect.flip);
        expect(first).toBeInstanceOf(ProviderMaintenanceOwnedResourceCloseError);
        expect(first.resourceId).toBe("opencode:warm-retry");
        expect(first.cause).toBe(firstFailure);

        yield* coordinator.drainProviderResources({ provider: "opencode" });
        yield* coordinator.drainProviderResources({ provider: "opencode" });
        expect(closeAttempts).toBe(2);
      }),
    );
  });

  it("does not close an explicitly unregistered resource", async () => {
    let closeAttempts = 0;

    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        const registration = yield* coordinator.register({
          provider: "kilo",
          resourceId: "kilo:released",
          close: () => Effect.sync(() => closeAttempts++),
        });
        yield* registration.unregister;
        yield* registration.unregister;
        yield* coordinator.drainProviderResources({ provider: "kilo" });
      }),
    );

    expect(closeAttempts).toBe(0);
  });

  it("attempts every close, removes successes, and aggregates retained failures", async () => {
    const firstFailure = new Error("first process-tree exit remains unproven");
    const secondFailure = new Error("second process-tree exit remains unproven");
    const attempts: Array<string> = [];
    let rejectFirst = true;
    let rejectSecond = true;

    await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
        yield* coordinator.register({
          provider: "opencode",
          resourceId: "opencode:failed-first",
          close: () =>
            Effect.suspend(() => {
              attempts.push("failed-first");
              return rejectFirst ? Effect.fail(firstFailure) : Effect.void;
            }),
        });
        yield* coordinator.register({
          provider: "opencode",
          resourceId: "opencode:successful",
          close: () => Effect.sync(() => attempts.push("successful")),
        });
        yield* coordinator.register({
          provider: "opencode",
          resourceId: "opencode:failed-second",
          close: () =>
            Effect.suspend(() => {
              attempts.push("failed-second");
              return rejectSecond ? Effect.fail(secondFailure) : Effect.void;
            }),
        });

        const error = yield* coordinator
          .drainProviderResources({ provider: "opencode" })
          .pipe(Effect.flip);
        expect(attempts).toEqual(["failed-first", "successful", "failed-second"]);
        expect(error.failures).toEqual([
          { resourceId: "opencode:failed-first", cause: firstFailure },
          { resourceId: "opencode:failed-second", cause: secondFailure },
        ]);

        attempts.length = 0;
        rejectFirst = false;
        rejectSecond = false;
        yield* coordinator.drainProviderResources({ provider: "opencode" });
        expect(attempts).toEqual(["failed-first", "failed-second"]);

        attempts.length = 0;
        yield* coordinator.drainProviderResources({ provider: "opencode" });
        expect(attempts).toEqual([]);
      }),
    );
  });

  it("finishes every claimed close before honoring drain interruption", async () => {
    const attempts: Array<string> = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
          const firstCloseStarted = yield* Deferred.make<void>();
          const allowFirstClose = yield* Deferred.make<void>();
          yield* coordinator.register({
            provider: "opencode",
            resourceId: "opencode:interrupt-first",
            close: () =>
              Effect.sync(() => attempts.push("first")).pipe(
                Effect.andThen(Deferred.succeed(firstCloseStarted, undefined)),
                Effect.andThen(Deferred.await(allowFirstClose)),
              ),
          });
          yield* coordinator.register({
            provider: "opencode",
            resourceId: "opencode:interrupt-second",
            close: () => Effect.sync(() => attempts.push("second")),
          });

          const draining = yield* coordinator
            .drainProviderResources({ provider: "opencode" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(firstCloseStarted);
          const interrupting = yield* Fiber.interrupt(draining).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const interruptionWaitedForDrain = interrupting.pollUnsafe() === undefined;

          yield* Deferred.succeed(allowFirstClose, undefined);
          yield* Fiber.join(interrupting);

          expect(interruptionWaitedForDrain).toBe(true);
          expect(attempts).toEqual(["first", "second"]);
          yield* coordinator.drainProviderResources({ provider: "opencode" });
          expect(attempts).toEqual(["first", "second"]);
        }),
      ),
    );
  });

  it("serializes concurrent drains without double-closing a resource", async () => {
    let closeAttempts = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeProviderMaintenanceOwnedResourceCoordinator;
          const closeStarted = yield* Deferred.make<void>();
          const allowClose = yield* Deferred.make<void>();
          yield* coordinator.register({
            provider: "opencode",
            resourceId: "opencode:concurrent",
            close: () =>
              Effect.sync(() => closeAttempts++).pipe(
                Effect.andThen(Deferred.succeed(closeStarted, undefined)),
                Effect.andThen(Deferred.await(allowClose)),
              ),
          });

          const first = yield* coordinator
            .drainProviderResources({ provider: "opencode" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(closeStarted);
          const second = yield* coordinator
            .drainProviderResources({ provider: "opencode" })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(closeAttempts).toBe(1);

          yield* Deferred.succeed(allowClose, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect(closeAttempts).toBe(1);
        }),
      ),
    );
  });
});
