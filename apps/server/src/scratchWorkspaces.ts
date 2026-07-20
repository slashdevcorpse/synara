// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). Files agents create here are workspace-equivalent, so the
//          local-preview allowlist also treats this root as servable.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import { mkdirSync, type Stats, utimesSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";

export const SCRATCH_WORKSPACE_MAX_IDLE_MS = 24 * 60 * 60 * 1_000;
const SCRATCH_WORKSPACE_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*-[0-9a-f]{12}$/u;

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

export function ensureIsolatedScratchWorkspace(threadId: ThreadId): string {
  const workspaceDir = resolveIsolatedScratchWorkspace(threadId);
  mkdirSync(workspaceDir, { recursive: true });
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

function isSamePathIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function resolveVerifiedScratchRoot(rootDir: string): Promise<{
  readonly realRoot: string;
  readonly identity: Stats;
} | null> {
  const resolvedRoot = path.resolve(rootDir);
  let identity: Stats;
  try {
    identity = await fs.lstat(resolvedRoot);
  } catch (cause) {
    if (isMissingPathError(cause)) return null;
    throw cause;
  }
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error("Scratch workspace root is not a managed directory.");
  }

  const realRoot = await fs.realpath(resolvedRoot);
  const verifiedIdentity = await fs.lstat(resolvedRoot);
  if (
    verifiedIdentity.isSymbolicLink() ||
    !verifiedIdentity.isDirectory() ||
    !isSamePathIdentity(identity, verifiedIdentity)
  ) {
    throw new Error("Scratch workspace root changed during verification.");
  }
  return { realRoot, identity };
}

export async function removeIsolatedScratchWorkspace(
  threadId: ThreadId,
  options: { readonly rootDir?: string } = {},
): Promise<void> {
  const workspaceRoot = options.rootDir ?? resolveScratchWorkspacesRoot();
  const verifiedRoot = await resolveVerifiedScratchRoot(workspaceRoot);
  if (!verifiedRoot) return;

  const workspaceDir = path.join(verifiedRoot.realRoot, scratchWorkspaceSegment(threadId));
  if (!isPathInside(workspaceDir, verifiedRoot.realRoot)) {
    throw new Error("Scratch workspace deletion target escaped its managed root.");
  }
  const workspaceIdentity = await fs.lstat(workspaceDir).catch((cause) => {
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

  const finalRootIdentity = await fs.lstat(path.resolve(workspaceRoot));
  if (
    finalRootIdentity.isSymbolicLink() ||
    !finalRootIdentity.isDirectory() ||
    !isSamePathIdentity(verifiedRoot.identity, finalRootIdentity)
  ) {
    throw new Error("Scratch workspace root changed before deletion.");
  }

  const finalWorkspaceIdentity = await fs.lstat(workspaceDir).catch((cause) => {
    if (isMissingPathError(cause)) return null;
    throw cause;
  });
  if (!finalWorkspaceIdentity) return;
  if (
    finalWorkspaceIdentity.isSymbolicLink() ||
    !finalWorkspaceIdentity.isDirectory() ||
    !isSamePathIdentity(workspaceIdentity, finalWorkspaceIdentity)
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
  await fs.rm(realWorkspace, { recursive: true, force: true });
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
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !SCRATCH_WORKSPACE_SEGMENT_PATTERN.test(entry.name)
    ) {
      result.preservedUnsafe += 1;
      continue;
    }
    if (activeSegments.has(entry.name)) {
      result.preservedActive += 1;
      continue;
    }

    const candidate = path.join(realRoot, entry.name);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat || nowMs - stat.mtimeMs < maxIdleMs) continue;
    const realCandidate = await fs.realpath(candidate).catch(() => null);
    if (!realCandidate || !isPathInside(realCandidate, realRoot)) {
      result.preservedUnsafe += 1;
      continue;
    }
    await input.beforeFinalDelete?.(candidate);

    const finalRootIdentity = await fs.lstat(path.resolve(rootDir)).catch(() => null);
    if (
      !finalRootIdentity ||
      finalRootIdentity.isSymbolicLink() ||
      !finalRootIdentity.isDirectory() ||
      !isSamePathIdentity(verifiedRoot.identity, finalRootIdentity)
    ) {
      result.preservedUnsafe += 1;
      break;
    }

    const finalCandidateIdentity = await fs.lstat(candidate).catch(() => null);
    if (
      !finalCandidateIdentity ||
      finalCandidateIdentity.isSymbolicLink() ||
      !finalCandidateIdentity.isDirectory() ||
      !isSamePathIdentity(stat, finalCandidateIdentity)
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

    await fs.rm(realCandidate, { recursive: true, force: true });
    result.removed += 1;
  }
  return result;
}
