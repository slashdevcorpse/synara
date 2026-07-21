import { ThreadId } from "@synara/contracts";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { makeProviderLifecycleCoordinator } from "./providerLifecycleCoordinator";

describe("ProviderLifecycleCoordinator", () => {
  it("preserves a live adopted generation while ordinary work becomes idle", async () => {
    const coordinator = makeProviderLifecycleCoordinator();
    const threadId = ThreadId.makeUnsafe("provider-lifecycle-live");
    coordinator.adoptCurrent(threadId, "live-generation");

    const observed = await Effect.runPromise(
      coordinator.runCurrent(threadId, (generation) => Effect.succeed(generation)),
    );

    expect(observed).toBe("live-generation");
    expect(coordinator.currentGeneration(threadId)).toBe("live-generation");
  });

  it("reclaims an explicitly retired idle generation", () => {
    const coordinator = makeProviderLifecycleCoordinator();
    const threadId = ThreadId.makeUnsafe("provider-lifecycle-retired");
    coordinator.adoptCurrent(threadId, "dead-generation");

    coordinator.retireThread(threadId);

    expect(coordinator.currentGeneration(threadId)).toBeUndefined();
  });

  it("keeps a thread retired when deletion arrives during in-flight work", async () => {
    const coordinator = makeProviderLifecycleCoordinator();
    const threadId = ThreadId.makeUnsafe("provider-lifecycle-in-flight-retirement");
    let releaseOperation: () => void = () => undefined;
    let operationIsCurrent: (() => boolean) | undefined;
    const operationStarted = Promise.withResolvers<void>();
    const operationReleased = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });

    const fiber = Effect.runFork(
      coordinator.run(threadId, (lease) =>
        Effect.sync(() => {
          operationIsCurrent = lease.isCurrent;
          operationStarted.resolve();
        }).pipe(Effect.andThen(Effect.promise(() => operationReleased))),
      ),
    );
    await operationStarted.promise;

    expect(operationIsCurrent?.()).toBe(true);
    coordinator.retireThread(threadId);
    expect(operationIsCurrent?.()).toBe(false);
    expect(coordinator.currentGeneration(threadId)).toBeUndefined();

    releaseOperation();
    await Effect.runPromise(Fiber.join(fiber));
    expect(coordinator.currentGeneration(threadId)).toBeUndefined();
  });

  it("reclaims a generation installed by queued work after retirement", async () => {
    const coordinator = makeProviderLifecycleCoordinator();
    const threadId = ThreadId.makeUnsafe("provider-lifecycle-queued-retirement");
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let queuedIsCurrent: (() => boolean) | undefined;

    const firstFiber = Effect.runFork(
      coordinator.run(threadId, () =>
        Effect.sync(() => firstStarted.resolve()).pipe(
          Effect.andThen(Effect.promise(() => releaseFirst.promise)),
        ),
      ),
    );
    await firstStarted.promise;
    const queuedFiber = Effect.runFork(
      coordinator.run(threadId, (lease) =>
        Effect.sync(() => {
          queuedIsCurrent = lease.isCurrent;
        }),
      ),
    );
    while (coordinator.diagnostics(threadId).lockUsers !== 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    coordinator.retireThread(threadId);
    expect(coordinator.diagnostics(threadId)).toEqual({
      lockUsers: 2,
      retireWhenIdle: true,
    });
    releaseFirst.resolve();
    await Effect.runPromise(Fiber.join(firstFiber));
    await Effect.runPromise(Fiber.join(queuedFiber));

    expect(queuedIsCurrent?.()).toBe(false);
    expect(coordinator.currentGeneration(threadId)).toBeUndefined();
    expect(coordinator.diagnostics(threadId)).toEqual({
      lockUsers: 0,
      retireWhenIdle: false,
    });
  });

  it("periodically reclaims only idle generations without a live binding", async () => {
    const coordinator = makeProviderLifecycleCoordinator();
    const liveThreadId = ThreadId.makeUnsafe("provider-lifecycle-sweep-live");
    const deadThreadId = ThreadId.makeUnsafe("provider-lifecycle-sweep-dead");
    const activeThreadId = ThreadId.makeUnsafe("provider-lifecycle-sweep-active");
    const activeStarted = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    coordinator.adoptCurrent(liveThreadId, "live-generation");
    coordinator.adoptCurrent(deadThreadId, "dead-generation");
    const activeFiber = Effect.runFork(
      coordinator.run(activeThreadId, () =>
        Effect.sync(() => activeStarted.resolve()).pipe(
          Effect.andThen(Effect.promise(() => releaseActive.promise)),
        ),
      ),
    );
    await activeStarted.promise;

    expect(coordinator.sweepIdle((threadId) => threadId === liveThreadId)).toBe(1);
    expect(coordinator.currentGeneration(liveThreadId)).toBe("live-generation");
    expect(coordinator.currentGeneration(deadThreadId)).toBeUndefined();
    expect(coordinator.currentGeneration(activeThreadId)).toBeDefined();

    releaseActive.resolve();
    await Effect.runPromise(Fiber.join(activeFiber));
    expect(coordinator.sweepIdle((threadId) => threadId === liveThreadId)).toBe(1);
    expect(coordinator.currentGeneration(activeThreadId)).toBeUndefined();
  });
});
