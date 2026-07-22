import { ThreadId } from "@synara/contracts";
import { Cause, Deferred, Effect, Fiber, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterProcessError } from "../Errors.ts";
import {
  cleanupAllAcpOwners,
  closeAcpSessionAfterProcessTeardown,
  failAcpStartupAfterCleanup,
  failAcpStartupCauseAfterCleanup,
  makeAcpStartupCleanupOwner,
  makeDroidSessionTeardownGate,
  retryRetainedAcpStartupOwner,
  stopExistingAcpSessionOwner,
} from "./DroidSessionTeardownGate.ts";

describe("DroidSessionTeardownGate", () => {
  it("retains a failed pre-transfer startup owner and retries the exact cleanup", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-startup");
        const scope = yield* Scope.make("sequential");
        const retainedOwners = new Map();
        const startupError = new Error("startup rejected");
        const cleanupError = new Error("process proof rejected");
        let cleanupAttempts = 0;
        let scopeFinalizerRuns = 0;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            scopeFinalizerRuns += 1;
          }),
        ).pipe(Effect.provideService(Scope.Scope, scope));
        const owner = makeAcpStartupCleanupOwner({
          provider: "droid",
          providerLabel: "Droid",
          threadId,
          scope,
        });
        owner.captureProcessTeardown(
          Effect.suspend(() => {
            cleanupAttempts += 1;
            return cleanupAttempts === 1 ? Effect.die(cleanupError) : Effect.void;
          }),
        );

        const failedStartup = yield* Effect.exit(
          failAcpStartupAfterCleanup({
            provider: "droid",
            providerLabel: "Droid",
            threadId,
            startupError,
            owner,
            retainedOwners,
          }),
        );
        expect(failedStartup).toMatchObject({ _tag: "Failure" });
        expect(retainedOwners.get(threadId)).toBe(owner);
        expect(scopeFinalizerRuns).toBe(0);

        yield* retryRetainedAcpStartupOwner(retainedOwners, threadId);
        expect(cleanupAttempts).toBe(2);
        expect(scopeFinalizerRuns).toBe(1);
        expect(retainedOwners.has(threadId)).toBe(false);
      }),
    );
  });

  it("cleans a pre-transfer owner when startup dies instead of failing normally", async () => {
    const threadId = ThreadId.makeUnsafe("thread-startup-defect");
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const retainedOwners = new Map();
    const startupDefect = new Error("startup defect");
    let cleanupAttempts = 0;
    const owner = makeAcpStartupCleanupOwner({
      provider: "droid",
      providerLabel: "Droid",
      threadId,
      scope,
    });
    owner.captureProcessTeardown(
      Effect.sync(() => {
        cleanupAttempts += 1;
      }),
    );

    await expect(
      Effect.runPromise(
        failAcpStartupCauseAfterCleanup({
          provider: "droid",
          providerLabel: "Droid",
          threadId,
          startupCause: Cause.die(startupDefect),
          owner,
          retainedOwners,
        }),
      ),
    ).rejects.toBe(startupDefect);
    expect(cleanupAttempts).toBe(1);
    expect(retainedOwners.size).toBe(0);
  });

  it("attempts every ACP owner cleanup before aggregating failures", async () => {
    const attempts: string[] = [];
    const failureOne = new ProviderAdapterProcessError({
      provider: "droid",
      threadId: "thread-1",
      detail: "owner one failed",
    });
    const failureThree = new ProviderAdapterProcessError({
      provider: "droid",
      threadId: "thread-3",
      detail: "owner three failed",
    });
    const cleanup = cleanupAllAcpOwners({
      provider: "droid",
      providerLabel: "Droid",
      owners: [
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          cleanup: Effect.sync(() => {
            attempts.push("thread-1");
          }).pipe(Effect.andThen(Effect.fail(failureOne))),
        },
        {
          threadId: ThreadId.makeUnsafe("thread-2"),
          cleanup: Effect.sync(() => {
            attempts.push("thread-2");
          }),
        },
        {
          threadId: ThreadId.makeUnsafe("thread-3"),
          cleanup: Effect.sync(() => {
            attempts.push("thread-3");
          }).pipe(Effect.andThen(Effect.fail(failureThree))),
        },
      ],
    });

    await expect(Effect.runPromise(cleanup)).rejects.toMatchObject({
      _tag: "ProviderAdapterProcessError",
      threadId: "thread-1,thread-3",
    });
    expect(attempts.sort()).toEqual(["thread-1", "thread-2", "thread-3"]);
  });

  it("keeps the scope open after rejected process proof and closes it after retry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-1");
        const scope = yield* Scope.make("sequential");
        const cleanupError = new Error("cleanup proof rejected");
        let cleanupAttempts = 0;
        let scopeFinalizerRuns = 0;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            scopeFinalizerRuns += 1;
          }),
        ).pipe(Effect.provideService(Scope.Scope, scope));
        const processTeardown = Effect.suspend(() => {
          cleanupAttempts += 1;
          return cleanupAttempts === 1 ? Effect.die(cleanupError) : Effect.void;
        });
        const cleanup = closeAcpSessionAfterProcessTeardown({
          provider: "droid",
          providerLabel: "Droid",
          threadId,
          processTeardown,
          scope,
        });

        const firstExit = yield* Effect.exit(cleanup);
        expect(firstExit).toMatchObject({ _tag: "Failure" });
        expect(scopeFinalizerRuns).toBe(0);

        yield* cleanup;
        expect(cleanupAttempts).toBe(2);
        expect(scopeFinalizerRuns).toBe(1);
      }),
    );
  });

  it("does not treat a second no-op scope close as recovery from a failed close", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.makeUnsafe("thread-1");
        const scope = yield* Scope.make("sequential");
        const scopeError = new Error("scope finalizer rejected");
        let processTeardownRuns = 0;
        let scopeFinalizerRuns = 0;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            scopeFinalizerRuns += 1;
          }).pipe(Effect.andThen(Effect.die(scopeError))),
        ).pipe(Effect.provideService(Scope.Scope, scope));
        const cleanup = closeAcpSessionAfterProcessTeardown({
          provider: "droid",
          providerLabel: "Droid",
          threadId,
          processTeardown: Effect.sync(() => {
            processTeardownRuns += 1;
          }),
          scope,
        });

        const firstExit = yield* Effect.exit(cleanup);
        const secondExit = yield* Effect.exit(cleanup);
        expect(firstExit).toMatchObject({ _tag: "Failure" });
        expect(secondExit).toEqual(firstExit);
        expect(processTeardownRuns).toBe(1);
        expect(scopeFinalizerRuns).toBe(1);
      }),
    );
  });

  it("retries a retained stopped owner before replacement work can run", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const retainedOwner = { stopped: true, ownerId: "exact-owner" };
    const sessions = new Map([[threadId, retainedOwner]]);
    const cleanupError = new Error("cleanup proof rejected");
    const observedOwners: Array<typeof retainedOwner> = [];
    let cleanupAttempts = 0;
    let replacementStarts = 0;
    const stopOwner = (owner: typeof retainedOwner) =>
      Effect.suspend(() => {
        observedOwners.push(owner);
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          return Effect.fail(cleanupError);
        }
        sessions.delete(threadId);
        return Effect.void;
      });
    const startReplacement = stopExistingAcpSessionOwner(sessions, threadId, stopOwner).pipe(
      Effect.andThen(
        Effect.sync(() => {
          replacementStarts += 1;
        }),
      ),
    );

    await expect(Effect.runPromise(startReplacement)).rejects.toBe(cleanupError);
    expect(sessions.get(threadId)).toBe(retainedOwner);
    expect(replacementStarts).toBe(0);

    await Effect.runPromise(startReplacement);
    expect(observedOwners).toEqual([retainedOwner, retainedOwner]);
    expect(sessions.has(threadId)).toBe(false);
    expect(replacementStarts).toBe(1);
  });

  it("blocks replacement work until the tracked teardown completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeDroidSessionTeardownGate<Error>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const completion = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        let replacementStarted = false;
        gate.track(
          threadId,
          completion,
          Deferred.succeed(cleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCleanup)),
          ),
        );
        expect(gate.isPending(threadId)).toBe(true);

        const replacement = yield* gate.awaitPending(threadId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              replacementStarted = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(cleanupStarted);
        expect(replacementStarted).toBe(false);

        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
        expect(gate.isPending(threadId)).toBe(false);
      }),
    );
  });

  it("shares a failed cleanup across callers and retries it for the next replacement", async () => {
    const gate = makeDroidSessionTeardownGate<Error>();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const completion = Deferred.makeUnsafe<void>();
    const cleanupStarted = Deferred.makeUnsafe<void>();
    const releaseCleanup = Deferred.makeUnsafe<void>();
    const cleanupError = new Error("cleanup proof rejected");
    let cleanupAttempts = 0;
    gate.track(
      threadId,
      completion,
      Effect.suspend(() => {
        cleanupAttempts += 1;
        return cleanupAttempts === 1
          ? Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCleanup)),
              Effect.andThen(Effect.fail(cleanupError)),
            )
          : Effect.void;
      }),
    );

    const first = Effect.runPromiseExit(gate.run(threadId, completion));
    const second = Effect.runPromiseExit(gate.run(threadId, completion));
    await Effect.runPromise(Deferred.await(cleanupStarted));
    expect(cleanupAttempts).toBe(1);
    Deferred.doneUnsafe(releaseCleanup, Effect.void);
    const [firstExit, secondExit] = await Promise.all([first, second]);
    expect(firstExit).toEqual(secondExit);
    expect(firstExit).toMatchObject({ _tag: "Failure" });
    expect(gate.isPending(threadId)).toBe(true);

    await Effect.runPromise(gate.awaitPending(threadId));
    expect(cleanupAttempts).toBe(2);
    expect(gate.isPending(threadId)).toBe(false);
  });

  it("shares one cleanup attempt across concurrent callers", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeDroidSessionTeardownGate<Error>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const completion = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        let cleanupAttempts = 0;
        gate.track(
          threadId,
          completion,
          Effect.gen(function* () {
            cleanupAttempts += 1;
            yield* Deferred.succeed(cleanupStarted, undefined);
            yield* Deferred.await(releaseCleanup);
          }),
        );

        const first = yield* gate.run(threadId, completion).pipe(Effect.forkChild);
        const second = yield* gate.run(threadId, completion).pipe(Effect.forkChild);
        yield* Deferred.await(cleanupStarted);
        yield* Effect.yieldNow;
        expect(cleanupAttempts).toBe(1);

        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(cleanupAttempts).toBe(1);
        expect(gate.isPending(threadId)).toBe(false);
      }),
    );
  });

  it("does not let stale cleanup clear a newer teardown gate", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const gate = makeDroidSessionTeardownGate<Error>();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const oldCompletion = yield* Deferred.make<void>();
        const newCompletion = yield* Deferred.make<void>();
        const oldCleanupStarted = yield* Deferred.make<void>();
        const releaseOldCleanup = yield* Deferred.make<void>();
        const releaseNewCleanup = yield* Deferred.make<void>();
        let replacementStarted = false;
        gate.track(
          threadId,
          oldCompletion,
          Deferred.succeed(oldCleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseOldCleanup)),
          ),
        );
        const oldCleanup = yield* gate.run(threadId, oldCompletion).pipe(Effect.forkChild);
        yield* Deferred.await(oldCleanupStarted);
        gate.track(threadId, newCompletion, Deferred.await(releaseNewCleanup));

        yield* Deferred.succeed(releaseOldCleanup, undefined);
        yield* Fiber.join(oldCleanup);
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

        yield* Deferred.succeed(releaseNewCleanup, undefined);
        yield* Fiber.join(replacement);
        expect(replacementStarted).toBe(true);
      }),
    );
  });
});
