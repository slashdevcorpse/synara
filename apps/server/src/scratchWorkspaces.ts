// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). Files agents create here are workspace-equivalent, so the
//          local-preview allowlist also treats this root as servable.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type BigIntStats,
  utimesSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";

import { runProcess } from "./processRunner";
import { PRIVATE_DIRECTORY_MODE, supportsPosixPermissions } from "./privatePathPermissions";

export const SCRATCH_WORKSPACE_MAX_IDLE_MS = 24 * 60 * 60 * 1_000;
const SCRATCH_WORKSPACE_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*-[0-9a-f]{12}$/u;
const SCRATCH_WORKSPACE_QUARANTINE_PATTERN =
  /^\.synara-scratch-([A-Za-z0-9_-][A-Za-z0-9._-]*-[0-9a-f]{12})\.deleting-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PINNED_DELETE_TIMEOUT_MS = 10_000;
const PINNED_DELETE_ROOT_UNSAFE_EXIT = 72;
const PINNED_DELETE_MISSING_EXIT = 73;
const PINNED_DELETE_CANDIDATE_UNSAFE_EXIT = 74;
const PINNED_DELETE_FAILED_EXIT = 75;
const PINNED_DELETE_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const [candidateName, candidateKind, rootDev, rootIno, candidateDev, candidateIno] = process.argv.slice(1);
const ROOT_UNSAFE = 72;
const MISSING = 73;
const CANDIDATE_UNSAFE = 74;
const FAILED = 75;
const sameIdentity = (stat, dev, ino) => String(stat.dev) === dev && String(stat.ino) === ino;
const fail = (code, detail) => {
  if (detail) process.stderr.write(String(detail).slice(0, 2048));
  process.exit(code);
};
if (!candidateName || path.basename(candidateName) !== candidateName || candidateName === "." || candidateName === "..") {
  fail(CANDIDATE_UNSAFE, "invalid candidate basename");
}
let quarantineName = null;
try {
  const rootStat = fs.lstatSync(".", { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sameIdentity(rootStat, rootDev, rootIno)) {
    fail(ROOT_UNSAFE, "managed root identity mismatch");
  }
  let candidateStat;
  try {
    candidateStat = fs.lstatSync(candidateName, { bigint: true });
  } catch (cause) {
    if (cause && cause.code === "ENOENT") fail(MISSING);
    throw cause;
  }
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink() || !sameIdentity(candidateStat, candidateDev, candidateIno)) {
    fail(CANDIDATE_UNSAFE, "candidate identity mismatch");
  }
  if (candidateKind === "quarantine") {
    fs.rmSync(candidateName, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
    process.exit(0);
  }
  quarantineName = ".synara-scratch-" + candidateName + ".deleting-" + randomUUID();
  fs.renameSync(candidateName, quarantineName);
  const quarantinedStat = fs.lstatSync(quarantineName, { bigint: true });
  if (!quarantinedStat.isDirectory() || quarantinedStat.isSymbolicLink() || !sameIdentity(quarantinedStat, candidateDev, candidateIno)) {
    try { fs.renameSync(quarantineName, candidateName); } catch {}
    fail(CANDIDATE_UNSAFE, "quarantined candidate identity mismatch");
  }
  fs.rmSync(quarantineName, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  process.exit(0);
} catch (cause) {
  if (quarantineName) {
    try {
      if (!fs.existsSync(candidateName) && fs.existsSync(quarantineName)) {
        fs.renameSync(quarantineName, candidateName);
      }
    } catch {}
  }
  fail(FAILED, cause && (cause.code || cause.message) || cause);
}
`;

export function scratchWorkspaceSegment(threadId: ThreadId): string {
  const raw = String(threadId);
  const safePrefix = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/g, "")
    .slice(0, 64);
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safePrefix || "thread"}-${digest}`;
}

export function resolveScratchWorkspacesRoot(): string {
  return path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME);
}

export function resolveIsolatedScratchWorkspace(threadId: ThreadId): string {
  return path.join(resolveScratchWorkspacesRoot(), scratchWorkspaceSegment(threadId));
}

function repairManagedScratchDirectoryPermissions(
  directoryPath: string,
  expectedIdentity: BigIntStats,
  label: "root" | "target",
): void {
  if (!supportsPosixPermissions()) return;

  let descriptor: number;
  try {
    descriptor = openSync(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (cause) {
    throw new Error(`Scratch workspace ${label} changed before permission repair.`, { cause });
  }
  try {
    const openedIdentity = fstatSync(descriptor, { bigint: true });
    if (
      !openedIdentity.isDirectory() ||
      !isSameBigIntPathIdentity(expectedIdentity, openedIdentity)
    ) {
      throw new Error(`Scratch workspace ${label} changed before permission repair.`);
    }
    fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
  } finally {
    closeSync(descriptor);
  }

  const repairedIdentity = lstatSync(directoryPath, { bigint: true });
  if (
    repairedIdentity.isSymbolicLink() ||
    !repairedIdentity.isDirectory() ||
    !isSameBigIntPathIdentity(expectedIdentity, repairedIdentity)
  ) {
    throw new Error(`Scratch workspace ${label} changed during permission repair.`);
  }
}

function ensureManagedScratchDirectory(
  directoryPath: string,
  label: "root" | "target",
): { readonly identity: BigIntStats; readonly realPath: string } {
  try {
    mkdirSync(directoryPath, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (cause) {
    if (!isExistingPathError(cause)) throw cause;
  }

  const identity = lstatSync(directoryPath, { bigint: true });
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`Scratch workspace ${label} is not a managed directory.`);
  }
  const realPath = realpathSync(directoryPath);
  const verifiedIdentity = lstatSync(directoryPath, { bigint: true });
  if (
    verifiedIdentity.isSymbolicLink() ||
    !verifiedIdentity.isDirectory() ||
    !isSameBigIntPathIdentity(identity, verifiedIdentity)
  ) {
    throw new Error(`Scratch workspace ${label} changed during creation.`);
  }
  repairManagedScratchDirectoryPermissions(directoryPath, verifiedIdentity, label);
  return { identity, realPath };
}

export function ensureIsolatedScratchWorkspace(
  threadId: ThreadId,
  options: { readonly rootDir?: string } = {},
): string {
  const configuredRoot = path.resolve(options.rootDir ?? resolveScratchWorkspacesRoot());
  const realParent = realpathSync(path.dirname(configuredRoot));
  const root = ensureManagedScratchDirectory(configuredRoot, "root");
  const rootRelativeToParent = path.relative(realParent, root.realPath);
  if (
    rootRelativeToParent === "" ||
    rootRelativeToParent.startsWith("..") ||
    path.isAbsolute(rootRelativeToParent) ||
    rootRelativeToParent.includes(path.sep)
  ) {
    throw new Error("Scratch workspace root escaped its configured parent.");
  }

  const workspaceDir = path.join(root.realPath, scratchWorkspaceSegment(threadId));
  if (!isPathInside(workspaceDir, root.realPath)) {
    throw new Error("Scratch workspace creation target escaped its managed root.");
  }
  const workspace = ensureManagedScratchDirectory(workspaceDir, "target");
  const workspaceRelativeToRoot = path.relative(root.realPath, workspace.realPath);
  if (
    workspaceRelativeToRoot === "" ||
    workspaceRelativeToRoot.startsWith("..") ||
    path.isAbsolute(workspaceRelativeToRoot) ||
    workspaceRelativeToRoot.includes(path.sep)
  ) {
    throw new Error("Scratch workspace creation target escaped its managed root.");
  }

  const finalRootIdentity = lstatSync(configuredRoot, { bigint: true });
  const finalWorkspaceIdentity = lstatSync(workspaceDir, { bigint: true });
  if (
    finalRootIdentity.isSymbolicLink() ||
    !finalRootIdentity.isDirectory() ||
    !isSameBigIntPathIdentity(root.identity, finalRootIdentity)
  ) {
    throw new Error("Scratch workspace root changed during workspace creation.");
  }
  if (
    finalWorkspaceIdentity.isSymbolicLink() ||
    !finalWorkspaceIdentity.isDirectory() ||
    !isSameBigIntPathIdentity(workspace.identity, finalWorkspaceIdentity) ||
    path.resolve(realpathSync(workspaceDir)) !== path.resolve(workspace.realPath)
  ) {
    throw new Error("Scratch workspace changed during creation.");
  }

  const now = new Date();
  utimesSync(workspaceDir, now, now);
  return workspaceDir;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingPathError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isExistingPathError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "EEXIST"
  );
}

function isSameBigIntPathIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolveVerifiedScratchRoot(rootDir: string): Promise<{
  readonly realRoot: string;
  readonly identity: BigIntStats;
} | null> {
  const resolvedRoot = path.resolve(rootDir);
  let identity: BigIntStats;
  try {
    identity = await fs.lstat(resolvedRoot, { bigint: true });
  } catch (cause) {
    if (isMissingPathError(cause)) return null;
    throw cause;
  }
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error("Scratch workspace root is not a managed directory.");
  }

  const realRoot = await fs.realpath(resolvedRoot);
  const verifiedIdentity = await fs.lstat(resolvedRoot, { bigint: true });
  if (
    verifiedIdentity.isSymbolicLink() ||
    !verifiedIdentity.isDirectory() ||
    !isSameBigIntPathIdentity(identity, verifiedIdentity)
  ) {
    throw new Error("Scratch workspace root changed during verification.");
  }
  return { realRoot, identity };
}

type PinnedDeleteResult = "removed" | "missing" | "root-unsafe" | "candidate-unsafe";

async function removePinnedScratchDirectory(input: {
  readonly realRoot: string;
  readonly rootIdentity: BigIntStats;
  readonly candidateName: string;
  readonly candidateIdentity: BigIntStats;
  readonly kind: "workspace" | "quarantine";
}): Promise<PinnedDeleteResult> {
  if (path.basename(input.candidateName) !== input.candidateName) {
    throw new Error("Scratch workspace deletion target is not a basename.");
  }
  const result = await runProcess(
    process.execPath,
    [
      "--eval",
      PINNED_DELETE_SCRIPT,
      input.candidateName,
      input.kind,
      input.rootIdentity.dev.toString(10),
      input.rootIdentity.ino.toString(10),
      input.candidateIdentity.dev.toString(10),
      input.candidateIdentity.ino.toString(10),
    ],
    {
      cwd: input.realRoot,
      timeoutMs: PINNED_DELETE_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: 4_096,
      outputMode: "truncate",
    },
  );
  if (result.timedOut) {
    throw new Error("Pinned scratch workspace deletion timed out.");
  }
  switch (result.code) {
    case 0:
      return "removed";
    case PINNED_DELETE_MISSING_EXIT:
      return "missing";
    case PINNED_DELETE_ROOT_UNSAFE_EXIT:
      return "root-unsafe";
    case PINNED_DELETE_CANDIDATE_UNSAFE_EXIT:
      return "candidate-unsafe";
    case PINNED_DELETE_FAILED_EXIT:
    default: {
      const detail = result.stderr.trim().slice(0, 2_048);
      throw new Error(
        `Pinned scratch workspace deletion failed (code=${result.code ?? "null"}).${detail ? ` ${detail}` : ""}`,
      );
    }
  }
}

export async function removeIsolatedScratchWorkspace(
  threadId: ThreadId,
  options: {
    readonly rootDir?: string;
    /** Test seam for a replacement after parent validation but before child pinning. */
    readonly beforePinnedDelete?: (candidatePath: string) => Promise<void>;
  } = {},
): Promise<void> {
  const workspaceRoot = options.rootDir ?? resolveScratchWorkspacesRoot();
  const verifiedRoot = await resolveVerifiedScratchRoot(workspaceRoot);
  if (!verifiedRoot) return;

  const workspaceDir = path.join(verifiedRoot.realRoot, scratchWorkspaceSegment(threadId));
  if (!isPathInside(workspaceDir, verifiedRoot.realRoot)) {
    throw new Error("Scratch workspace deletion target escaped its managed root.");
  }
  const workspaceIdentity = await fs.lstat(workspaceDir, { bigint: true }).catch((cause) => {
    if (isMissingPathError(cause)) return null;
    throw cause;
  });
  if (!workspaceIdentity) return;
  if (workspaceIdentity.isSymbolicLink() || !workspaceIdentity.isDirectory()) {
    throw new Error("Scratch workspace deletion target is not a managed directory.");
  }
  const realWorkspace = await fs.realpath(workspaceDir);
  if (!isPathInside(realWorkspace, verifiedRoot.realRoot)) {
    throw new Error("Scratch workspace deletion target escaped its managed root.");
  }

  const finalRootIdentity = await fs.lstat(path.resolve(workspaceRoot), { bigint: true });
  if (
    finalRootIdentity.isSymbolicLink() ||
    !finalRootIdentity.isDirectory() ||
    !isSameBigIntPathIdentity(verifiedRoot.identity, finalRootIdentity)
  ) {
    throw new Error("Scratch workspace root changed before deletion.");
  }

  const finalWorkspaceIdentity = await fs.lstat(workspaceDir, { bigint: true }).catch((cause) => {
    if (isMissingPathError(cause)) return null;
    throw cause;
  });
  if (!finalWorkspaceIdentity) return;
  if (
    finalWorkspaceIdentity.isSymbolicLink() ||
    !finalWorkspaceIdentity.isDirectory() ||
    !isSameBigIntPathIdentity(workspaceIdentity, finalWorkspaceIdentity)
  ) {
    throw new Error("Scratch workspace deletion target changed before deletion.");
  }
  const finalRealWorkspace = await fs.realpath(workspaceDir);
  if (
    path.resolve(finalRealWorkspace) !== path.resolve(realWorkspace) ||
    !isPathInside(finalRealWorkspace, verifiedRoot.realRoot)
  ) {
    throw new Error("Scratch workspace deletion target changed before deletion.");
  }
  await options.beforePinnedDelete?.(workspaceDir);
  const deletion = await removePinnedScratchDirectory({
    realRoot: verifiedRoot.realRoot,
    rootIdentity: verifiedRoot.identity,
    candidateName: path.basename(workspaceDir),
    candidateIdentity: finalWorkspaceIdentity,
    kind: "workspace",
  });
  if (deletion === "root-unsafe") {
    throw new Error("Scratch workspace root changed before pinned deletion.");
  }
  if (deletion === "candidate-unsafe") {
    throw new Error("Scratch workspace deletion target changed before pinned deletion.");
  }
}

export interface ScratchWorkspaceSweepResult {
  readonly inspected: number;
  readonly removed: number;
  readonly preservedActive: number;
  readonly preservedUnsafe: number;
}

export async function sweepStaleScratchWorkspaces(input: {
  readonly activeThreadIds: ReadonlySet<string>;
  readonly rootDir?: string;
  readonly nowMs?: number;
  readonly maxIdleMs?: number;
  /** Test seam for a replacement race immediately before recursive deletion. */
  readonly beforeFinalDelete?: (candidatePath: string) => Promise<void>;
  /** Test seam for a replacement after parent validation but before child pinning. */
  readonly beforePinnedDelete?: (candidatePath: string) => Promise<void>;
}): Promise<ScratchWorkspaceSweepResult> {
  const rootDir = input.rootDir ?? resolveScratchWorkspacesRoot();
  const nowMs = input.nowMs ?? Date.now();
  const maxIdleMs = input.maxIdleMs ?? SCRATCH_WORKSPACE_MAX_IDLE_MS;
  const result = { inspected: 0, removed: 0, preservedActive: 0, preservedUnsafe: 0 };
  const verifiedRoot = await resolveVerifiedScratchRoot(rootDir);
  if (!verifiedRoot) return result;
  let entries;
  try {
    entries = await fs.readdir(verifiedRoot.realRoot, { withFileTypes: true });
  } catch (cause) {
    if (isMissingPathError(cause)) return result;
    throw cause;
  }

  const realRoot = verifiedRoot.realRoot;
  const activeSegments = new Set(
    Array.from(input.activeThreadIds, (threadId) =>
      scratchWorkspaceSegment(ThreadId.makeUnsafe(threadId)),
    ),
  );
  for (const entry of entries) {
    result.inspected += 1;
    const quarantineMatch = SCRATCH_WORKSPACE_QUARANTINE_PATTERN.exec(entry.name);
    const workspaceSegment = quarantineMatch?.[1] ?? entry.name;
    const candidateKind = quarantineMatch ? "quarantine" : "workspace";
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (candidateKind === "workspace" && !SCRATCH_WORKSPACE_SEGMENT_PATTERN.test(entry.name))
    ) {
      result.preservedUnsafe += 1;
      continue;
    }
    if (candidateKind === "workspace" && activeSegments.has(workspaceSegment)) {
      result.preservedActive += 1;
      continue;
    }

    const candidate = path.join(realRoot, entry.name);
    const bigintStat = await fs.lstat(candidate, { bigint: true }).catch(() => null);
    if (!bigintStat || !bigintStat.isDirectory() || bigintStat.isSymbolicLink()) {
      result.preservedUnsafe += 1;
      continue;
    }
    if (nowMs - Number(bigintStat.mtimeMs) < maxIdleMs) continue;
    const realCandidate = await fs.realpath(candidate).catch(() => null);
    if (!realCandidate || !isPathInside(realCandidate, realRoot)) {
      result.preservedUnsafe += 1;
      continue;
    }
    await input.beforeFinalDelete?.(candidate);

    const finalRootIdentity = await fs
      .lstat(path.resolve(rootDir), { bigint: true })
      .catch(() => null);
    if (
      !finalRootIdentity ||
      finalRootIdentity.isSymbolicLink() ||
      !finalRootIdentity.isDirectory() ||
      !isSameBigIntPathIdentity(verifiedRoot.identity, finalRootIdentity)
    ) {
      result.preservedUnsafe += 1;
      break;
    }

    const finalCandidateIdentity = await fs.lstat(candidate, { bigint: true }).catch(() => null);
    if (
      !finalCandidateIdentity ||
      finalCandidateIdentity.isSymbolicLink() ||
      !finalCandidateIdentity.isDirectory() ||
      !isSameBigIntPathIdentity(bigintStat, finalCandidateIdentity)
    ) {
      result.preservedUnsafe += 1;
      continue;
    }
    const finalRealCandidate = await fs.realpath(candidate).catch(() => null);
    if (
      !finalRealCandidate ||
      path.resolve(finalRealCandidate) !== path.resolve(realCandidate) ||
      !isPathInside(finalRealCandidate, realRoot)
    ) {
      result.preservedUnsafe += 1;
      continue;
    }
    await input.beforePinnedDelete?.(candidate);
    const deletion = await removePinnedScratchDirectory({
      realRoot,
      rootIdentity: verifiedRoot.identity,
      candidateName: entry.name,
      candidateIdentity: finalCandidateIdentity,
      kind: candidateKind,
    });
    if (deletion === "removed") {
      result.removed += 1;
    } else if (deletion === "root-unsafe") {
      result.preservedUnsafe += 1;
      break;
    } else if (deletion === "candidate-unsafe") {
      result.preservedUnsafe += 1;
    }
  }
  return result;
}
