import { randomUUID } from "node:crypto";
import type { BigIntStats, Dir } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Effect, Layer, Semaphore, ServiceMap } from "effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths";
import { ServerConfig } from "./config";
import {
  MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
  ManagedAttachmentRepository,
  type ManagedAttachmentCleanupJob,
} from "./persistence/Services/ManagedAttachments";
import {
  tryWithManagedAttachmentStagingPathLock,
  withManagedAttachmentStagingPathLock,
} from "./managedAttachmentStore";
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
const MANAGED_ATTACHMENT_STAGING_RECOVERY_INVOCATION_SCAN_LIMIT =
  MANAGED_ATTACHMENT_STAGING_SWEEP_SCAN_LIMIT * 4;
const MANAGED_ATTACHMENT_STAGING_RECOVERY_INVOCATION_PASS_LIMIT = 4;
const MANAGED_ATTACHMENT_STAGING_RECOVERY_INVOCATION_TIME_MS = 250;

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
  /** Skip an active writer instead of waiting behind its process-local path lock. */
  readonly skipLocked?: boolean;
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
    const processEntry = async () => {
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
    };
    if (input.sweep.skipLocked) {
      const attempt = await tryWithManagedAttachmentStagingPathLock(partPath, processEntry);
      if (!attempt.acquired) return { removed: 0, failures: 0 };
    } else {
      await withManagedAttachmentStagingPathLock(partPath, processEntry);
    }
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
  readonly exhausted: boolean;
}

export interface ManagedAttachmentStagingRecoveryInput extends ManagedAttachmentStagingSweepInput {
  readonly invocationScanLimit?: number;
  readonly invocationPassLimit?: number;
  readonly invocationTimeBudgetMs?: number;
  /** Test seam for deterministic per-invocation deadline coverage. */
  readonly monotonicNow?: () => number;
}

interface ManagedAttachmentStagingRecoveryCursor {
  readonly attachmentsDir: string;
  readonly realStagingDir: string;
  readonly directoryIdentity: BigIntStats;
  readonly directory: Dir;
  readonly staleBeforeMs: number;
}

export interface ManagedAttachmentStagingRecovery {
  readonly run: (
    input: ManagedAttachmentStagingRecoveryInput,
  ) => Effect.Effect<ManagedAttachmentStagingRecoveryResult, unknown>;
  readonly close: Effect.Effect<void, unknown>;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(fallback, Math.floor(value)));
}

async function closeStagingRecoveryCursor(
  cursor: ManagedAttachmentStagingRecoveryCursor,
): Promise<void> {
  await cursor.directory.close();
}

async function stagingRecoveryCursorIsCurrent(
  cursor: ManagedAttachmentStagingRecoveryCursor,
): Promise<boolean> {
  try {
    const current = await fs.lstat(cursor.realStagingDir, { bigint: true });
    return (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      isSameFileIdentity(cursor.directoryIdentity, current)
    );
  } catch (cause) {
    if (isMissingFileError(cause)) return false;
    throw cause;
  }
}

/**
 * Retain one directory cursor across independently bounded recovery calls.
 * Every call has hard scan, pass, and wall-clock budgets; later scheduled calls
 * resume the same generation so a large or mutating prefix cannot starve later
 * stale parts. Reaching EOF closes the generation so future entries are found
 * by the next call.
 */
export function makeManagedAttachmentStagingRecovery(): ManagedAttachmentStagingRecovery {
  let cursor: ManagedAttachmentStagingRecoveryCursor | null = null;

  const close = Effect.tryPromise({
    try: async () => {
      const current = cursor;
      cursor = null;
      if (current) await closeStagingRecoveryCursor(current);
    },
    catch: (cause) => cause,
  });

  const run = (
    input: ManagedAttachmentStagingRecoveryInput,
  ): Effect.Effect<ManagedAttachmentStagingRecoveryResult, unknown> =>
    Effect.tryPromise({
      try: async () => {
        try {
          const maxRemovals = Math.max(
            0,
            Math.floor(input.maxRemovals ?? MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE),
          );
          const scanLimit = Math.max(
            0,
            Math.floor(input.scanLimit ?? MANAGED_ATTACHMENT_STAGING_SWEEP_SCAN_LIMIT),
          );
          const invocationScanLimit = boundedPositiveInteger(
            input.invocationScanLimit,
            MANAGED_ATTACHMENT_STAGING_RECOVERY_INVOCATION_SCAN_LIMIT,
          );
          const invocationPassLimit = boundedPositiveInteger(
            input.invocationPassLimit,
            MANAGED_ATTACHMENT_STAGING_RECOVERY_INVOCATION_PASS_LIMIT,
          );
          const invocationTimeBudgetMs = boundedPositiveInteger(
            input.invocationTimeBudgetMs,
            MANAGED_ATTACHMENT_STAGING_RECOVERY_INVOCATION_TIME_MS,
          );
          const monotonicNow = input.monotonicNow ?? (() => performance.now());
          const deadline = monotonicNow() + invocationTimeBudgetMs;
          let inspected = 0;
          let removed = 0;
          let failures = 0;
          let passes = 0;
          if (scanLimit === 0 || maxRemovals === 0) {
            return { inspected, removed, failures, passes, exhausted: false };
          }

          const attachmentsDir = path.resolve(input.attachmentsDir);
          if (
            cursor &&
            (cursor.attachmentsDir !== attachmentsDir ||
              !(await stagingRecoveryCursorIsCurrent(cursor)))
          ) {
            const staleCursor = cursor;
            cursor = null;
            await closeStagingRecoveryCursor(staleCursor);
          }

          const verifiedStagingDir = await resolveVerifiedStagingDirectory(attachmentsDir);
          if (verifiedStagingDir._tag === "Missing") {
            const missingCursor = cursor;
            cursor = null;
            if (missingCursor) await closeStagingRecoveryCursor(missingCursor);
            return { inspected, removed, failures, passes, exhausted: true };
          }
          if (verifiedStagingDir._tag === "Unsafe") {
            const unsafeCursor = cursor;
            cursor = null;
            if (unsafeCursor) await closeStagingRecoveryCursor(unsafeCursor);
            return { inspected, removed, failures: 1, passes, exhausted: true };
          }

          if (!cursor) {
            const directoryIdentity = await fs.lstat(verifiedStagingDir.realPath, { bigint: true });
            if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
              return { inspected, removed, failures: 1, passes, exhausted: true };
            }
            cursor = {
              attachmentsDir,
              realStagingDir: verifiedStagingDir.realPath,
              directoryIdentity,
              directory: await fs.opendir(verifiedStagingDir.realPath),
              staleBeforeMs: (input.nowMs ?? Date.now()) - MANAGED_ATTACHMENT_WRITING_LEASE_MS,
            };
          }

          const activeCursor = cursor;
          let exhausted = false;
          while (
            !exhausted &&
            passes < invocationPassLimit &&
            inspected < invocationScanLimit &&
            monotonicNow() < deadline
          ) {
            let passInspected = 0;
            let passRemoved = 0;
            let passFailures = 0;
            while (
              passInspected < scanLimit &&
              passRemoved < maxRemovals &&
              inspected + passInspected < invocationScanLimit &&
              monotonicNow() < deadline
            ) {
              const entry = await activeCursor.directory.read();
              if (entry === null) {
                exhausted = true;
                break;
              }
              passInspected += 1;
              const result = await processManagedAttachmentStagingEntry({
                sweep: { ...input, skipLocked: true },
                realStagingDir: activeCursor.realStagingDir,
                entryName: entry.name,
                staleBeforeMs: activeCursor.staleBeforeMs,
              });
              passRemoved += result.removed;
              passFailures += result.failures;
            }
            if (passInspected === 0) break;
            passes += 1;
            inspected += passInspected;
            removed += passRemoved;
            failures += passFailures;
            if (!exhausted) await new Promise<void>((resolve) => setImmediate(resolve));
          }

          if (exhausted) {
            cursor = null;
            await closeStagingRecoveryCursor(activeCursor);
          }
          return { inspected, removed, failures, passes, exhausted };
        } catch (cause) {
          const failedCursor = cursor;
          cursor = null;
          if (failedCursor) {
            await closeStagingRecoveryCursor(failedCursor).catch(() => undefined);
          }
          throw cause;
        }
      },
      catch: (cause) => cause,
    });

  return { run, close };
}

export const runManagedAttachmentStagingRecovery = (
  input: ManagedAttachmentStagingRecoveryInput,
): Effect.Effect<ManagedAttachmentStagingRecoveryResult, unknown> => {
  const recovery = makeManagedAttachmentStagingRecovery();
  return Effect.acquireUseRelease(
    Effect.succeed(recovery),
    (runner) => runner.run(input),
    (runner) => runner.close,
  );
};

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
    const stagingRecovery = makeManagedAttachmentStagingRecovery();
    yield* Effect.addFinalizer(() =>
      stagingRecovery.close.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to close managed attachment staging recovery cursor", {
            cause,
          }),
        ),
      ),
    );
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
      stagingRecovery.run({ attachmentsDir: config.attachmentsDir }),
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
    // Service availability waits for one bounded pass. Later scheduled calls
    // resume a separately bounded cursor generation without extending startup.
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
