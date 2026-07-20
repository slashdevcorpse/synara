// FILE: scratchWorkspaces.ts
// Purpose: Per-thread scratch working directories for provider sessions that
//          start before any project workspace exists (e.g. a chat's first
//          turn). Files agents create here are workspace-equivalent, so the
//          local-preview allowlist also treats this root as servable.
// Layer: Server filesystem utility
// Exports: ensureIsolatedScratchWorkspace

import { createHash } from "node:crypto";
import { mkdirSync, utimesSync } from "node:fs";
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

export async function removeIsolatedScratchWorkspace(threadId: ThreadId): Promise<void> {
  const workspaceRoot = resolveScratchWorkspacesRoot();
  const workspaceDir = resolveIsolatedScratchWorkspace(threadId);
  if (!isPathInside(workspaceDir, workspaceRoot)) {
    throw new Error("Scratch workspace deletion target escaped its managed root.");
  }
  await fs.rm(workspaceDir, { recursive: true, force: true });
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
}): Promise<ScratchWorkspaceSweepResult> {
  const rootDir = input.rootDir ?? resolveScratchWorkspacesRoot();
  const nowMs = input.nowMs ?? Date.now();
  const maxIdleMs = input.maxIdleMs ?? SCRATCH_WORKSPACE_MAX_IDLE_MS;
  const result = { inspected: 0, removed: 0, preservedActive: 0, preservedUnsafe: 0 };
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (cause) {
    if (isMissingPathError(cause)) return result;
    throw cause;
  }

  const realRoot = await fs.realpath(rootDir);
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

    const candidate = path.join(rootDir, entry.name);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat || nowMs - stat.mtimeMs < maxIdleMs) continue;
    const realCandidate = await fs.realpath(candidate).catch(() => null);
    if (!realCandidate || !isPathInside(realCandidate, realRoot)) {
      result.preservedUnsafe += 1;
      continue;
    }
    await fs.rm(candidate, { recursive: true, force: true });
    result.removed += 1;
  }
  return result;
}
