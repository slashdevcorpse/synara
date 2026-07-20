import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, Semaphore, ServiceMap } from "effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths";
import { ServerConfig } from "./config";
import {
  MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
  ManagedAttachmentRepository,
  type ManagedAttachmentCleanupJob,
} from "./persistence/Services/ManagedAttachments";
import { withManagedAttachmentStagingPathLock } from "./managedAttachmentStore";
import { resolveRealPathWithinRoot } from "./workspace/realPathContainment";

export const MANAGED_ATTACHMENT_WRITING_LEASE_MS = 10 * 60 * 1_000;
export const MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE = 64;
export const MANAGED_ATTACHMENT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CLEANUP_LEASE_MS = 60_000;
const CLEANUP_INTERVAL = "5 minutes";

function cleanupRetryDelayMs(attemptCount: number): number {
  return Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(12, attemptCount));
}

function isMissingFileError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
}

const MANAGED_ATTACHMENT_ID_PATTERN = /^att_v2_[0-9a-f]{32}$/u;
const MANAGED_ATTACHMENT_STAGING_PART_PATTERN = /^att_v2_[0-9a-f]{32}\.part$/u;
const MANAGED_ATTACHMENT_STAGING_QUARANTINE_PATTERN =
  /^(att_v2_[0-9a-f]{32}\.part)\.cleanup-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANAGED_ATTACHMENT_STAGING_SWEEP_SCAN_LIMIT = MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE * 4;

export interface ManagedAttachmentStagingSweepResult {
  readonly inspected: number;
  readonly removed: number;
  readonly failures: number;
}

export interface ManagedAttachmentStagingSweepInput {
  readonly attachmentsDir: string;
  readonly nowMs?: number;
  readonly maxRemovals?: number;
  readonly scanLimit?: number;
  /** Test seam for a replacement race between the two identity checks. */
  readonly beforeFinalStat?: (candidatePath: string) => Promise<void>;
  /** Test seam for a replacement after final validation but before quarantine. */
  readonly beforeQuarantine?: (candidatePath: string) => Promise<void>;
  /** Test seam for a crash after quarantine but before unlink. */
  readonly afterQuarantine?: (candidatePath: string, quarantinePath: string) => Promise<void>;
}

type VerifiedStagingDirectory =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unsafe" }
  | { readonly _tag: "Verified"; readonly realPath: string };

async function resolveVerifiedStagingDirectory(
  attachmentsDir: string,
): Promise<VerifiedStagingDirectory> {
  const stagingDir = path.join(attachmentsDir, ".staging");
  let stagingStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stagingStat = await fs.lstat(stagingDir);
  } catch (cause) {
    if (isMissingFileError(cause)) return { _tag: "Missing" };
    throw cause;
  }
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
    return { _tag: "Unsafe" };
  }

  let realStagingDir: string | null;
  try {
    realStagingDir = await resolveRealPathWithinRoot(attachmentsDir, stagingDir);
  } catch (cause) {
    if (isMissingFileError(cause)) return { _tag: "Missing" };
    throw cause;
  }
  return realStagingDir === null
    ? { _tag: "Unsafe" }
    : { _tag: "Verified", realPath: realStagingDir };
}

function stagingEntryPartName(entryName: string): string | null {
  if (MANAGED_ATTACHMENT_STAGING_PART_PATTERN.test(entryName)) return entryName;
  return MANAGED_ATTACHMENT_STAGING_QUARANTINE_PATTERN.exec(entryName)?.[1] ?? null;
}

function isSameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function processManagedAttachmentStagingEntry(input: {
  readonly sweep: ManagedAttachmentStagingSweepInput;
  readonly realStagingDir: string;
  readonly entryName: string;
  readonly staleBeforeMs: number;
}): Promise<{ readonly removed: number; readonly failures: number }> {
  const partName = stagingEntryPartName(input.entryName);
  if (partName === null) return { removed: 0, failures: 0 };

  const candidatePath = path.join(input.realStagingDir, input.entryName);
  const partPath = path.join(input.realStagingDir, partName);
  let removed = 0;
  let failures = 0;
  try {
    await withManagedAttachmentStagingPathLock(partPath, async () => {
      const firstStat = await fs.lstat(candidatePath, { bigint: true });
      if (
        !firstStat.isFile() ||
        firstStat.isSymbolicLink() ||
        Number(firstStat.mtimeMs) >= input.staleBeforeMs
      ) {
        return;
      }
      const realCandidate = await resolveRealPathWithinRoot(input.realStagingDir, candidatePath);
      if (realCandidate === null) {
        failures += 1;
        return;
      }

      await input.sweep.beforeFinalStat?.(realCandidate);
      const finalStat = await fs.lstat(realCandidate, { bigint: true });
      if (
        !finalStat.isFile() ||
        finalStat.isSymbolicLink() ||
        !isSameFileIdentity(firstStat, finalStat) ||
        Number(finalStat.mtimeMs) >= input.staleBeforeMs
      ) {
        return;
      }

      if (input.entryName !== partName) {
        await fs.unlink(realCandidate);
        removed += 1;
        return;
      }

      await input.sweep.beforeQuarantine?.(realCandidate);
      const preQuarantineStat = await fs.lstat(realCandidate, { bigint: true });
      if (
        !preQuarantineStat.isFile() ||
        preQuarantineStat.isSymbolicLink() ||
        !isSameFileIdentity(finalStat, preQuarantineStat) ||
        Number(preQuarantineStat.mtimeMs) >= input.staleBeforeMs
      ) {
        return;
      }

      const quarantinePath = `${realCandidate}.cleanup-${randomUUID()}`;
      await fs.rename(realCandidate, quarantinePath);
      const quarantinedStat = await fs.lstat(quarantinePath, { bigint: true });
      if (
        !quarantinedStat.isFile() ||
        quarantinedStat.isSymbolicLink() ||
        !isSameFileIdentity(preQuarantineStat, quarantinedStat) ||
        Number(quarantinedStat.mtimeMs) >= input.staleBeforeMs
      ) {
        await fs.rename(quarantinePath, realCandidate).catch(() => undefined);
        return;
      }

      await input.sweep.afterQuarantine?.(realCandidate, quarantinePath);
      try {
        await fs.unlink(quarantinePath);
        removed += 1;
      } catch (cause) {
        await fs.rename(quarantinePath, realCandidate).catch(() => undefined);
        throw cause;
      }
    });
  } catch (cause) {
    if (!isMissingFileError(cause)) failures += 1;
  }
  return { removed, failures };
}

/**
 * Remove crash-left upload parts even when the process died before a database
 * reservation was persisted. Work is intentionally bounded for startup.
 */
export async function sweepOrphanManagedAttachmentParts(
  input: ManagedAttachmentStagingSweepInput,
): Promise<ManagedAttachmentStagingSweepResult> {
  const emptyResult = { inspected: 0, removed: 0, failures: 0 } as const;
  const verifiedStagingDir = await resolveVerifiedStagingDirectory(input.attachmentsDir);
  if (verifiedStagingDir._tag === "Missing") return emptyResult;
  if (verifiedStagingDir._tag === "Unsafe") {
    return { inspected: 0, removed: 0, failures: 1 };
  }

  const nowMs = input.nowMs ?? Date.now();
  const staleBeforeMs = nowMs - MANAGED_ATTACHMENT_WRITING_LEASE_MS;
  const maxRemovals = Math.max(
    0,
    Math.floor(input.maxRemovals ?? MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE),
  );
  const scanLimit = Math.max(
    0,
    Math.floor(input.scanLimit ?? MANAGED_ATTACHMENT_STAGING_SWEEP_SCAN_LIMIT),
  );
  let inspected = 0;
  let removed = 0;
  let failures = 0;
  if (scanLimit === 0 || maxRemovals === 0) return emptyResult;
  const directory = await fs.opendir(verifiedStagingDir.realPath);
  try {
    while (inspected < scanLimit && removed < maxRemovals) {
      const entry = await directory.read();
      if (entry === null) break;
      inspected += 1;
      const result = await processManagedAttachmentStagingEntry({
        sweep: input,
        realStagingDir: verifiedStagingDir.realPath,
        entryName: entry.name,
        staleBeforeMs,
      });
      removed += result.removed;
      failures += result.failures;
    }
  } finally {
    await directory.close();
  }

  return { inspected, removed, failures };
}

export interface ManagedAttachmentStagingRecoveryResult extends ManagedAttachmentStagingSweepResult {
  readonly passes: number;
}

/**
 * Recover the finite entry-name snapshot visible when this run begins through
 * bounded, yielding passes. New uploads cannot keep a recovery run alive, and
 * unremovable prefix entries cannot prevent later stale parts from being seen.
 */
export const runManagedAttachmentStagingRecovery = (
  input: ManagedAttachmentStagingSweepInput,
): Effect.Effect<ManagedAttachmentStagingRecoveryResult, unknown> =>
  Effect.gen(function* () {
    const maxRemovals = Math.max(
      0,
      Math.floor(input.maxRemovals ?? MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE),
    );
    const scanLimit = Math.max(
      0,
      Math.floor(input.scanLimit ?? MANAGED_ATTACHMENT_STAGING_SWEEP_SCAN_LIMIT),
    );
    let inspected = 0;
    let removed = 0;
    let failures = 0;
    let passes = 0;
    if (scanLimit === 0 || maxRemovals === 0) {
      return { inspected, removed, failures, passes };
    }

    const verifiedStagingDir = yield* Effect.tryPromise({
      try: () => resolveVerifiedStagingDirectory(input.attachmentsDir),
      catch: (cause) => cause,
    });
    if (verifiedStagingDir._tag === "Missing") {
      return { inspected, removed, failures, passes };
    }
    if (verifiedStagingDir._tag === "Unsafe") {
      return { inspected, removed, failures: 1, passes };
    }

    const entries = yield* Effect.tryPromise({
      try: () => fs.readdir(verifiedStagingDir.realPath),
      catch: (cause) => cause,
    });
    const staleBeforeMs = (input.nowMs ?? Date.now()) - MANAGED_ATTACHMENT_WRITING_LEASE_MS;
    let cursor = 0;
    while (cursor < entries.length) {
      let passInspected = 0;
      let passRemoved = 0;
      let passFailures = 0;
      while (cursor < entries.length && passInspected < scanLimit && passRemoved < maxRemovals) {
        const entryName = entries[cursor];
        cursor += 1;
        passInspected += 1;
        if (entryName === undefined) continue;
        const result = yield* Effect.tryPromise({
          try: () =>
            processManagedAttachmentStagingEntry({
              sweep: input,
              realStagingDir: verifiedStagingDir.realPath,
              entryName,
              staleBeforeMs,
            }),
          catch: (cause) => cause,
        });
        passRemoved += result.removed;
        passFailures += result.failures;
      }
      passes += 1;
      inspected += passInspected;
      removed += passRemoved;
      failures += passFailures;
      if (cursor >= entries.length) break;
      yield* Effect.yieldNow;
    }
    return { inspected, removed, failures, passes };
  });

const unlinkIfPresent = (filePath: string) =>
  Effect.tryPromise({
    try: () => fs.unlink(filePath),
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => (isMissingFileError(cause) ? Effect.void : Effect.fail(cause))));

const unlinkManagedStagingIfPresent = (filePath: string) =>
  Effect.tryPromise({
    try: () =>
      withManagedAttachmentStagingPathLock(filePath, async () => {
        await fs.unlink(filePath).catch((cause) => {
          if (!isMissingFileError(cause)) throw cause;
        });
      }),
    catch: (cause) => cause,
  });

const cleanupErrorMessage = (cause: unknown) => String(cause).slice(0, 2_000);

export const runManagedAttachmentCleanupBatch = Effect.gen(function* () {
  const repository = yield* ManagedAttachmentRepository;
  const config = yield* ServerConfig;
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseOwner = `attachment-cleanup-${process.pid}-${randomUUID()}`;

  yield* repository.markExpiredForCleanup({
    now,
    uploadingCutoff: new Date(
      nowDate.getTime() - MANAGED_ATTACHMENT_WRITING_LEASE_MS,
    ).toISOString(),
    limit: MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE,
  });
  const jobs = yield* repository.leaseCleanup({
    leaseOwner,
    now,
    leaseExpiresAt: new Date(nowDate.getTime() + CLEANUP_LEASE_MS).toISOString(),
    limit: MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE,
  });

  const persistCleanupFailure = (job: ManagedAttachmentCleanupJob, error: string) =>
    repository
      .retryCleanup({
        attachmentId: job.attachmentId,
        expectedLeaseOwner: leaseOwner,
        error,
        nextAttemptAt: new Date(
          nowDate.getTime() + cleanupRetryDelayMs(job.attemptCount),
        ).toISOString(),
        updatedAt: now,
      })
      .pipe(
        Effect.tap((persisted) =>
          persisted && job.attemptCount + 1 >= MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS
            ? Effect.logError("managed attachment cleanup reached its retry ceiling", {
                attachmentId: job.attachmentId,
                reason: job.reason,
                attemptCount: job.attemptCount + 1,
                error,
              })
            : Effect.void,
        ),
      );

  yield* Effect.forEach(
    jobs,
    (job) =>
      Effect.gen(function* () {
        const filePath = resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: job.relativePath,
        });
        if (!filePath) {
          yield* persistCleanupFailure(job, "Managed attachment path is invalid.");
          return;
        }
        const stagingPath = MANAGED_ATTACHMENT_ID_PATTERN.test(job.attachmentId)
          ? path.join(config.attachmentsDir, ".staging", `${job.attachmentId}.part`)
          : null;
        const deletion = yield* Effect.exit(
          Effect.gen(function* () {
            if (stagingPath) yield* unlinkManagedStagingIfPresent(stagingPath);
            yield* unlinkIfPresent(filePath);
          }),
        );
        if (deletion._tag === "Success") {
          yield* repository.completeCleanup({
            attachmentId: job.attachmentId,
            expectedLeaseOwner: leaseOwner,
            disposition: "deleted",
            completedAt: now,
          });
          return;
        }
        yield* persistCleanupFailure(job, cleanupErrorMessage(deletion.cause));
      }),
    { concurrency: 4, discard: true },
  );
  const compacted = yield* repository.compactDeleted({
    deletedBefore: new Date(
      nowDate.getTime() - MANAGED_ATTACHMENT_TOMBSTONE_RETENTION_MS,
    ).toISOString(),
    limit: MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE,
  });
  return Math.max(jobs.length, compacted.length);
});

export interface ManagedAttachmentCleanupShape {
  /** Run every currently-due cleanup job after attachment-producing work has stopped. */
  readonly drain: Effect.Effect<void>;
}

export class ManagedAttachmentCleanup extends ServiceMap.Service<
  ManagedAttachmentCleanup,
  ManagedAttachmentCleanupShape
>()("synara/ManagedAttachmentCleanup") {}

const drainCleanupBatches = <E, R>(
  runBatch: Effect.Effect<number, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    let processed = MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE;
    while (processed === MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE) {
      processed = yield* runBatch;
    }
  });

export const drainManagedAttachmentCleanup = drainCleanupBatches(runManagedAttachmentCleanupBatch);

export const ManagedAttachmentCleanupLive = Layer.effect(
  ManagedAttachmentCleanup,
  Effect.gen(function* () {
    const repository = yield* ManagedAttachmentRepository;
    const config = yield* ServerConfig;
    const cleanupLock = yield* Semaphore.make(1);
    const stagingRecoveryLock = yield* Semaphore.make(1);
    const runBatch = cleanupLock.withPermits(1)(
      runManagedAttachmentCleanupBatch.pipe(
        Effect.provideService(ManagedAttachmentRepository, repository),
        Effect.provideService(ServerConfig, config),
      ),
    );
    const runStartupStagingSweep = stagingRecoveryLock.withPermits(1)(
      Effect.tryPromise({
        try: () => sweepOrphanManagedAttachmentParts({ attachmentsDir: config.attachmentsDir }),
        catch: (cause) => cause,
      }),
    );
    const runStagingRecovery = stagingRecoveryLock.withPermits(1)(
      runManagedAttachmentStagingRecovery({ attachmentsDir: config.attachmentsDir }),
    );
    const runStartupStagingSweepSafely = runStartupStagingSweep.pipe(
      Effect.tap((result) =>
        result.failures > 0
          ? Effect.logWarning("managed attachment startup staging sweep skipped unsafe entries", {
              inspected: result.inspected,
              removed: result.removed,
              failures: result.failures,
            })
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("managed attachment startup staging sweep failed", { cause }),
      ),
    );
    const runStagingRecoverySafely = runStagingRecovery.pipe(
      Effect.tap((result) =>
        result.failures > 0
          ? Effect.logWarning("managed attachment staging recovery skipped unsafe entries", {
              inspected: result.inspected,
              removed: result.removed,
              failures: result.failures,
              passes: result.passes,
            })
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("managed attachment staging recovery failed", { cause }),
      ),
    );
    // Service availability waits for one bounded pass. A finite snapshot
    // continuation handles entries beyond the cap without extending startup.
    yield* runStartupStagingSweepSafely;
    yield* Effect.forkScoped(runStagingRecoverySafely);
    yield* runBatch.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("managed attachment startup cleanup failed", { cause }),
      ),
    );
    yield* repository.listFailedCleanup({ limit: MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE }).pipe(
      Effect.flatMap((failed) =>
        failed.length === 0
          ? Effect.void
          : Effect.logError("managed attachment cleanup requires operator attention", {
              failed: failed.map((job) => ({
                attachmentId: job.attachmentId,
                reason: job.reason,
                attemptCount: job.attemptCount,
                lastError: job.lastError,
              })),
            }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("failed to inspect poisoned managed attachment cleanup", { cause }),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(CLEANUP_INTERVAL).pipe(
          Effect.andThen(runStagingRecoverySafely),
          Effect.andThen(runBatch),
          Effect.catch((cause) =>
            Effect.logWarning("managed attachment cleanup pass failed", { cause }),
          ),
        ),
      ),
    );
    return {
      drain: runStagingRecoverySafely.pipe(
        Effect.andThen(drainCleanupBatches(runBatch)),
        Effect.catch((cause) =>
          Effect.logWarning("managed attachment shutdown drain failed", { cause }),
        ),
      ),
    } satisfies ManagedAttachmentCleanupShape;
  }),
);
