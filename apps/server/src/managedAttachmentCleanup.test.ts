import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import {
  MANAGED_ATTACHMENT_WRITING_LEASE_MS,
  runManagedAttachmentCleanupBatch,
  sweepOrphanManagedAttachmentParts,
} from "./managedAttachmentCleanup";
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
