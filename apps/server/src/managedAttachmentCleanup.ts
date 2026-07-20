import { randomUUID } from "node:crypto";
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
const MANAGED_ATTACHMENT_STAGING_SWEEP_SCAN_LIMIT = MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE * 4;

export interface ManagedAttachmentStagingSweepResult {
  readonly inspected: number;
  readonly removed: number;
  readonly failures: number;
}

/**
 * Remove crash-left upload parts even when the process died before a database
 * reservation was persisted. Work is intentionally bounded for startup.
 */
export async function sweepOrphanManagedAttachmentParts(input: {
  readonly attachmentsDir: string;
  readonly nowMs?: number;
  readonly maxRemovals?: number;
  readonly scanLimit?: number;
  /** Test seam for a replacement race between the two identity checks. */
  readonly beforeFinalStat?: (candidatePath: string) => Promise<void>;
}): Promise<ManagedAttachmentStagingSweepResult> {
  const emptyResult = { inspected: 0, removed: 0, failures: 0 } as const;
  const stagingDir = path.join(input.attachmentsDir, ".staging");
  let stagingStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stagingStat = await fs.lstat(stagingDir);
  } catch (cause) {
    if (isMissingFileError(cause)) return emptyResult;
    throw cause;
  }
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
    return { inspected: 0, removed: 0, failures: 1 };
  }

  let realStagingDir: string | null;
  try {
    realStagingDir = await resolveRealPathWithinRoot(input.attachmentsDir, stagingDir);
  } catch (cause) {
    if (isMissingFileError(cause)) return emptyResult;
    throw cause;
  }
  if (realStagingDir === null) {
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
  const directory = await fs.opendir(realStagingDir);

  for await (const entry of directory) {
    if (inspected >= scanLimit || removed >= maxRemovals) break;
    inspected += 1;
    if (!MANAGED_ATTACHMENT_STAGING_PART_PATTERN.test(entry.name)) continue;

    const candidatePath = path.join(realStagingDir, entry.name);
    try {
      const firstStat = await fs.lstat(candidatePath);
      if (!firstStat.isFile() || firstStat.isSymbolicLink() || firstStat.mtimeMs >= staleBeforeMs) {
        continue;
      }
      const realCandidate = await resolveRealPathWithinRoot(realStagingDir, candidatePath);
      if (realCandidate === null) {
        failures += 1;
        continue;
      }

      // Re-read immediately before unlink so a fresh writer that replaced or
      // touched the part after enumeration remains protected by the lease.
      await input.beforeFinalStat?.(realCandidate);
      const finalStat = await fs.lstat(realCandidate);
      if (
        !finalStat.isFile() ||
        finalStat.isSymbolicLink() ||
        finalStat.dev !== firstStat.dev ||
        finalStat.ino !== firstStat.ino ||
        finalStat.mtimeMs >= staleBeforeMs
      ) {
        continue;
      }
      await fs.unlink(realCandidate);
      removed += 1;
    } catch (cause) {
      if (!isMissingFileError(cause)) failures += 1;
    }
  }

  return { inspected, removed, failures };
}

const unlinkIfPresent = (filePath: string) =>
  Effect.tryPromise({
    try: () => fs.unlink(filePath),
    catch: (cause) => cause,
  }).pipe(Effect.catch((cause) => (isMissingFileError(cause) ? Effect.void : Effect.fail(cause))));

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
            if (stagingPath) yield* unlinkIfPresent(stagingPath);
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
    const runBatch = cleanupLock.withPermits(1)(
      runManagedAttachmentCleanupBatch.pipe(
        Effect.provideService(ManagedAttachmentRepository, repository),
        Effect.provideService(ServerConfig, config),
      ),
    );
    yield* Effect.tryPromise({
      try: () => sweepOrphanManagedAttachmentParts({ attachmentsDir: config.attachmentsDir }),
      catch: (cause) => cause,
    }).pipe(
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
          Effect.andThen(runBatch),
          Effect.catch((cause) =>
            Effect.logWarning("managed attachment cleanup pass failed", { cause }),
          ),
        ),
      ),
    );
    return {
      drain: drainCleanupBatches(runBatch).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("managed attachment shutdown drain failed", { cause }),
        ),
      ),
    } satisfies ManagedAttachmentCleanupShape;
  }),
);
