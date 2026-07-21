import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import {
  MANAGED_ATTACHMENT_WRITING_LEASE_MS,
  ManagedAttachmentCleanup,
  ManagedAttachmentCleanupLive,
  makeManagedAttachmentStagingRecovery,
  runManagedAttachmentCleanupBatch,
  runManagedAttachmentStagingRecovery,
  sweepOrphanManagedAttachmentParts,
} from "./managedAttachmentCleanup";
import { withManagedAttachmentStagingPathLock } from "./managedAttachmentStore";
import {
  ManagedAttachmentRepository,
  type ManagedAttachmentCleanupJob,
  type ManagedAttachmentRepositoryShape,
} from "./persistence/Services/ManagedAttachments";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeFixture(options: { readonly finalPathIsDirectory?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-cleanup-"));
  temporaryRoots.push(root);
  const attachmentId = "att_v2_0123456789abcdef0123456789abcdef";
  const relativePath = `objects/01/${attachmentId}.png`;
  const finalPath = path.join(root, relativePath);
  const stagingPath = path.join(root, ".staging", `${attachmentId}.part`);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  if (options.finalPathIsDirectory) await fs.mkdir(finalPath);
  else await fs.writeFile(finalPath, "final");
  await fs.writeFile(stagingPath, "partial");

  const job: ManagedAttachmentCleanupJob = {
    attachmentId,
    relativePath,
    reason: "test-cleanup",
    attemptCount: 0,
    nextAttemptAt: new Date(0).toISOString(),
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return { root, finalPath, stagingPath, job };
}

function makeRepository(job: ManagedAttachmentCleanupJob) {
  const completed: string[] = [];
  const retried: string[] = [];
  const repository = {
    markExpiredForCleanup: () => Effect.succeed([]),
    leaseCleanup: () => Effect.succeed([job]),
    compactDeleted: () => Effect.succeed([]),
    completeCleanup: ({
      attachmentId,
    }: Parameters<ManagedAttachmentRepositoryShape["completeCleanup"]>[0]) =>
      Effect.sync(() => {
        completed.push(attachmentId);
        return true;
      }),
    retryCleanup: ({
      attachmentId,
    }: Parameters<ManagedAttachmentRepositoryShape["retryCleanup"]>[0]) =>
      Effect.sync(() => {
        retried.push(attachmentId);
        return true;
      }),
  } as unknown as ManagedAttachmentRepositoryShape;
  return { repository, completed, retried };
}

describe("managed attachment cleanup", () => {
  it("completes one bounded staging sweep before the cleanup service becomes available", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-startup-sweep-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const stalePart = path.join(stagingDir, "att_v2_99999999999999999999999999999999.part");
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(stalePart, "stale");
    const staleDate = new Date(Date.now() - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(stalePart, staleDate, staleDate);
    const repository = {
      markExpiredForCleanup: () => Effect.succeed([]),
      leaseCleanup: () => Effect.succeed([]),
      compactDeleted: () => Effect.succeed([]),
      listFailedCleanup: () => Effect.succeed([]),
    } as unknown as ManagedAttachmentRepositoryShape;

    const stalePartMissingAtAcquisition = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ManagedAttachmentCleanup;
          return yield* Effect.promise(async () => {
            try {
              await fs.stat(stalePart);
              return false;
            } catch (cause) {
              return (cause as NodeJS.ErrnoException).code === "ENOENT";
            }
          });
        }),
      ).pipe(
        Effect.provide(
          ManagedAttachmentCleanupLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ManagedAttachmentRepository, repository),
                Layer.succeed(ServerConfig, { attachmentsDir: root } as ServerConfigShape),
              ),
            ),
          ),
        ),
      ),
    );

    expect(stalePartMissingAtAcquisition).toBe(true);
  });

  it("does not let an active upload-path lock stall the shutdown drain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-drain-lock-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const stalePart = path.join(stagingDir, "att_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.part");
    await fs.mkdir(stagingDir, { recursive: true });
    const repository = {
      markExpiredForCleanup: () => Effect.succeed([]),
      leaseCleanup: () => Effect.succeed([]),
      compactDeleted: () => Effect.succeed([]),
      listFailedCleanup: () => Effect.succeed([]),
    } as unknown as ManagedAttachmentRepositoryShape;

    const completedWhileLocked = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cleanup = yield* ManagedAttachmentCleanup;
          // Finish the startup continuation before introducing new work.
          yield* cleanup.drain;
          yield* Effect.promise(async () => {
            await fs.writeFile(stalePart, "locked stale part");
            const staleDate = new Date(Date.now() - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
            await fs.utimes(stalePart, staleDate, staleDate);
          });

          let releaseWriter!: () => void;
          const writerReleased = new Promise<void>((resolve) => {
            releaseWriter = resolve;
          });
          let markWriterAcquired!: () => void;
          const writerAcquired = new Promise<void>((resolve) => {
            markWriterAcquired = resolve;
          });
          const writer = withManagedAttachmentStagingPathLock(stalePart, async () => {
            markWriterAcquired();
            await writerReleased;
          });
          yield* Effect.promise(() => writerAcquired);

          return yield* Effect.promise(async () => {
            const drain = Effect.runPromise(cleanup.drain);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                drain.then(() => true),
                new Promise<false>((resolve) => {
                  timeout = setTimeout(() => resolve(false), 250);
                }),
              ]);
            } finally {
              if (timeout) clearTimeout(timeout);
              releaseWriter();
              await Promise.all([writer, drain]);
            }
          });
        }),
      ).pipe(
        Effect.provide(
          ManagedAttachmentCleanupLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ManagedAttachmentRepository, repository),
                Layer.succeed(ServerConfig, { attachmentsDir: root } as ServerConfigShape),
              ),
            ),
          ),
        ),
      ),
    );

    expect(completedWhileLocked).toBe(true);
    await expect(fs.readFile(stalePart, "utf8")).resolves.toBe("locked stale part");
  });

  it("sweeps stale orphan parts without a database row while preserving fresh and near-match files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-sweep-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const stalePart = path.join(stagingDir, "att_v2_11111111111111111111111111111111.part");
    const freshPart = path.join(stagingDir, "att_v2_22222222222222222222222222222222.part");
    const nearMatch = path.join(stagingDir, "att_v2_33333333333333333333333333333333.part.extra");
    await fs.mkdir(stagingDir, { recursive: true });
    await Promise.all([
      fs.writeFile(stalePart, "stale"),
      fs.writeFile(freshPart, "fresh"),
      fs.writeFile(nearMatch, "preserve"),
    ]);
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(stalePart, staleDate, staleDate);

    const result = await sweepOrphanManagedAttachmentParts({ attachmentsDir: root, nowMs });

    expect(result).toMatchObject({ removed: 1, failures: 0 });
    await expect(fs.stat(stalePart)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(freshPart, "utf8")).resolves.toBe("fresh");
    await expect(fs.readFile(nearMatch, "utf8")).resolves.toBe("preserve");
  });

  it("bounds startup staging work and rejects a symlinked staging directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-contained-"));
    temporaryRoots.push(root);
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "synara-managed-staging-contained-outside-"),
    );
    temporaryRoots.push(outside);
    const outsidePart = path.join(outside, "att_v2_44444444444444444444444444444444.part");
    await fs.writeFile(outsidePart, "outside");
    await fs.symlink(
      outside,
      path.join(root, ".staging"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await sweepOrphanManagedAttachmentParts({
      attachmentsDir: root,
      scanLimit: 1,
      maxRemovals: 1,
    });

    expect(result).toEqual({ inspected: 0, removed: 0, failures: 1 });
    await expect(fs.readFile(outsidePart, "utf8")).resolves.toBe("outside");
  });

  it.skipIf(process.platform === "win32")(
    "keeps deletion on the opened staging directory when its pathname is swapped",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-swap-"));
      temporaryRoots.push(root);
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "synara-managed-staging-swap-outside-"),
      );
      temporaryRoots.push(outside);
      const stagingDir = path.join(root, ".staging");
      const originalStagingDir = path.join(root, ".staging.original");
      const partName = "att_v2_45454545454545454545454545454545.part";
      const originalPart = path.join(stagingDir, partName);
      const outsidePart = path.join(outside, partName);
      await fs.mkdir(stagingDir);
      await Promise.all([
        fs.writeFile(originalPart, "original"),
        fs.writeFile(outsidePart, "outside"),
      ]);
      const nowMs = Date.now();
      const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
      await Promise.all([
        fs.utimes(originalPart, staleDate, staleDate),
        fs.utimes(outsidePart, staleDate, staleDate),
      ]);

      const result = await sweepOrphanManagedAttachmentParts({
        attachmentsDir: root,
        nowMs,
        beforePinnedDelete: async () => {
          await fs.rename(stagingDir, originalStagingDir);
          await fs.symlink(outside, stagingDir, process.platform === "win32" ? "junction" : "dir");
        },
      });

      expect(result).toMatchObject({ removed: 1, failures: 0 });
      await expect(fs.stat(path.join(originalStagingDir, partName))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.realpath(stagingDir)).resolves.toBe(await fs.realpath(outside));
      await expect(fs.readFile(outsidePart, "utf8")).resolves.toBe("outside");
    },
  );

  it("preserves an exact-name part replaced between the two stale-file validations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-race-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const partPath = path.join(stagingDir, "att_v2_55555555555555555555555555555555.part");
    const originalPath = `${partPath}.original`;
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(partPath, "original");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(partPath, staleDate, staleDate);

    const result = await sweepOrphanManagedAttachmentParts({
      attachmentsDir: root,
      nowMs,
      beforeFinalStat: async (candidatePath) => {
        await fs.rename(candidatePath, originalPath);
        await fs.writeFile(candidatePath, "replacement");
        await fs.utimes(candidatePath, staleDate, staleDate);
      },
    });

    expect(result).toMatchObject({ removed: 0, failures: 0 });
    await expect(fs.readFile(partPath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(originalPath, "utf8")).resolves.toBe("original");
  });

  it("preserves an exact-name part replaced after final validation but before quarantine", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-final-race-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const partPath = path.join(stagingDir, "att_v2_66666666666666666666666666666666.part");
    const originalPath = `${partPath}.original`;
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(partPath, "original");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(partPath, staleDate, staleDate);

    const result = await sweepOrphanManagedAttachmentParts({
      attachmentsDir: root,
      nowMs,
      beforeQuarantine: async (candidatePath) => {
        await fs.rename(candidatePath, originalPath);
        await fs.writeFile(candidatePath, "replacement");
        await fs.utimes(candidatePath, staleDate, staleDate);
      },
    });

    expect(result).toMatchObject({ removed: 0, failures: 0 });
    await expect(fs.readFile(partPath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(originalPath, "utf8")).resolves.toBe("original");
  });

  it("recovers a stale quarantine left by a crash after rename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-quarantine-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const partPath = path.join(stagingDir, "att_v2_77777777777777777777777777777777.part");
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(partPath, "orphan");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(partPath, staleDate, staleDate);

    const interrupted = await sweepOrphanManagedAttachmentParts({
      attachmentsDir: root,
      nowMs,
      afterQuarantine: async () => {
        throw new Error("simulated process interruption");
      },
    });

    expect(interrupted).toMatchObject({ removed: 0, failures: 1 });
    await expect(fs.stat(partPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(stagingDir)).toHaveLength(1);

    const recovered = await sweepOrphanManagedAttachmentParts({ attachmentsDir: root, nowMs });

    expect(recovered).toMatchObject({ removed: 1, failures: 0 });
    expect(await fs.readdir(stagingDir)).toEqual([]);
  });

  it("bounds each recovery call while a resumable cursor outlives a large mutating prefix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-progress-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir, { recursive: true });
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    const freshCount = 96;
    const staleCount = 70;
    const freshPartNames: string[] = [];

    for (let index = 0; index < freshCount + staleCount; index += 1) {
      const attachmentId = `att_v2_${index.toString(16).padStart(32, "0")}`;
      const partName = `${attachmentId}.part`;
      const partPath = path.join(stagingDir, partName);
      await fs.writeFile(partPath, index < freshCount ? "fresh" : "stale");
      if (index < freshCount) freshPartNames.push(partName);
      else await fs.utimes(partPath, staleDate, staleDate);
    }

    const recovery = makeManagedAttachmentStagingRecovery();
    const results = [];
    const addedDuringRecoveryName = "att_v2_ffffffffffffffffffffffffffffffff.part";
    try {
      for (let invocation = 0; invocation < 10; invocation += 1) {
        const result = await Effect.runPromise(
          recovery.run({
            attachmentsDir: root,
            nowMs,
            scanLimit: 32,
            maxRemovals: 32,
            invocationScanLimit: 64,
            invocationPassLimit: 2,
            monotonicNow: () => 0,
          }),
        );
        results.push(result);
        expect(result.inspected).toBeLessThanOrEqual(64);
        expect(result.passes).toBeLessThanOrEqual(2);
        expect(result.failures).toBe(0);
        if (invocation === 0) {
          const addedDuringRecovery = path.join(stagingDir, addedDuringRecoveryName);
          await fs.writeFile(addedDuringRecovery, "fresh mutation");
        }
        if (result.exhausted) break;
      }
    } finally {
      await Effect.runPromise(recovery.close);
    }

    expect(results[0]).toMatchObject({ inspected: 64, exhausted: false });
    expect(results.length).toBeGreaterThan(1);
    expect(results.at(-1)?.exhausted).toBe(true);
    expect(results.reduce((total, result) => total + result.removed, 0)).toBe(staleCount);
    expect((await fs.readdir(stagingDir)).sort()).toEqual(
      [...freshPartNames, addedDuringRecoveryName].sort(),
    );
  });

  it("stops at the invocation time budget and resumes the same generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-deadline-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await fs.writeFile(
        path.join(stagingDir, `att_v2_${index.toString(16).padStart(32, "0")}.part`),
        "fresh",
      );
    }
    let clock = 0;
    const recovery = makeManagedAttachmentStagingRecovery();
    try {
      const first = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          scanLimit: 16,
          maxRemovals: 16,
          invocationTimeBudgetMs: 3,
          monotonicNow: () => clock++,
        }),
      );
      const second = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          scanLimit: 16,
          maxRemovals: 16,
          invocationTimeBudgetMs: 100,
          monotonicNow: () => clock++,
        }),
      );

      expect(first).toMatchObject({ inspected: 1, passes: 1, exhausted: false });
      expect(second).toMatchObject({ inspected: 3, passes: 1, exhausted: true });
    } finally {
      await Effect.runPromise(recovery.close);
    }
  });

  it("enumerates recovery entries incrementally without calling readdir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-stream-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const stalePart = path.join(stagingDir, "att_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.part");
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(stalePart, "stale");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(stalePart, staleDate, staleDate);
    const readdir = vi.spyOn(fs, "readdir").mockRejectedValue(new Error("readdir is forbidden"));

    try {
      const result = await Effect.runPromise(
        runManagedAttachmentStagingRecovery({
          attachmentsDir: root,
          nowMs,
          scanLimit: 1,
          maxRemovals: 1,
        }),
      );

      expect(result).toEqual({
        inspected: 1,
        removed: 1,
        failures: 0,
        passes: 1,
        exhausted: true,
      });
      expect(readdir).not.toHaveBeenCalled();
      await expect(fs.stat(stalePart)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      readdir.mockRestore();
    }
  });

  it("serializes stale-part quarantine with the managed upload writer lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-lock-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const partPath = path.join(stagingDir, "att_v2_88888888888888888888888888888888.part");
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(partPath, "orphan");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(partPath, staleDate, staleDate);

    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const writer = withManagedAttachmentStagingPathLock(partPath, async () => {
      lockAcquired();
      await lockReleased;
    });
    await acquired;

    let cleanupEntered = false;
    const cleanup = sweepOrphanManagedAttachmentParts({
      attachmentsDir: root,
      nowMs,
      beforeFinalStat: async () => {
        cleanupEntered = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleanupEntered).toBe(false);
    await expect(fs.readFile(partPath, "utf8")).resolves.toBe("orphan");

    releaseLock();
    await writer;
    await expect(cleanup).resolves.toMatchObject({ removed: 1, failures: 0 });
  });

  it("removes both crash-left staging bytes and the final blob before completing the job", async () => {
    const fixture = await makeFixture();
    const state = makeRepository(fixture.job);
    await Effect.runPromise(
      runManagedAttachmentCleanupBatch.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ManagedAttachmentRepository, state.repository),
            Layer.succeed(ServerConfig, {
              attachmentsDir: fixture.root,
            } as ServerConfigShape),
          ),
        ),
      ),
    );

    await expect(fs.stat(fixture.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(fixture.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.completed).toEqual([fixture.job.attachmentId]);
    expect(state.retried).toEqual([]);
  });

  it("keeps a durable retry when physical deletion fails", async () => {
    const fixture = await makeFixture({ finalPathIsDirectory: true });
    const state = makeRepository(fixture.job);
    await Effect.runPromise(
      runManagedAttachmentCleanupBatch.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ManagedAttachmentRepository, state.repository),
            Layer.succeed(ServerConfig, {
              attachmentsDir: fixture.root,
            } as ServerConfigShape),
          ),
        ),
      ),
    );

    expect(state.completed).toEqual([]);
    expect(state.retried).toEqual([fixture.job.attachmentId]);
  });
});
