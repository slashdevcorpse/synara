import type { Thread } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: readonly Thread[],
  threadId: Thread["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

function normalizeWorktreePathForDisplay(worktreePath: string): string {
  return worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function worktreePathBasename(worktreePath: string | null | undefined): string | null {
  const trimmed = worktreePath?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = normalizeWorktreePathForDisplay(trimmed);
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) {
    return null;
  }

  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : null;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = normalizeWorktreePathForDisplay(trimmed);
  return worktreePathBasename(trimmed) ?? (normalized || trimmed);
}
