import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats, Dir, Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

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
export const MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS = 250;
const PINNED_STAGING_DELETE_TIMEOUT_MS = 5_000;
const PINNED_STAGING_DEADLINE_CLEANUP_RESERVE_MS = 25;
class ManagedAttachmentStagingDeadlineExceeded extends Error {
  override readonly name = "ManagedAttachmentStagingDeadlineExceeded";
}

function pinnedStagingOperationTimeout(remainingMs?: () => number): {
  readonly timeoutMs: number;
  readonly deadlineBounded: boolean;
} {
  if (!remainingMs) {
    return { timeoutMs: PINNED_STAGING_DELETE_TIMEOUT_MS, deadlineBounded: false };
  }
  const remaining = remainingMs();
  const operationBudget = remaining - PINNED_STAGING_DEADLINE_CLEANUP_RESERVE_MS;
  if (!Number.isFinite(operationBudget) || operationBudget <= 0) {
    throw new ManagedAttachmentStagingDeadlineExceeded(
      "Managed attachment staging recovery deadline expired.",
    );
  }
  return {
    timeoutMs: Math.max(1, Math.floor(Math.min(PINNED_STAGING_DELETE_TIMEOUT_MS, operationBudget))),
    deadlineBounded: true,
  };
}

function pinnedStagingCloseTimeoutMs(remainingMs?: () => number): number {
  if (!remainingMs) return PINNED_STAGING_DELETE_TIMEOUT_MS;
  return Math.max(
    0,
    Math.floor(Math.min(PINNED_STAGING_DEADLINE_CLEANUP_RESERVE_MS, remainingMs())),
  );
}

const PINNED_STAGING_DELETE_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");
const [stagingDev, stagingIno] = process.argv.slice(1);
const PART_PATTERN = /^att_v2_[0-9a-f]{32}\.part$/u;
const QUARANTINE_PATTERN = /^(att_v2_[0-9a-f]{32}\.part)\.cleanup-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sameIdentity = (stat, dev, ino) => String(stat.dev) === dev && String(stat.ino) === ino;
const respond = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const stagingIsCurrent = () => {
  try {
    const stagingStat = fs.lstatSync(".", { bigint: true });
    return stagingStat.isDirectory() && !stagingStat.isSymbolicLink() && sameIdentity(stagingStat, stagingDev, stagingIno);
  } catch {
    return false;
  }
};
const processRequest = (request) => {
  const { operation, entryName, candidateDev, candidateIno, staleBeforeMs } = request || {};
  if (!stagingIsCurrent()) return { _tag: "DirectoryUnsafe" };
  if (!entryName || path.basename(entryName) !== entryName || entryName === "." || entryName === "..") {
    return { _tag: "CandidateUnsafe" };
  }
  const isPart = PART_PATTERN.test(entryName);
  const isQuarantine = QUARANTINE_PATTERN.test(entryName);
  if (
    (operation === "quarantine" && !isPart) ||
    (operation === "unlink-quarantine" && !isQuarantine) ||
    (operation === "cleanup" && !isPart && !isQuarantine)
  ) {
    return { _tag: "CandidateUnsafe" };
  }
  let candidateStat;
  try {
    candidateStat = fs.lstatSync(entryName, { bigint: true });
  } catch (cause) {
    if (cause && cause.code === "ENOENT") return { _tag: "Missing" };
    throw cause;
  }
  if (
    !candidateStat.isFile() ||
    candidateStat.isSymbolicLink() ||
    !sameIdentity(candidateStat, candidateDev, candidateIno) ||
    Number(candidateStat.mtimeMs) >= Number(staleBeforeMs)
  ) {
    return { _tag: "CandidateUnsafe" };
  }
  if (operation === "unlink-quarantine" || (operation === "cleanup" && isQuarantine)) {
    fs.unlinkSync(entryName);
    return { _tag: "Removed" };
  }
  const quarantineName = entryName + ".cleanup-" + randomUUID();
  fs.renameSync(entryName, quarantineName);
  const quarantinedStat = fs.lstatSync(quarantineName, { bigint: true });
  if (
    !quarantinedStat.isFile() ||
    quarantinedStat.isSymbolicLink() ||
    !sameIdentity(quarantinedStat, candidateDev, candidateIno) ||
    Number(quarantinedStat.mtimeMs) >= Number(staleBeforeMs)
  ) {
    try { fs.renameSync(quarantineName, entryName); } catch {}
    return { _tag: "CandidateUnsafe" };
  }
  if (operation === "quarantine") {
    return { _tag: "Quarantined", quarantineName };
  }
  try {
    fs.unlinkSync(quarantineName);
  } catch (cause) {
    try { fs.renameSync(quarantineName, entryName); } catch {}
    throw cause;
  }
  return { _tag: "Removed" };
};
if (!stagingIsCurrent()) {
  respond({ _tag: "DirectoryUnsafe" });
  process.exit(0);
}
respond({ _tag: "Ready" });
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    respond(processRequest(JSON.parse(line)));
  } catch (cause) {
    respond({ _tag: "Failed", detail: String(cause && (cause.code || cause.message) || cause).slice(0, 2048) });
  }
});
`;

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
  /** Optional total wall-clock budget shared by helper startup, entries, and forced close. */
  readonly timeBudgetMs?: number;
  /** Test seam for deterministic total-deadline coverage. */
  readonly monotonicNow?: () => number;
  /** Skip an active writer instead of waiting behind its process-local path lock. */
  readonly skipLocked?: boolean;
  /** Test seam for a stalled directory enumeration. */
  readonly readDirectoryEntry?: (directory: Dir) => Promise<Dirent | null>;
  /** Own cleanup that must finish after a deadline-bounded sweep returns. */
  readonly onDeferredCleanup?: (completion: Promise<void>) => void;
  /** Test seam for a replacement race between the two identity checks. */
  readonly beforeFinalStat?: (candidatePath: string) => Promise<void>;
  /** Test seam for a replacement after final validation but before quarantine. */
  readonly beforeQuarantine?: (candidatePath: string) => Promise<void>;
  /** Test seam for a crash after quarantine but before unlink. */
  readonly afterQuarantine?: (candidatePath: string, quarantinePath: string) => Promise<void>;
  /** Test seam for a staging-directory swap after final candidate validation. */
  readonly beforePinnedDelete?: (stagingDir: string, candidatePath: string) => Promise<void>;
  /** Test seam for a helper failure or deadline advance before its ready response. */
  readonly beforePinnedSessionReady?: () => Promise<void>;
  /** Test seam for a helper failure or deadline advance before a cleanup request. */
  readonly beforePinnedSessionRequest?: () => Promise<void>;
  /** Test seam replacing child-exit observation during forced recovery close. */
  readonly waitForPinnedSessionForceClose?: (timeoutMs: number) => Promise<void>;
}

type VerifiedStagingDirectory =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unsafe" }
  | { readonly _tag: "Verified"; readonly realPath: string; readonly identity: BigIntStats };

async function resolveVerifiedStagingDirectory(
  attachmentsDir: string,
): Promise<VerifiedStagingDirectory> {
  const stagingDir = path.join(attachmentsDir, ".staging");
  let stagingStat: BigIntStats;
  try {
    stagingStat = await fs.lstat(stagingDir, { bigint: true });
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
  if (realStagingDir === null) return { _tag: "Unsafe" };
  const verifiedStat = await fs.lstat(realStagingDir, { bigint: true }).catch((cause) => {
    if (isMissingFileError(cause)) return null;
    throw cause;
  });
  if (
    !verifiedStat ||
    !verifiedStat.isDirectory() ||
    verifiedStat.isSymbolicLink() ||
    !isSameFileIdentity(stagingStat, verifiedStat)
  ) {
    return { _tag: "Unsafe" };
  }
  return { _tag: "Verified", realPath: realStagingDir, identity: verifiedStat };
}

type OpenedStagingDirectory =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unsafe" }
  | { readonly _tag: "Opened"; readonly directory: Dir };

async function openVerifiedStagingDirectory(
  staging: Extract<VerifiedStagingDirectory, { readonly _tag: "Verified" }>,
): Promise<OpenedStagingDirectory> {
  let directory: Dir;
  try {
    directory = await fs.opendir(staging.realPath);
  } catch (cause) {
    if (isMissingFileError(cause)) return { _tag: "Missing" };
    throw cause;
  }
  try {
    const current = await fs.lstat(staging.realPath, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !isSameFileIdentity(staging.identity, current)
    ) {
      await directory.close();
      return { _tag: "Unsafe" };
    }
    return { _tag: "Opened", directory };
  } catch (cause) {
    await directory.close().catch(() => undefined);
    if (isMissingFileError(cause)) return { _tag: "Missing" };
    throw cause;
  }
}

function stagingEntryPartName(entryName: string): string | null {
  if (MANAGED_ATTACHMENT_STAGING_PART_PATTERN.test(entryName)) return entryName;
  return MANAGED_ATTACHMENT_STAGING_QUARANTINE_PATTERN.exec(entryName)?.[1] ?? null;
}

function isSameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type PinnedStagingDeleteResult =
  | { readonly _tag: "Removed" }
  | { readonly _tag: "Quarantined"; readonly quarantineName: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "DirectoryUnsafe" }
  | { readonly _tag: "CandidateUnsafe" };

interface PinnedStagingDeleteSession {
  readonly run: (input: {
    readonly operation: "cleanup" | "quarantine" | "unlink-quarantine";
    readonly entryName: string;
    readonly candidateIdentity: BigIntStats;
    readonly staleBeforeMs: number;
    readonly remainingTimeoutMs?: () => number;
    readonly beforeRequest?: () => Promise<void>;
  }) => Promise<PinnedStagingDeleteResult>;
  readonly close: (options?: {
    readonly force?: boolean;
    readonly exitWaitMs?: number;
  }) => Promise<void>;
}

type PinnedStagingDeleteSessionResult =
  | { readonly _tag: "Opened"; readonly session: PinnedStagingDeleteSession }
  | { readonly _tag: "DirectoryUnsafe" };

function parsePinnedStagingResponse(line: string): PinnedStagingDeleteResult | { _tag: "Ready" } {
  const response = JSON.parse(line) as {
    readonly _tag?: unknown;
    readonly quarantineName?: unknown;
    readonly detail?: unknown;
  };
  switch (response._tag) {
    case "Ready":
    case "Removed":
    case "Missing":
    case "DirectoryUnsafe":
    case "CandidateUnsafe":
      return { _tag: response._tag };
    case "Quarantined":
      if (
        typeof response.quarantineName !== "string" ||
        path.basename(response.quarantineName) !== response.quarantineName ||
        !MANAGED_ATTACHMENT_STAGING_QUARANTINE_PATTERN.test(response.quarantineName)
      ) {
        throw new Error("Pinned staging deletion returned an invalid quarantine name.");
      }
      return { _tag: "Quarantined", quarantineName: response.quarantineName };
    case "Failed":
      throw new Error(
        `Pinned staging deletion failed.${typeof response.detail === "string" ? ` ${response.detail}` : ""}`,
      );
    default:
      throw new Error("Pinned staging deletion returned an invalid response.");
  }
}

async function createPinnedStagingDeleteSession(input: {
  readonly realStagingDir: string;
  readonly stagingIdentity: BigIntStats;
  readonly remainingTimeoutMs?: () => number;
  readonly beforeReady?: () => Promise<void>;
  readonly waitForForceClose?: (timeoutMs: number) => Promise<void>;
  readonly onDeferredCleanup?: (completion: Promise<void>) => void;
}): Promise<PinnedStagingDeleteSessionResult> {
  const child = spawn(
    process.execPath,
    [
      "--eval",
      PINNED_STAGING_DELETE_SCRIPT,
      "--",
      input.stagingIdentity.dev.toString(10),
      input.stagingIdentity.ino.toString(10),
    ],
    {
      cwd: input.realStagingDir,
      stdio: "pipe",
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let spawnError: Error | null = null;
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
  });
  child.on("error", (cause) => {
    spawnError = cause;
  });
  child.stdin.on("error", (cause) => {
    spawnError ??= cause;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let childClosed = false;
  const childCloseCompletion = new Promise<void>((resolve) => {
    child.once("close", () => {
      childClosed = true;
      resolve();
    });
  });
  const releaseChildHandles = (): void => {
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    if (!childClosed) input.onDeferredCleanup?.(childCloseCompletion);
  };
  const waitForChildExit = async (timeoutMs: number): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        child.removeListener("exit", finish);
        resolve();
      };
      child.once("exit", finish);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, timeoutMs);
    });
  };

  const readResponse = async (timeoutOptions: {
    readonly timeoutMs: number;
    readonly deadlineBounded: boolean;
  }): Promise<PinnedStagingDeleteResult | { _tag: "Ready" }> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
              timeoutOptions.deadlineBounded
                ? new ManagedAttachmentStagingDeadlineExceeded(
                    "Managed attachment staging recovery deadline expired.",
                  )
                : new Error("Pinned staging deletion timed out."),
            );
          }, timeoutOptions.timeoutMs);
        }),
      ]);
      if (next.done) {
        throw new Error(
          `Pinned staging deletion exited without a response.${spawnError ? ` ${spawnError.message}` : stderr.trim() ? ` ${stderr.trim()}` : ""}`,
        );
      }
      return parsePinnedStagingResponse(next.value);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  let ready: PinnedStagingDeleteResult | { _tag: "Ready" };
  try {
    await input.beforeReady?.();
    ready = await readResponse(pinnedStagingOperationTimeout(input.remainingTimeoutMs));
  } catch (cause) {
    child.kill("SIGKILL");
    const closeTimeoutMs = pinnedStagingCloseTimeoutMs(input.remainingTimeoutMs);
    if (closeTimeoutMs > 0) await waitForChildExit(closeTimeoutMs);
    releaseChildHandles();
    throw cause;
  }
  if (ready._tag === "DirectoryUnsafe") {
    child.stdin.end();
    const closeTimeoutMs = pinnedStagingCloseTimeoutMs(input.remainingTimeoutMs);
    if (closeTimeoutMs > 0) await waitForChildExit(closeTimeoutMs);
    releaseChildHandles();
    return { _tag: "DirectoryUnsafe" };
  }
  if (ready._tag !== "Ready") {
    child.kill("SIGKILL");
    const closeTimeoutMs = pinnedStagingCloseTimeoutMs(input.remainingTimeoutMs);
    if (closeTimeoutMs > 0) await waitForChildExit(closeTimeoutMs);
    releaseChildHandles();
    throw new Error("Pinned staging deletion did not become ready.");
  }

  let closed = false;
  const session: PinnedStagingDeleteSession = {
    run: async (request) => {
      if (closed || child.stdin.destroyed) {
        throw new Error("Pinned staging deletion session is closed.");
      }
      await request.beforeRequest?.();
      const timeoutOptions = pinnedStagingOperationTimeout(request.remainingTimeoutMs);
      child.stdin.write(
        `${JSON.stringify({
          operation: request.operation,
          entryName: request.entryName,
          candidateDev: request.candidateIdentity.dev.toString(10),
          candidateIno: request.candidateIdentity.ino.toString(10),
          staleBeforeMs: request.staleBeforeMs,
        })}\n`,
      );
      const response = await readResponse(timeoutOptions);
      if (response._tag === "Ready") {
        throw new Error("Pinned staging deletion returned an unexpected ready response.");
      }
      return response;
    },
    close: async (options) => {
      if (closed) return;
      closed = true;
      if (options?.force) {
        child.kill("SIGKILL");
        child.stdin.destroy();
      } else {
        child.stdin.end();
      }
      const exitWaitMs = Math.max(
        0,
        Math.floor(
          options?.exitWaitMs ??
            (options?.force
              ? PINNED_STAGING_DEADLINE_CLEANUP_RESERVE_MS
              : PINNED_STAGING_DELETE_TIMEOUT_MS),
        ),
      );
      if (options?.force && input.waitForForceClose) {
        await input.waitForForceClose(exitWaitMs);
      } else if (exitWaitMs > 0 && child.exitCode === null && child.signalCode === null) {
        await waitForChildExit(exitWaitMs);
      }
      releaseChildHandles();
    },
  };
  return { _tag: "Opened", session };
}

async function runPinnedStagingDelete(input: {
  readonly session: PinnedStagingDeleteSession;
  readonly operation: "cleanup" | "quarantine" | "unlink-quarantine";
  readonly entryName: string;
  readonly candidateIdentity: BigIntStats;
  readonly staleBeforeMs: number;
  readonly remainingTimeoutMs?: () => number;
  readonly beforeRequest?: () => Promise<void>;
}): Promise<PinnedStagingDeleteResult> {
  return input.session.run(input);
}

type PinnedStagingResources =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unsafe" }
  | {
      readonly _tag: "Opened";
      readonly directory: Dir;
      readonly session: PinnedStagingDeleteSession;
    };

type BoundedDirectoryReadResult =
  | { readonly _tag: "Entry"; readonly entry: Dirent | null }
  | { readonly _tag: "DeadlineExceeded"; readonly settled?: Promise<void> };

async function readDirectoryEntryWithinDeadline(input: {
  readonly directory: Dir;
  readonly remainingTimeoutMs?: () => number;
  readonly read?: (directory: Dir) => Promise<Dirent | null>;
}): Promise<BoundedDirectoryReadResult> {
  if (input.remainingTimeoutMs) {
    const initialBudgetMs = input.remainingTimeoutMs() - PINNED_STAGING_DEADLINE_CLEANUP_RESERVE_MS;
    if (!Number.isFinite(initialBudgetMs) || initialBudgetMs <= 0) {
      return { _tag: "DeadlineExceeded" };
    }
  }
  const readOutcome = (input.read?.(input.directory) ?? input.directory.read()).then(
    (entry) => ({ _tag: "Entry", entry }) as const,
    (cause: unknown) => ({ _tag: "Failed", cause }) as const,
  );
  if (!input.remainingTimeoutMs) {
    const outcome = await readOutcome;
    if (outcome._tag === "Failed") throw outcome.cause;
    return outcome;
  }

  const settled = readOutcome.then(() => undefined);
  const remainingMs = input.remainingTimeoutMs() - PINNED_STAGING_DEADLINE_CLEANUP_RESERVE_MS;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { _tag: "DeadlineExceeded", settled };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    readOutcome,
    new Promise<{ readonly _tag: "DeadlineExceeded"; readonly settled: Promise<void> }>(
      (resolve) => {
        timeout = setTimeout(
          () => resolve({ _tag: "DeadlineExceeded", settled }),
          Math.max(0, Math.floor(remainingMs)),
        );
      },
    ),
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome._tag === "Failed") throw outcome.cause;
  return outcome;
}

function closeDirectoryAfterPendingRead(directory: Dir, settled: Promise<void>): Promise<void> {
  return settled.then(() => directory.close()).catch(() => undefined);
}

interface ManagedAttachmentDeferredCleanupTracker {
  readonly track: (completion: Promise<void>) => void;
  readonly drain: () => Promise<void>;
}

function makeManagedAttachmentDeferredCleanupTracker(): ManagedAttachmentDeferredCleanupTracker {
  const pending = new Set<Promise<void>>();
  return {
    track: (completion) => {
      if (pending.has(completion)) return;
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

async function openPinnedStagingResources(input: {
  readonly staging: Extract<VerifiedStagingDirectory, { readonly _tag: "Verified" }>;
  readonly remainingTimeoutMs?: () => number;
  readonly beforeReady?: () => Promise<void>;
  readonly waitForForceClose?: (timeoutMs: number) => Promise<void>;
  readonly onDeferredCleanup?: (completion: Promise<void>) => void;
}): Promise<PinnedStagingResources> {
  const opened = await openVerifiedStagingDirectory(input.staging);
  if (opened._tag !== "Opened") return opened;
  try {
    const pinned = await createPinnedStagingDeleteSession({
      realStagingDir: input.staging.realPath,
      stagingIdentity: input.staging.identity,
      ...(input.remainingTimeoutMs ? { remainingTimeoutMs: input.remainingTimeoutMs } : {}),
      ...(input.beforeReady ? { beforeReady: input.beforeReady } : {}),
      ...(input.waitForForceClose ? { waitForForceClose: input.waitForForceClose } : {}),
      ...(input.onDeferredCleanup ? { onDeferredCleanup: input.onDeferredCleanup } : {}),
    });
    if (pinned._tag === "DirectoryUnsafe") {
      await opened.directory.close();
      return { _tag: "Unsafe" };
    }
    return { _tag: "Opened", directory: opened.directory, session: pinned.session };
  } catch (cause) {
    await opened.directory.close().catch(() => undefined);
    throw cause;
  }
}

async function processManagedAttachmentStagingEntry(input: {
  readonly sweep: ManagedAttachmentStagingSweepInput;
  readonly realStagingDir: string;
  readonly pinnedDeleteSession: PinnedStagingDeleteSession;
  readonly entryName: string;
  readonly staleBeforeMs: number;
  readonly remainingTimeoutMs?: () => number;
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

      let preQuarantineStat = finalStat;
      if (input.entryName === partName) {
        await input.sweep.beforeQuarantine?.(realCandidate);
        preQuarantineStat = await fs.lstat(realCandidate, { bigint: true });
      }
      if (
        !preQuarantineStat.isFile() ||
        preQuarantineStat.isSymbolicLink() ||
        !isSameFileIdentity(finalStat, preQuarantineStat) ||
        Number(preQuarantineStat.mtimeMs) >= input.staleBeforeMs
      ) {
        return;
      }
      await input.sweep.beforePinnedDelete?.(input.realStagingDir, realCandidate);

      if (input.entryName !== partName || input.sweep.afterQuarantine === undefined) {
        const deletion = await runPinnedStagingDelete({
          session: input.pinnedDeleteSession,
          operation: "cleanup",
          entryName: input.entryName,
          candidateIdentity: preQuarantineStat,
          staleBeforeMs: input.staleBeforeMs,
          ...(input.remainingTimeoutMs ? { remainingTimeoutMs: input.remainingTimeoutMs } : {}),
          ...(input.sweep.beforePinnedSessionRequest
            ? { beforeRequest: input.sweep.beforePinnedSessionRequest }
            : {}),
        });
        if (deletion._tag === "Removed") removed += 1;
        else if (deletion._tag === "DirectoryUnsafe") failures += 1;
        return;
      }

      const quarantine = await runPinnedStagingDelete({
        session: input.pinnedDeleteSession,
        operation: "quarantine",
        entryName: input.entryName,
        candidateIdentity: preQuarantineStat,
        staleBeforeMs: input.staleBeforeMs,
        ...(input.remainingTimeoutMs ? { remainingTimeoutMs: input.remainingTimeoutMs } : {}),
        ...(input.sweep.beforePinnedSessionRequest
          ? { beforeRequest: input.sweep.beforePinnedSessionRequest }
          : {}),
      });
      if (quarantine._tag === "DirectoryUnsafe") failures += 1;
      if (quarantine._tag !== "Quarantined") return;
      const quarantinePath = path.join(input.realStagingDir, quarantine.quarantineName);
      await input.sweep.afterQuarantine(realCandidate, quarantinePath);
      const deletion = await runPinnedStagingDelete({
        session: input.pinnedDeleteSession,
        operation: "unlink-quarantine",
        entryName: quarantine.quarantineName,
        candidateIdentity: preQuarantineStat,
        staleBeforeMs: input.staleBeforeMs,
        ...(input.remainingTimeoutMs ? { remainingTimeoutMs: input.remainingTimeoutMs } : {}),
        ...(input.sweep.beforePinnedSessionRequest
          ? { beforeRequest: input.sweep.beforePinnedSessionRequest }
          : {}),
      });
      if (deletion._tag === "Removed") removed += 1;
      else if (deletion._tag === "DirectoryUnsafe") failures += 1;
    };
    if (input.sweep.skipLocked) {
      const attempt = await tryWithManagedAttachmentStagingPathLock(partPath, processEntry);
      if (!attempt.acquired) return { removed: 0, failures: 0 };
    } else {
      await withManagedAttachmentStagingPathLock(partPath, processEntry);
    }
  } catch (cause) {
    if (cause instanceof ManagedAttachmentStagingDeadlineExceeded) throw cause;
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
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const timeBudgetMs =
    input.timeBudgetMs === undefined
      ? null
      : boundedPositiveInteger(input.timeBudgetMs, MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS);
  const deadline = timeBudgetMs === null ? null : monotonicNow() + timeBudgetMs;
  const remainingTimeoutMs = deadline === null ? undefined : () => deadline - monotonicNow();
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
  const resources = await openPinnedStagingResources({
    staging: verifiedStagingDir,
    ...(remainingTimeoutMs ? { remainingTimeoutMs } : {}),
    ...(input.beforePinnedSessionReady ? { beforeReady: input.beforePinnedSessionReady } : {}),
    ...(input.waitForPinnedSessionForceClose
      ? { waitForForceClose: input.waitForPinnedSessionForceClose }
      : {}),
    ...(input.onDeferredCleanup ? { onDeferredCleanup: input.onDeferredCleanup } : {}),
  });
  if (resources._tag === "Missing") return emptyResult;
  if (resources._tag === "Unsafe") return { inspected: 0, removed: 0, failures: 1 };
  let pendingDirectoryRead: Promise<void> | undefined;
  try {
    while (
      inspected < scanLimit &&
      removed < maxRemovals &&
      (deadline === null || monotonicNow() < deadline)
    ) {
      const read = await readDirectoryEntryWithinDeadline({
        directory: resources.directory,
        ...(remainingTimeoutMs ? { remainingTimeoutMs } : {}),
        ...(input.readDirectoryEntry ? { read: input.readDirectoryEntry } : {}),
      });
      if (read._tag === "DeadlineExceeded") {
        pendingDirectoryRead = read.settled;
        break;
      }
      const entry = read.entry;
      if (entry === null) break;
      inspected += 1;
      const result = await processManagedAttachmentStagingEntry({
        sweep: input,
        realStagingDir: verifiedStagingDir.realPath,
        pinnedDeleteSession: resources.session,
        entryName: entry.name,
        staleBeforeMs,
        ...(remainingTimeoutMs ? { remainingTimeoutMs } : {}),
      });
      removed += result.removed;
      failures += result.failures;
    }
  } catch (cause) {
    if (!(cause instanceof ManagedAttachmentStagingDeadlineExceeded)) throw cause;
  } finally {
    const remainingCloseMs = remainingTimeoutMs
      ? pinnedStagingCloseTimeoutMs(remainingTimeoutMs)
      : undefined;
    const closeSession = resources.session.close(
      remainingTimeoutMs
        ? {
            force: true,
            ...(remainingCloseMs !== undefined ? { exitWaitMs: remainingCloseMs } : {}),
          }
        : undefined,
    );
    if (pendingDirectoryRead) {
      const completion = closeDirectoryAfterPendingRead(resources.directory, pendingDirectoryRead);
      input.onDeferredCleanup?.(completion);
      await closeSession;
    } else {
      await Promise.all([resources.directory.close(), closeSession]);
    }
  }

  return { inspected, removed, failures };
}

export interface ManagedAttachmentStagingRecoveryResult extends ManagedAttachmentStagingSweepResult {
  readonly passes: number;
  readonly exhausted: boolean;
}

export interface ManagedAttachmentStagingRecoveryInput extends Omit<
  ManagedAttachmentStagingSweepInput,
  "timeBudgetMs"
> {
  readonly invocationScanLimit?: number;
  readonly invocationPassLimit?: number;
  readonly invocationTimeBudgetMs?: number;
}

interface ManagedAttachmentStagingRecoveryCursor {
  readonly attachmentsDir: string;
  readonly realStagingDir: string;
  readonly directoryIdentity: BigIntStats;
  readonly directory: Dir;
  readonly pinnedDeleteSession: PinnedStagingDeleteSession;
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
  options: {
    readonly force?: boolean;
    readonly remainingTimeoutMs?: () => number;
    readonly pendingDirectoryRead?: Promise<void>;
    readonly onDeferredDirectoryClose?: (completion: Promise<void>) => void;
  } = {},
): Promise<void> {
  const remainingCloseMs = options.remainingTimeoutMs
    ? pinnedStagingCloseTimeoutMs(options.remainingTimeoutMs)
    : undefined;
  const closeSession = cursor.pinnedDeleteSession.close(
    options.force
      ? {
          force: true,
          ...(remainingCloseMs !== undefined ? { exitWaitMs: remainingCloseMs } : {}),
        }
      : undefined,
  );
  if (options.pendingDirectoryRead) {
    const completion = closeDirectoryAfterPendingRead(
      cursor.directory,
      options.pendingDirectoryRead,
    );
    options.onDeferredDirectoryClose?.(completion);
    await closeSession;
  } else {
    await Promise.all([cursor.directory.close(), closeSession]);
  }
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
  let deferredCursorClose: { readonly completion: Promise<void>; settled: boolean } | null = null;
  const activeRuns = new Set<Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const close = Effect.tryPromise({
    try: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        while (activeRuns.size > 0) {
          await Promise.all([...activeRuns]);
        }
        const current = cursor;
        cursor = null;
        if (current) await closeStagingRecoveryCursor(current);
        const deferred = deferredCursorClose;
        deferredCursorClose = null;
        if (deferred) await deferred.completion;
      })();
      return closePromise;
    },
    catch: (cause) => cause,
  });

  const run = (
    input: ManagedAttachmentStagingRecoveryInput,
  ): Effect.Effect<ManagedAttachmentStagingRecoveryResult, unknown> =>
    Effect.tryPromise({
      try: async () => {
        if (closed) {
          throw new Error("Managed attachment staging recovery is closed.");
        }
        let completeRun!: () => void;
        const completion = new Promise<void>((resolve) => {
          completeRun = resolve;
        });
        activeRuns.add(completion);
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
          const remainingTimeoutMs = () => deadline - monotonicNow();
          let inspected = 0;
          let removed = 0;
          let failures = 0;
          let passes = 0;
          if (scanLimit === 0 || maxRemovals === 0) {
            return { inspected, removed, failures, passes, exhausted: false };
          }
          if (deferredCursorClose) {
            if (!deferredCursorClose.settled) {
              return { inspected, removed, failures, passes, exhausted: false };
            }
            await deferredCursorClose.completion;
            deferredCursorClose = null;
          }

          const attachmentsDir = path.resolve(input.attachmentsDir);
          if (
            cursor &&
            (cursor.attachmentsDir !== attachmentsDir ||
              !(await stagingRecoveryCursorIsCurrent(cursor)))
          ) {
            const staleCursor = cursor;
            cursor = null;
            await closeStagingRecoveryCursor(staleCursor, {
              force: true,
              remainingTimeoutMs,
            });
          }

          const verifiedStagingDir = await resolveVerifiedStagingDirectory(attachmentsDir);
          if (verifiedStagingDir._tag === "Missing") {
            const missingCursor = cursor;
            cursor = null;
            if (missingCursor) {
              await closeStagingRecoveryCursor(missingCursor, {
                force: true,
                remainingTimeoutMs,
              });
            }
            return { inspected, removed, failures, passes, exhausted: true };
          }
          if (verifiedStagingDir._tag === "Unsafe") {
            const unsafeCursor = cursor;
            cursor = null;
            if (unsafeCursor) {
              await closeStagingRecoveryCursor(unsafeCursor, {
                force: true,
                remainingTimeoutMs,
              });
            }
            return { inspected, removed, failures: 1, passes, exhausted: true };
          }

          if (!cursor) {
            let resources: PinnedStagingResources;
            try {
              resources = await openPinnedStagingResources({
                staging: verifiedStagingDir,
                remainingTimeoutMs,
                ...(input.beforePinnedSessionReady
                  ? { beforeReady: input.beforePinnedSessionReady }
                  : {}),
                ...(input.waitForPinnedSessionForceClose
                  ? { waitForForceClose: input.waitForPinnedSessionForceClose }
                  : {}),
                ...(input.onDeferredCleanup ? { onDeferredCleanup: input.onDeferredCleanup } : {}),
              });
            } catch (cause) {
              if (cause instanceof ManagedAttachmentStagingDeadlineExceeded) {
                return { inspected, removed, failures, passes, exhausted: false };
              }
              throw cause;
            }
            if (resources._tag === "Missing") {
              return { inspected, removed, failures, passes, exhausted: true };
            }
            if (resources._tag === "Unsafe") {
              return { inspected, removed, failures: 1, passes, exhausted: true };
            }
            cursor = {
              attachmentsDir,
              realStagingDir: verifiedStagingDir.realPath,
              directoryIdentity: verifiedStagingDir.identity,
              directory: resources.directory,
              pinnedDeleteSession: resources.session,
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
              const read = await readDirectoryEntryWithinDeadline({
                directory: activeCursor.directory,
                remainingTimeoutMs,
                ...(input.readDirectoryEntry ? { read: input.readDirectoryEntry } : {}),
              });
              if (read._tag === "DeadlineExceeded") {
                passes += passInspected > 0 ? 1 : 0;
                inspected += passInspected;
                removed += passRemoved;
                failures += passFailures;
                cursor = null;
                await closeStagingRecoveryCursor(activeCursor, {
                  force: true,
                  remainingTimeoutMs,
                  ...(read.settled ? { pendingDirectoryRead: read.settled } : {}),
                  onDeferredDirectoryClose: (completion) => {
                    const deferred = { completion, settled: false };
                    deferredCursorClose = deferred;
                    input.onDeferredCleanup?.(completion);
                    void completion.then(() => {
                      deferred.settled = true;
                    });
                  },
                });
                return { inspected, removed, failures, passes, exhausted: false };
              }
              const entry = read.entry;
              if (entry === null) {
                exhausted = true;
                break;
              }
              passInspected += 1;
              let result: { readonly removed: number; readonly failures: number };
              try {
                result = await processManagedAttachmentStagingEntry({
                  sweep: { ...input, skipLocked: true },
                  realStagingDir: activeCursor.realStagingDir,
                  pinnedDeleteSession: activeCursor.pinnedDeleteSession,
                  entryName: entry.name,
                  staleBeforeMs: activeCursor.staleBeforeMs,
                  remainingTimeoutMs,
                });
              } catch (cause) {
                if (!(cause instanceof ManagedAttachmentStagingDeadlineExceeded)) throw cause;
                passes += 1;
                inspected += passInspected;
                removed += passRemoved;
                failures += passFailures;
                cursor = null;
                await closeStagingRecoveryCursor(activeCursor, {
                  force: true,
                  remainingTimeoutMs,
                });
                return { inspected, removed, failures, passes, exhausted: false };
              }
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
            await closeStagingRecoveryCursor(activeCursor, {
              force: true,
              remainingTimeoutMs,
            });
          }
          return { inspected, removed, failures, passes, exhausted };
        } catch (cause) {
          const failedCursor = cursor;
          cursor = null;
          if (failedCursor) {
            await closeStagingRecoveryCursor(failedCursor, {
              force: true,
              remainingTimeoutMs: () => 0,
            }).catch(() => undefined);
          }
          throw cause;
        } finally {
          activeRuns.delete(completion);
          completeRun();
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
    const deferredCleanup = makeManagedAttachmentDeferredCleanupTracker();
    const stagingRecovery = makeManagedAttachmentStagingRecovery();
    yield* Effect.addFinalizer(() => {
      const closeRecovery = stagingRecovery.close.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to close managed attachment staging recovery cursor", {
            cause,
          }),
        ),
      );
      const drainDeferredCleanup = Effect.tryPromise({
        try: deferredCleanup.drain,
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to drain deferred managed attachment staging cleanup", {
            cause,
          }),
        ),
      );
      return closeRecovery.pipe(Effect.andThen(drainDeferredCleanup));
    });
    const runBatch = cleanupLock.withPermits(1)(
      runManagedAttachmentCleanupBatch.pipe(
        Effect.provideService(ManagedAttachmentRepository, repository),
        Effect.provideService(ServerConfig, config),
      ),
    );
    const runStartupStagingSweep = stagingRecoveryLock.withPermits(1)(
      Effect.tryPromise({
        try: () => {
          const operation = sweepOrphanManagedAttachmentParts({
            attachmentsDir: config.attachmentsDir,
            timeBudgetMs: MANAGED_ATTACHMENT_STAGING_STARTUP_TIME_MS,
            skipLocked: true,
            onDeferredCleanup: deferredCleanup.track,
          });
          deferredCleanup.track(
            operation.then(
              () => undefined,
              () => undefined,
            ),
          );
          return operation;
        },
        catch: (cause) => cause,
      }),
    );
    const runStagingRecovery = stagingRecoveryLock.withPermits(1)(
      stagingRecovery.run({
        attachmentsDir: config.attachmentsDir,
        onDeferredCleanup: deferredCleanup.track,
      }),
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
