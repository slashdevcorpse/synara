import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it } from "vitest";

import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";

class CoordinatorTestError extends Error {
  constructor(
    readonly kind: "already-running" | "cross-process",
    readonly key: string,
    readonly targetKey: string | null = null,
    readonly causeTag: string | null = null,
  ) {
    super(`${kind}:${key}`);
  }
}

const tempDirectories: string[] = [];

async function makeLockDirectory(): Promise<string> {
  const directory = await NodeFs.mkdtemp(
    NodePath.join(NodeOs.tmpdir(), "synara-provider-command-coordinator-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function makeCoordinator(directoryPath: string) {
  return makeProviderMaintenanceCommandCoordinator<CoordinatorTestError>({
    crossProcessLockDirectory: directoryPath,
    makeAlreadyRunningError: (targetKey) => new CoordinatorTestError("already-running", targetKey),
    makeCrossProcessLockError: (targetKey, lockKey, cause) =>
      new CoordinatorTestError("cross-process", lockKey, targetKey, cause._tag),
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFs.rm(directory, { recursive: true, force: true })),
  );
});

describe("provider maintenance command coordinator", () => {
  it("rejects duplicate target requests in one process", async () => {
    const directoryPath = await makeLockDirectory();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeCoordinator(directoryPath);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* coordinator
          .withCommandLock({
            targetKey: "codex",
            lockKey: "npm-global:/shared",
            canonicalInstallRoot: directoryPath,
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const duplicate = yield* Effect.flip(
          coordinator.withCommandLock({
            targetKey: "codex",
            lockKey: "npm-global:/shared",
            canonicalInstallRoot: directoryPath,
            run: Effect.void,
          }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        return duplicate;
      }),
    );

    expect(result).toMatchObject({ kind: "already-running", key: "codex" });
  });

  it("excludes the same canonical root across independent coordinators", async () => {
    const directoryPath = await makeLockDirectory();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const firstCoordinator = yield* makeCoordinator(directoryPath);
        const secondCoordinator = yield* makeCoordinator(directoryPath);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* firstCoordinator
          .withCommandLock({
            targetKey: "codex",
            lockKey: "npm-global:/shared",
            canonicalInstallRoot: directoryPath,
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const collision = yield* Effect.flip(
          secondCoordinator.withCommandLock({
            targetKey: "opencode",
            lockKey: "npm-global:/shared",
            canonicalInstallRoot: directoryPath,
            run: Effect.void,
          }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        return collision;
      }),
    );

    expect(result).toMatchObject({
      kind: "cross-process",
      key: "npm-global:/shared",
      targetKey: "opencode",
      causeTag: "ProviderMaintenanceCrossProcessLockError",
    });
  });

  it("releases a target reservation when a queued command is interrupted", async () => {
    const directoryPath = await makeLockDirectory();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* makeCoordinator(directoryPath);
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const first = yield* coordinator
          .withCommandLock({
            targetKey: "codex",
            lockKey: "npm-global:/shared",
            canonicalInstallRoot: directoryPath,
            run: Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            ),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);

        const interrupted = yield* coordinator
          .withCommandLock({
            targetKey: "opencode",
            lockKey: "npm-global:/shared",
            canonicalInstallRoot: directoryPath,
            onQueued: Deferred.succeed(queued, undefined),
            run: Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(queued);
        yield* Fiber.interrupt(interrupted);

        let retried = false;
        yield* coordinator.withCommandLock({
          targetKey: "opencode",
          lockKey: "npm-global:/other",
          canonicalInstallRoot: directoryPath,
          run: Effect.sync(() => {
            retried = true;
          }),
        });
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        return retried;
      }),
    );

    expect(result).toBe(true);
  });
});
