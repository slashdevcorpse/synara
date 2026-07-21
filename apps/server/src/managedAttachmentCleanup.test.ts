import fs from "node:fs/promises";
import type { Dir, Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import {
  MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS,
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

function makeDeferredCleanupHarness() {
  const pending = new Set<Promise<void>>();
  return {
    pending,
    track: (completion: Promise<void>) => {
      pending.add(completion);
      void completion.then(
        () => pending.delete(completion),
        () => pending.delete(completion),
      );
    },
    drain: async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
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

  it("shares one total startup deadline across entries and leaves remainder for recovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-startup-deadline-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir);
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    for (let index = 0; index < 3; index += 1) {
      const partPath = path.join(
        stagingDir,
        `att_v2_${(index + 1).toString(16).padStart(32, "0")}.part`,
      );
      await fs.writeFile(partPath, "stale");
      await fs.utimes(partPath, staleDate, staleDate);
    }
    let clock = 0;
    let forceCloseWaitMs: number | null = null;

    const startup = await sweepOrphanManagedAttachmentParts({
      attachmentsDir: root,
      nowMs,
      scanLimit: 16,
      maxRemovals: 16,
      timeBudgetMs: MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS,
      monotonicNow: () => clock,
      beforePinnedSessionRequest: async () => {
        clock += 100;
      },
      waitForPinnedSessionForceClose: async (timeoutMs) => {
        forceCloseWaitMs = timeoutMs;
      },
    });

    expect(startup).toMatchObject({ inspected: 3, removed: 2, failures: 0 });
    expect(forceCloseWaitMs).toBe(0);
    expect(await fs.readdir(stagingDir)).toHaveLength(1);

    const recovery = await Effect.runPromise(
      runManagedAttachmentStagingRecovery({ attachmentsDir: root, nowMs }),
    );
    expect(recovery).toMatchObject({ removed: 1, failures: 0, exhausted: true });
    expect(await fs.readdir(stagingDir)).toEqual([]);
  });

  it("returns at the startup deadline while a directory read is still pending", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-startup-read-deadline-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, ".staging"));
    const opendir = vi.spyOn(fs, "opendir");
    vi.useFakeTimers();
    let clock = 0;
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let markDirectoryClosed!: () => void;
    const directoryClosed = new Promise<void>((resolve) => {
      markDirectoryClosed = resolve;
    });
    const deferredCleanup = new Set<Promise<void>>();
    const trackDeferredCleanup = (completion: Promise<void>) => {
      deferredCleanup.add(completion);
      void completion.then(
        () => deferredCleanup.delete(completion),
        () => deferredCleanup.delete(completion),
      );
    };
    const drainDeferredCleanup = async () => {
      while (deferredCleanup.size > 0) {
        await Promise.allSettled([...deferredCleanup]);
      }
    };
    let closeCalls = 0;

    try {
      const sweep = sweepOrphanManagedAttachmentParts({
        attachmentsDir: root,
        timeBudgetMs: MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS,
        monotonicNow: () => clock,
        onDeferredCleanup: trackDeferredCleanup,
        readDirectoryEntry: async (directory) => {
          const closeDirectory = directory.close.bind(directory);
          vi.spyOn(directory, "close").mockImplementation(async () => {
            closeCalls += 1;
            await closeDirectory();
            markDirectoryClosed();
          });
          markReadStarted();
          await readReleased;
          return null;
        },
      });
      await readStarted;
      clock = MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS - 25;
      await vi.advanceTimersByTimeAsync(clock);
      const result = await sweep;
      clock = MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS;

      expect(result).toEqual({ inspected: 0, removed: 0, failures: 0 });
      expect(closeCalls).toBe(0);
      expect(deferredCleanup.size).toBeGreaterThan(0);
      let drainSettled = false;
      const drain = drainDeferredCleanup().then(() => {
        drainSettled = true;
      });
      await Promise.resolve();
      expect(drainSettled).toBe(false);
      releaseRead();
      await Promise.all([directoryClosed, drain]);
      expect(closeCalls).toBe(1);
      expect(drainSettled).toBe(true);
    } finally {
      releaseRead();
      vi.useRealTimers();
      opendir.mockRestore();
    }
  });

  it("bounds staging verification and consumes its late rejection", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "synara-managed-startup-verify-deadline-"),
    );
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, ".staging"));
    const lstat = vi.spyOn(fs, "lstat");
    let releaseVerification!: () => void;
    const verificationReleased = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    lstat.mockImplementationOnce((async () => {
      markVerificationStarted();
      await verificationReleased;
      throw new Error("simulated late staging verification rejection");
    }) as never);
    vi.useFakeTimers();

    try {
      const sweep = sweepOrphanManagedAttachmentParts({
        attachmentsDir: root,
        timeBudgetMs: MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS,
        monotonicNow: () => 0,
      });
      await verificationStarted;
      await vi.advanceTimersByTimeAsync(MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS - 25);

      await expect(sweep).resolves.toEqual({ inspected: 0, removed: 0, failures: 0 });
      releaseVerification();
      await Promise.resolve();
    } finally {
      releaseVerification();
      vi.useRealTimers();
      lstat.mockRestore();
    }
  });

  it("owns and closes exactly once a directory that opens after the startup deadline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-startup-open-deadline-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir);
    const realDirectory = await fs.opendir(stagingDir);
    const closeDirectory = realDirectory.close.bind(realDirectory);
    let closeCalls = 0;
    vi.spyOn(realDirectory, "close").mockImplementation(async () => {
      closeCalls += 1;
      await closeDirectory();
    });
    let releaseOpen!: () => void;
    const openReleased = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let markOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const opendir = vi.spyOn(fs, "opendir").mockImplementationOnce((async () => {
      markOpenStarted();
      await openReleased;
      return realDirectory;
    }) as never);
    const deferred = makeDeferredCleanupHarness();
    vi.useFakeTimers();

    try {
      const sweep = sweepOrphanManagedAttachmentParts({
        attachmentsDir: root,
        timeBudgetMs: MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS,
        monotonicNow: () => 0,
        onDeferredCleanup: deferred.track,
      });
      await openStarted;
      await vi.advanceTimersByTimeAsync(MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS - 25);

      await expect(sweep).resolves.toEqual({ inspected: 0, removed: 0, failures: 0 });
      expect(closeCalls).toBe(0);
      expect(deferred.pending.size).toBeGreaterThan(0);
      releaseOpen();
      await deferred.drain();
      expect(closeCalls).toBe(1);
    } finally {
      releaseOpen();
      await deferred.drain();
      await realDirectory.close().catch(() => undefined);
      vi.useRealTimers();
      opendir.mockRestore();
    }
  });

  it("starts one tracked directory close when post-open verification times out", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-startup-post-open-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir);
    const stagingStat = await fs.lstat(stagingDir, { bigint: true });
    const opendir = vi.spyOn(fs, "opendir");
    const lstat = vi.spyOn(fs, "lstat");
    lstat.mockResolvedValueOnce(stagingStat as never);
    lstat.mockResolvedValueOnce(stagingStat as never);
    let releaseVerification!: () => void;
    const verificationReleased = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    let releaseClose!: () => void;
    const closeReleased = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeCalls = 0;
    lstat.mockImplementationOnce((async () => {
      const openResult = opendir.mock.results[0];
      if (!openResult || openResult.type !== "return") {
        throw new Error("expected the staging directory to be open");
      }
      const directory = await openResult.value;
      const closeDirectory = directory.close.bind(directory);
      vi.spyOn(directory, "close").mockImplementation(async () => {
        closeCalls += 1;
        await closeReleased;
        await closeDirectory();
      });
      markVerificationStarted();
      await verificationReleased;
      return stagingStat;
    }) as never);
    const deferred = makeDeferredCleanupHarness();
    vi.useFakeTimers();

    try {
      const sweep = sweepOrphanManagedAttachmentParts({
        attachmentsDir: root,
        timeBudgetMs: MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS,
        monotonicNow: () => 0,
        onDeferredCleanup: deferred.track,
      });
      await verificationStarted;
      await vi.advanceTimersByTimeAsync(MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS - 25);

      await expect(sweep).resolves.toEqual({ inspected: 0, removed: 0, failures: 0 });
      expect(closeCalls).toBe(1);
      expect(deferred.pending.size).toBeGreaterThan(0);
      let drainSettled = false;
      const drain = deferred.drain().then(() => {
        drainSettled = true;
      });
      await Promise.resolve();
      expect(drainSettled).toBe(false);
      releaseClose();
      await drain;
      expect(drainSettled).toBe(true);
      releaseVerification();
      await Promise.resolve();
    } finally {
      releaseClose();
      releaseVerification();
      await deferred.drain();
      vi.useRealTimers();
      lstat.mockRestore();
      opendir.mockRestore();
    }
  });

  it("does not let an active upload-path lock stall startup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-startup-lock-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const stalePart = path.join(stagingDir, "att_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.part");
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(stalePart, "locked stale part");
    const staleDate = new Date(Date.now() - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(stalePart, staleDate, staleDate);
    const repository = {
      markExpiredForCleanup: () => Effect.succeed([]),
      leaseCleanup: () => Effect.succeed([]),
      compactDeleted: () => Effect.succeed([]),
      listFailedCleanup: () => Effect.succeed([]),
    } as unknown as ManagedAttachmentRepositoryShape;

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
    await writerAcquired;
    const service = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ManagedAttachmentCleanup;
          return true;
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const availableWhileLocked = await Promise.race([
        service,
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 750);
        }),
      ]);
      expect(availableWhileLocked).toBe(true);
      await expect(fs.readFile(stalePart, "utf8")).resolves.toBe("locked stale part");
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseWriter();
      await Promise.all([writer, service]);
    }

    const recovered = await Effect.runPromise(
      runManagedAttachmentStagingRecovery({ attachmentsDir: root }),
    );
    expect(recovered).toMatchObject({ removed: 1, failures: 0, exhausted: true });
    await expect(fs.stat(stalePart)).rejects.toMatchObject({ code: "ENOENT" });
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
                  timeout = setTimeout(() => resolve(false), 750);
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

  it("closes the direct-sweep directory when helper readiness fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-ready-failure-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, ".staging"));
    const opendir = vi.spyOn(fs, "opendir");
    let closeCalls = 0;
    let releaseReady!: () => void;
    const readyReleased = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let markReadyReached!: () => void;
    const readyReached = new Promise<void>((resolve) => {
      markReadyReached = resolve;
    });

    try {
      const pending = sweepOrphanManagedAttachmentParts({
        attachmentsDir: root,
        beforePinnedSessionReady: async () => {
          const openResult = opendir.mock.results[0];
          if (!openResult || openResult.type !== "return") {
            throw new Error("expected the staging directory to be open");
          }
          const directory = await openResult.value;
          const closeDirectory = directory.close.bind(directory);
          vi.spyOn(directory, "close").mockImplementation(async () => {
            closeCalls += 1;
            await closeDirectory();
          });
          markReadyReached();
          await readyReleased;
          throw new Error("simulated helper ready failure");
        },
      });
      const observed = pending.then(
        () => null,
        (cause: unknown) => cause,
      );
      await readyReached;
      releaseReady();

      await expect(observed).resolves.toMatchObject({
        message: "simulated helper ready failure",
      });
      expect(closeCalls).toBe(1);
    } finally {
      opendir.mockRestore();
    }
  });

  it("closes the recovery directory when helper readiness fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-recovery-ready-failure-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, ".staging"));
    const opendir = vi.spyOn(fs, "opendir");
    const recovery = makeManagedAttachmentStagingRecovery();
    let closeCalls = 0;
    let releaseReady!: () => void;
    const readyReleased = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let markReadyReached!: () => void;
    const readyReached = new Promise<void>((resolve) => {
      markReadyReached = resolve;
    });

    try {
      const pending = Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          beforePinnedSessionReady: async () => {
            const openResult = opendir.mock.results[0];
            if (!openResult || openResult.type !== "return") {
              throw new Error("expected the staging directory to be open");
            }
            const directory = await openResult.value;
            const closeDirectory = directory.close.bind(directory);
            vi.spyOn(directory, "close").mockImplementation(async () => {
              closeCalls += 1;
              await closeDirectory();
            });
            markReadyReached();
            await readyReleased;
            throw new Error("simulated recovery helper ready failure");
          },
        }),
      );
      const observed = pending.then(
        () => null,
        (cause: unknown) => cause,
      );
      await readyReached;
      releaseReady();

      await expect(observed).resolves.toMatchObject({
        message: "simulated recovery helper ready failure",
      });
      expect(closeCalls).toBe(1);
    } finally {
      await Effect.runPromise(recovery.close);
      opendir.mockRestore();
    }
  });

  it("serializes direct recovery runs, starts queued budgets on execution, and drains on close", async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-recovery-queue-a-"));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-recovery-queue-b-"));
    temporaryRoots.push(firstRoot, secondRoot);
    await Promise.all([
      fs.mkdir(path.join(firstRoot, ".staging")),
      fs.mkdir(path.join(secondRoot, ".staging")),
    ]);

    const originalOpendir = fs.opendir;
    const directoryCloseCalls: number[] = [];
    const opendir = vi.spyOn(fs, "opendir").mockImplementation((async (target: string) => {
      const directory = await originalOpendir(target);
      const directoryIndex = directoryCloseCalls.push(0) - 1;
      const closeDirectory = directory.close.bind(directory);
      vi.spyOn(directory, "close").mockImplementation(async () => {
        directoryCloseCalls[directoryIndex] = (directoryCloseCalls[directoryIndex] ?? 0) + 1;
        await closeDirectory();
      });
      return directory;
    }) as never);
    const recovery = makeManagedAttachmentStagingRecovery();
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let secondEntered = false;
    let queuedClock = 0;

    const first = Effect.runPromise(
      recovery.run({
        attachmentsDir: firstRoot,
        monotonicNow: () => 0,
        readDirectoryEntry: async () => {
          markFirstEntered();
          await firstReleased;
          throw new Error("simulated first queued run failure");
        },
      }),
    );
    const firstOutcome = first.then(
      () => ({ _tag: "Succeeded" as const }),
      (cause: unknown) => ({ _tag: "Failed" as const, cause }),
    );

    try {
      await firstEntered;
      const second = Effect.runPromise(
        recovery.run({
          attachmentsDir: secondRoot,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => queuedClock,
          beforePinnedSessionReady: async () => {
            secondEntered = true;
            expect(queuedClock).toBe(10_000);
          },
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondEntered).toBe(false);
      expect(opendir).toHaveBeenCalledTimes(1);

      queuedClock = 10_000;
      let closeSettled = false;
      const close = Effect.runPromise(recovery.close).then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      releaseFirst();
      const [failedFirst, secondResult] = await Promise.all([firstOutcome, second]);
      expect(failedFirst).toMatchObject({
        _tag: "Failed",
        cause: { message: "simulated first queued run failure" },
      });
      expect(secondResult).toEqual({
        inspected: 0,
        removed: 0,
        failures: 0,
        passes: 0,
        exhausted: true,
      });
      await close;

      expect(secondEntered).toBe(true);
      expect(opendir).toHaveBeenCalledTimes(2);
      expect(directoryCloseCalls).toEqual([1, 1]);
      expect(closeSettled).toBe(true);
      await expect(Effect.runPromise(recovery.run({ attachmentsDir: firstRoot }))).rejects.toThrow(
        "Managed attachment staging recovery is closed.",
      );
    } finally {
      releaseFirst();
      await firstOutcome;
      await Effect.runPromise(recovery.close);
      opendir.mockRestore();
    }
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

  it("recomputes the stale cutoff for each run while reusing the same cursor and helper", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-aging-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir);
    const prefixName = "att_v2_41414141414141414141414141414141.part";
    const agingName = "att_v2_42424242424242424242424242424242.part";
    const agingPart = path.join(stagingDir, agingName);
    await fs.writeFile(path.join(stagingDir, prefixName), "fresh prefix");
    await fs.writeFile(agingPart, "aging");
    const firstNowMs = Date.now();
    const agingDate = new Date(firstNowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS + 1_000);
    await fs.utimes(agingPart, agingDate, agingDate);
    const entries = [
      { name: prefixName } as unknown as Dirent,
      { name: agingName } as unknown as Dirent,
    ];
    let entryIndex = 0;
    let cursorDirectory: unknown;
    let helperStarts = 0;
    const opendir = vi.spyOn(fs, "opendir");
    const recovery = makeManagedAttachmentStagingRecovery();
    const readDirectoryEntry = async (directory: Dir): Promise<Dirent | null> => {
      if (cursorDirectory === undefined) cursorDirectory = directory;
      else expect(directory).toBe(cursorDirectory);
      return entries[entryIndex++] ?? null;
    };

    try {
      const first = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          nowMs: firstNowMs,
          scanLimit: 1,
          invocationScanLimit: 1,
          monotonicNow: () => 0,
          readDirectoryEntry,
          beforePinnedSessionReady: async () => {
            helperStarts += 1;
          },
        }),
      );
      await expect(fs.readFile(agingPart, "utf8")).resolves.toBe("aging");
      const second = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          nowMs: firstNowMs + 2_000,
          scanLimit: 1,
          invocationScanLimit: 1,
          monotonicNow: () => 0,
          readDirectoryEntry,
          beforePinnedSessionReady: async () => {
            helperStarts += 1;
          },
        }),
      );

      expect(first).toMatchObject({ inspected: 1, removed: 0, exhausted: false });
      expect(second).toMatchObject({ inspected: 1, removed: 1, exhausted: false });
      expect(opendir).toHaveBeenCalledTimes(1);
      expect(helperStarts).toBe(1);
      await expect(fs.stat(agingPart)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Effect.runPromise(recovery.close);
      opendir.mockRestore();
    }
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
    let firstEntryValidated = false;
    const originalLstat = fs.lstat;
    const lstat = vi.spyOn(fs, "lstat");
    lstat.mockImplementation((async (target: string, options: { bigint: true }) => {
      const result = await originalLstat(target, options);
      if (target.endsWith(".part")) {
        firstEntryValidated = true;
      }
      return result;
    }) as never);
    const recovery = makeManagedAttachmentStagingRecovery();
    try {
      const first = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          scanLimit: 16,
          maxRemovals: 16,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => (firstEntryValidated ? 250 : 0),
        }),
      );
      const second = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          scanLimit: 16,
          maxRemovals: 16,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => 0,
        }),
      );

      expect(first).toMatchObject({ inspected: 1, passes: 1, exhausted: false });
      expect(second).toMatchObject({ inspected: 3, passes: 1, exhausted: true });
    } finally {
      await Effect.runPromise(recovery.close);
      lstat.mockRestore();
    }
  });

  it("does not open another recovery cursor until a timed-out directory read settles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-recovery-read-deadline-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, ".staging"));
    const opendir = vi.spyOn(fs, "opendir");
    const recovery = makeManagedAttachmentStagingRecovery();
    let clock = 0;
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let closeCalls = 0;

    try {
      const expired = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => clock,
          readDirectoryEntry: async (directory) => {
            const closeDirectory = directory.close.bind(directory);
            vi.spyOn(directory, "close").mockImplementation(async () => {
              closeCalls += 1;
              await closeDirectory();
            });
            clock = 250;
            await readReleased;
            return null;
          },
        }),
      );
      expect(expired).toEqual({
        inspected: 0,
        removed: 0,
        failures: 0,
        passes: 0,
        exhausted: false,
      });
      expect(opendir).toHaveBeenCalledTimes(1);
      expect(closeCalls).toBe(0);

      clock = 0;
      const deferred = await Effect.runPromise(
        recovery.run({ attachmentsDir: root, invocationTimeBudgetMs: 250 }),
      );
      expect(deferred).toEqual({
        inspected: 0,
        removed: 0,
        failures: 0,
        passes: 0,
        exhausted: false,
      });
      expect(opendir).toHaveBeenCalledTimes(1);

      let closeSettled = false;
      const close = Effect.runPromise(recovery.close).then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      releaseRead();
      await close;
      expect(closeCalls).toBe(1);
      expect(closeSettled).toBe(true);
      const resumed = await Effect.runPromise(
        runManagedAttachmentStagingRecovery({
          attachmentsDir: root,
          invocationTimeBudgetMs: 250,
        }),
      );
      expect(resumed).toMatchObject({ inspected: 0, failures: 0, exhausted: true });
      expect(opendir).toHaveBeenCalledTimes(2);
    } finally {
      releaseRead();
      await Effect.runPromise(recovery.close);
      opendir.mockRestore();
    }
  });

  it("keeps recovery close pending until a directory opened after its deadline is closed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-recovery-open-deadline-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir);
    const realDirectory = await fs.opendir(stagingDir);
    const closeDirectory = realDirectory.close.bind(realDirectory);
    let closeCalls = 0;
    vi.spyOn(realDirectory, "close").mockImplementation(async () => {
      closeCalls += 1;
      await closeDirectory();
    });
    let releaseOpen!: () => void;
    const openReleased = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let markOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const opendir = vi.spyOn(fs, "opendir").mockImplementationOnce((async () => {
      markOpenStarted();
      await openReleased;
      return realDirectory;
    }) as never);
    const recovery = makeManagedAttachmentStagingRecovery();
    vi.useFakeTimers();

    try {
      const running = Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => 0,
        }),
      );
      await openStarted;
      await vi.advanceTimersByTimeAsync(225);
      await expect(running).resolves.toEqual({
        inspected: 0,
        removed: 0,
        failures: 0,
        passes: 0,
        exhausted: false,
      });

      let closeSettled = false;
      const close = Effect.runPromise(recovery.close).then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      expect(closeCalls).toBe(0);
      releaseOpen();
      await close;
      expect(closeSettled).toBe(true);
      expect(closeCalls).toBe(1);
      await fs.rm(root, { recursive: true });
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseOpen();
      await Effect.runPromise(recovery.close);
      await realDirectory.close().catch(() => undefined);
      vi.useRealTimers();
      opendir.mockRestore();
    }
  });

  it("seals recovery close until an in-flight cursor assignment is fully torn down", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-recovery-close-race-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, ".staging"));
    const opendir = vi.spyOn(fs, "opendir");
    const recovery = makeManagedAttachmentStagingRecovery();
    const deferredCleanup = new Set<Promise<void>>();
    let releaseReady!: () => void;
    const readyReleased = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let markReadyReached!: () => void;
    const readyReached = new Promise<void>((resolve) => {
      markReadyReached = resolve;
    });
    let closeCalls = 0;

    try {
      const running = Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          onDeferredCleanup: (completion) => {
            deferredCleanup.add(completion);
            void completion.then(
              () => deferredCleanup.delete(completion),
              () => deferredCleanup.delete(completion),
            );
          },
          beforePinnedSessionReady: async () => {
            const openResult = opendir.mock.results[0];
            if (!openResult || openResult.type !== "return") {
              throw new Error("expected the staging directory to be open");
            }
            const directory = await openResult.value;
            const closeDirectory = directory.close.bind(directory);
            vi.spyOn(directory, "close").mockImplementation(async () => {
              closeCalls += 1;
              await closeDirectory();
            });
            markReadyReached();
            await readyReleased;
          },
        }),
      );
      await readyReached;

      let closeSettled = false;
      const close = Effect.runPromise(recovery.close).then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      releaseReady();
      await Promise.all([running, close]);
      await Promise.allSettled([...deferredCleanup]);

      expect(closeSettled).toBe(true);
      expect(closeCalls).toBe(1);
      expect(opendir).toHaveBeenCalledTimes(1);
      await expect(Effect.runPromise(recovery.run({ attachmentsDir: root }))).rejects.toThrow(
        "Managed attachment staging recovery is closed.",
      );
    } finally {
      releaseReady();
      await Effect.runPromise(recovery.close);
      opendir.mockRestore();
    }
  });

  it("bounds helper startup by the recovery deadline and discards its directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-staging-ready-deadline-"));
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    await fs.mkdir(stagingDir);
    await fs.writeFile(
      path.join(stagingDir, "att_v2_91919191919191919191919191919191.part"),
      "fresh",
    );
    const opendir = vi.spyOn(fs, "opendir");
    const recovery = makeManagedAttachmentStagingRecovery();
    let clock = 0;
    let closeCalls = 0;

    try {
      const expired = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => clock,
          beforePinnedSessionReady: async () => {
            const openResult = opendir.mock.results[0];
            if (!openResult || openResult.type !== "return") {
              throw new Error("expected the staging directory to be open");
            }
            const directory = await openResult.value;
            const closeDirectory = directory.close.bind(directory);
            vi.spyOn(directory, "close").mockImplementation(async () => {
              closeCalls += 1;
              await closeDirectory();
            });
            clock = 250;
          },
        }),
      );

      expect(expired).toEqual({
        inspected: 0,
        removed: 0,
        failures: 0,
        passes: 0,
        exhausted: false,
      });
      expect(closeCalls).toBe(1);

      clock = 0;
      const resumed = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => clock,
        }),
      );
      expect(resumed).toMatchObject({ inspected: 1, failures: 0, exhausted: true });
      expect(opendir).toHaveBeenCalledTimes(2);
    } finally {
      await Effect.runPromise(recovery.close);
      opendir.mockRestore();
    }
  });

  it("bounds each helper request by the recovery deadline and recreates the cursor", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "synara-managed-staging-request-deadline-"),
    );
    temporaryRoots.push(root);
    const stagingDir = path.join(root, ".staging");
    const stalePart = path.join(stagingDir, "att_v2_92929292929292929292929292929292.part");
    await fs.mkdir(stagingDir);
    await fs.writeFile(stalePart, "stale");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS - 1_000);
    await fs.utimes(stalePart, staleDate, staleDate);
    const opendir = vi.spyOn(fs, "opendir");
    const recovery = makeManagedAttachmentStagingRecovery();
    let clock = 0;
    let forceCloseWaitMs: number | null = null;

    try {
      const expired = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          nowMs,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => clock,
          beforePinnedSessionRequest: async () => {
            clock = 250;
          },
          waitForPinnedSessionForceClose: async (timeoutMs) => {
            forceCloseWaitMs = timeoutMs;
            await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
          },
        }),
      );

      expect(expired).toEqual({
        inspected: 1,
        removed: 0,
        failures: 0,
        passes: 1,
        exhausted: false,
      });
      expect(forceCloseWaitMs).toBe(0);
      await expect(fs.readFile(stalePart, "utf8")).resolves.toBe("stale");

      clock = 0;
      const resumed = await Effect.runPromise(
        recovery.run({
          attachmentsDir: root,
          nowMs,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => clock,
        }),
      );
      expect(resumed).toMatchObject({ inspected: 1, removed: 1, failures: 0, exhausted: true });
      expect(opendir).toHaveBeenCalledTimes(2);
      await expect(fs.stat(stalePart)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Effect.runPromise(recovery.close);
      opendir.mockRestore();
    }
  });

  it("force-closes an invalid recovery cursor within the remaining deadline", async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-stale-cursor-a-"));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-stale-cursor-b-"));
    temporaryRoots.push(firstRoot, secondRoot);
    for (const root of [firstRoot, secondRoot]) {
      const stagingDir = path.join(root, ".staging");
      await fs.mkdir(stagingDir);
      for (let index = 0; index < 2; index += 1) {
        await fs.writeFile(
          path.join(stagingDir, `att_v2_${(index + 10).toString(16).padStart(32, "0")}.part`),
          "fresh",
        );
      }
    }
    let forceCloseWaitMs: number | null = null;
    const recovery = makeManagedAttachmentStagingRecovery();
    try {
      const first = await Effect.runPromise(
        recovery.run({
          attachmentsDir: firstRoot,
          invocationScanLimit: 1,
          waitForPinnedSessionForceClose: async (timeoutMs) => {
            forceCloseWaitMs = timeoutMs;
          },
        }),
      );
      expect(first).toMatchObject({ inspected: 1, exhausted: false });

      const times = [0, 240, 240, 240];
      let timeIndex = 0;
      await Effect.runPromise(
        recovery.run({
          attachmentsDir: secondRoot,
          invocationTimeBudgetMs: 250,
          monotonicNow: () => times[Math.min(timeIndex++, times.length - 1)] ?? 240,
        }),
      );

      expect(forceCloseWaitMs).toBe(10);
    } finally {
      await Effect.runPromise(recovery.close);
    }
  });

  it("enumerates staging entries incrementally without calling readdir", async () => {
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
      const result = await sweepOrphanManagedAttachmentParts({
        attachmentsDir: root,
        nowMs,
        scanLimit: 1,
        maxRemovals: 1,
      });

      expect(result).toEqual({
        inspected: 1,
        removed: 1,
        failures: 0,
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
