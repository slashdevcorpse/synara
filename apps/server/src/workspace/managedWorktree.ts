import type { ServerManagedWorktree } from "@synara/contracts";
import { Cause, Effect, Exit } from "effect";
import type { Path } from "effect";
import type { Dirent } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import type { GitCoreShape } from "../git/Services/GitCore";

const MAX_MANAGED_WORKTREE_PARENT_ENTRIES = 2_048;
const MAX_MANAGED_WORKTREE_CHILD_ENTRIES = 2_048;
const MAX_MANAGED_WORKTREE_CANDIDATES = 4_096;
const MAX_GIT_POINTER_BYTES = 16 * 1_024;

export interface ManagedWorktreeScanLimits {
  readonly maxParentEntries?: number;
  readonly maxChildEntriesPerParent?: number;
  readonly maxCandidates?: number;
}

export interface ManagedWorktreeThreadReference {
  readonly worktreePath?: string | null;
  readonly associatedWorktreePath?: string | null;
  readonly deletedAt?: string | null;
}

export type ManagedWorktreeIssueReason =
  | "dirty"
  | "escaped"
  | "invalid-git-pointer"
  | "malformed"
  | "remove-failed"
  | "status-failed"
  | "symlink"
  | "traversal-limit";

export interface ManagedWorktreeIssue {
  readonly path: string;
  readonly reason: ManagedWorktreeIssueReason;
  readonly detail: string;
}

export interface ScannedManagedWorktree extends ServerManagedWorktree {
  readonly realPath: string;
}

export interface ManagedWorktreeScanResult {
  readonly worktrees: ReadonlyArray<ScannedManagedWorktree>;
  readonly issues: ReadonlyArray<ManagedWorktreeIssue>;
}

export interface ManagedWorktreeReconciliationResult {
  readonly worktrees: ReadonlyArray<ServerManagedWorktree>;
  readonly linked: ReadonlyArray<ServerManagedWorktree>;
  readonly removed: ReadonlyArray<ServerManagedWorktree>;
  readonly issues: ReadonlyArray<ManagedWorktreeIssue>;
}

type ManagedWorktreeGit = Pick<GitCoreShape, "removeWorktree" | "statusDetails">;

interface ParsedManagedWorktreeGitPointer {
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly workspaceRoot: string;
}

function parseManagedWorktreeGitPointer(input: {
  readonly gitPointerFileContents: string;
  readonly path: Pick<Path.Path, "basename" | "dirname" | "isAbsolute" | "normalize" | "resolve">;
  readonly worktreePath: string;
}): ParsedManagedWorktreeGitPointer | null {
  if (input.gitPointerFileContents.includes("\0")) return null;
  const lines = input.gitPointerFileContents.split(/\r?\n/);
  const firstLine = lines.shift()?.trim() ?? "";
  if (lines.some((line) => line.trim().length > 0)) return null;
  if (!firstLine.toLowerCase().startsWith("gitdir:")) return null;

  const gitdirValue = firstLine.slice("gitdir:".length).trim();
  if (!gitdirValue) return null;

  const gitDir = input.path.isAbsolute(gitdirValue)
    ? input.path.normalize(gitdirValue)
    : input.path.resolve(input.worktreePath, gitdirValue);
  const adminName = input.path.basename(gitDir);
  const worktreesAdminRoot = input.path.dirname(gitDir);
  const commonGitDir = input.path.dirname(worktreesAdminRoot);
  if (
    adminName.length === 0 ||
    input.path.basename(worktreesAdminRoot).toLowerCase() !== "worktrees" ||
    input.path.basename(commonGitDir).toLowerCase() !== ".git"
  ) {
    return null;
  }

  return {
    gitDir,
    commonGitDir,
    workspaceRoot: input.path.dirname(commonGitDir),
  };
}

export const parseManagedWorktreeWorkspaceRoot = (input: {
  readonly gitPointerFileContents: string;
  readonly path: Path.Path;
  readonly worktreePath: string;
}): string | null => parseManagedWorktreeGitPointer(input)?.workspaceRoot ?? null;

function errorDetail(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
}

function isMissingPathError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
}

function pathIdentity(value: string): string {
  const normalized = nodePath.normalize(nodePath.resolve(value)).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right);
}

function isStrictlyContainedPath(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

async function readBoundedRegularFile(filePath: string): Promise<string> {
  const stats = await nodeFs.lstat(filePath);
  if (stats.isSymbolicLink()) throw new Error("symbolic links are not allowed");
  if (!stats.isFile()) throw new Error("expected a regular file");
  if (stats.size > MAX_GIT_POINTER_BYTES) {
    throw new Error(`file exceeds ${MAX_GIT_POINTER_BYTES} bytes`);
  }
  return nodeFs.readFile(filePath, "utf8");
}

async function requireRegularDirectory(directoryPath: string): Promise<void> {
  const stats = await nodeFs.lstat(directoryPath);
  if (stats.isSymbolicLink()) throw new Error("symbolic links and junctions are not allowed");
  if (!stats.isDirectory()) throw new Error("expected a regular directory");
}

async function readBoundedDirectory(
  directoryPath: string,
  limit: number,
): Promise<{ readonly entries: ReadonlyArray<Dirent>; readonly truncated: boolean }> {
  const entries: Dirent[] = [];
  let truncated = false;
  const directory = await nodeFs.opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entries, truncated };
}

async function validateManagedWorktreeCandidate(input: {
  readonly candidatePath: string;
  readonly managedRootRealPath: string;
}): Promise<ScannedManagedWorktree> {
  const candidateRealPath = await nodeFs.realpath(input.candidatePath);
  if (!isStrictlyContainedPath(input.managedRootRealPath, candidateRealPath)) {
    throw Object.assign(new Error("candidate realpath escapes the managed worktree root"), {
      reason: "escaped" as const,
    });
  }

  const gitPointerPath = nodePath.join(input.candidatePath, ".git");
  const gitPointerFileContents = await readBoundedRegularFile(gitPointerPath);
  const parsed = parseManagedWorktreeGitPointer({
    gitPointerFileContents,
    path: nodePath as unknown as Path.Path,
    worktreePath: input.candidatePath,
  });
  if (!parsed) throw new Error(".git is not a valid linked-worktree pointer file");

  const worktreesAdminRoot = nodePath.dirname(parsed.gitDir);
  await requireRegularDirectory(parsed.workspaceRoot);
  await requireRegularDirectory(parsed.commonGitDir);
  await requireRegularDirectory(worktreesAdminRoot);
  await requireRegularDirectory(parsed.gitDir);

  const [workspaceRootRealPath, commonGitDirRealPath, worktreesAdminRootRealPath, gitDirRealPath] =
    await Promise.all([
      nodeFs.realpath(parsed.workspaceRoot),
      nodeFs.realpath(parsed.commonGitDir),
      nodeFs.realpath(worktreesAdminRoot),
      nodeFs.realpath(parsed.gitDir),
    ]);
  if (!pathsEqual(commonGitDirRealPath, nodePath.join(workspaceRootRealPath, ".git"))) {
    throw Object.assign(new Error("common Git directory escapes the parsed workspace root"), {
      reason: "escaped" as const,
    });
  }
  if (!pathsEqual(worktreesAdminRootRealPath, nodePath.join(commonGitDirRealPath, "worktrees"))) {
    throw Object.assign(
      new Error("worktree administrative root escapes the common Git directory"),
      {
        reason: "escaped" as const,
      },
    );
  }
  if (
    !isStrictlyContainedPath(worktreesAdminRootRealPath, gitDirRealPath) ||
    !pathsEqual(nodePath.dirname(gitDirRealPath), worktreesAdminRootRealPath)
  ) {
    throw Object.assign(new Error("worktree administrative directory is not directly contained"), {
      reason: "escaped" as const,
    });
  }

  const reversePointerContents = (
    await readBoundedRegularFile(nodePath.join(gitDirRealPath, "gitdir"))
  ).trim();
  if (!reversePointerContents || /[\r\n\0]/u.test(reversePointerContents)) {
    throw new Error("worktree administrative reverse pointer is malformed");
  }
  const reversePointerPath = nodePath.isAbsolute(reversePointerContents)
    ? nodePath.normalize(reversePointerContents)
    : nodePath.resolve(gitDirRealPath, reversePointerContents);
  const [gitPointerRealPath, reversePointerRealPath] = await Promise.all([
    nodeFs.realpath(gitPointerPath),
    nodeFs.realpath(reversePointerPath),
  ]);
  if (!pathsEqual(gitPointerRealPath, reversePointerRealPath)) {
    throw Object.assign(new Error("worktree administrative reverse pointer targets another path"), {
      reason: "escaped" as const,
    });
  }

  const commonDirContents = (
    await readBoundedRegularFile(nodePath.join(gitDirRealPath, "commondir"))
  ).trim();
  if (!commonDirContents || /[\r\n\0]/u.test(commonDirContents)) {
    throw new Error("worktree administrative common-directory pointer is malformed");
  }
  const resolvedCommonDir = nodePath.isAbsolute(commonDirContents)
    ? nodePath.normalize(commonDirContents)
    : nodePath.resolve(gitDirRealPath, commonDirContents);
  if (!pathsEqual(await nodeFs.realpath(resolvedCommonDir), commonGitDirRealPath)) {
    throw Object.assign(
      new Error("worktree common-directory pointer escapes the source repository"),
      {
        reason: "escaped" as const,
      },
    );
  }

  return {
    path: nodePath.normalize(candidateRealPath),
    workspaceRoot: nodePath.normalize(workspaceRootRealPath),
    realPath: candidateRealPath,
  };
}

async function scanManagedWorktreesPromise(
  worktreesDir: string,
  limits: ManagedWorktreeScanLimits,
): Promise<ManagedWorktreeScanResult> {
  const issues: ManagedWorktreeIssue[] = [];
  const worktrees: ScannedManagedWorktree[] = [];
  let inspectedCandidates = 0;
  const maxParentEntries = limits.maxParentEntries ?? MAX_MANAGED_WORKTREE_PARENT_ENTRIES;
  const maxChildEntriesPerParent =
    limits.maxChildEntriesPerParent ?? MAX_MANAGED_WORKTREE_CHILD_ENTRIES;
  const maxCandidates = limits.maxCandidates ?? MAX_MANAGED_WORKTREE_CANDIDATES;
  for (const [label, limit] of [
    ["maxParentEntries", maxParentEntries],
    ["maxChildEntriesPerParent", maxChildEntriesPerParent],
    ["maxCandidates", maxCandidates],
  ] as const) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      issues.push({
        path: worktreesDir,
        reason: "traversal-limit",
        detail: `${label} must be a positive safe integer`,
      });
      return { worktrees, issues };
    }
  }

  try {
    await requireRegularDirectory(worktreesDir);
  } catch (cause) {
    if (isMissingPathError(cause)) return { worktrees, issues };
    issues.push({
      path: worktreesDir,
      reason: errorDetail(cause).includes("symbolic") ? "symlink" : "malformed",
      detail: errorDetail(cause),
    });
    return { worktrees, issues };
  }

  let managedRootRealPath: string;
  let parents: Awaited<ReturnType<typeof readBoundedDirectory>>;
  try {
    managedRootRealPath = await nodeFs.realpath(worktreesDir);
    parents = await readBoundedDirectory(worktreesDir, maxParentEntries);
  } catch (cause) {
    issues.push({ path: worktreesDir, reason: "malformed", detail: errorDetail(cause) });
    return { worktrees, issues };
  }
  if (parents.truncated) {
    issues.push({
      path: worktreesDir,
      reason: "traversal-limit",
      detail: `managed worktree parent scan exceeded ${maxParentEntries} entries`,
    });
  }

  for (const parentEntry of parents.entries) {
    const parentPath = nodePath.join(worktreesDir, parentEntry.name);
    let parentStats: Awaited<ReturnType<typeof nodeFs.lstat>>;
    try {
      parentStats = await nodeFs.lstat(parentPath);
    } catch (cause) {
      issues.push({ path: parentPath, reason: "malformed", detail: errorDetail(cause) });
      continue;
    }
    if (parentStats.isSymbolicLink()) {
      issues.push({
        path: parentPath,
        reason: "symlink",
        detail: "managed worktree traversal does not follow symbolic links or junctions",
      });
      continue;
    }
    if (!parentStats.isDirectory()) {
      issues.push({ path: parentPath, reason: "malformed", detail: "expected a directory" });
      continue;
    }

    let children: Awaited<ReturnType<typeof readBoundedDirectory>>;
    try {
      children = await readBoundedDirectory(parentPath, maxChildEntriesPerParent);
    } catch (cause) {
      issues.push({ path: parentPath, reason: "malformed", detail: errorDetail(cause) });
      continue;
    }
    if (children.truncated) {
      issues.push({
        path: parentPath,
        reason: "traversal-limit",
        detail: `managed worktree child scan exceeded ${maxChildEntriesPerParent} entries`,
      });
    }

    for (const childEntry of children.entries) {
      const candidatePath = nodePath.join(parentPath, childEntry.name);
      if (inspectedCandidates >= maxCandidates) {
        issues.push({
          path: worktreesDir,
          reason: "traversal-limit",
          detail: `managed worktree scan reached its ${maxCandidates}-candidate inspection limit`,
        });
        return { worktrees, issues };
      }
      inspectedCandidates += 1;

      let candidateStats: Awaited<ReturnType<typeof nodeFs.lstat>>;
      try {
        candidateStats = await nodeFs.lstat(candidatePath);
      } catch (cause) {
        issues.push({ path: candidatePath, reason: "malformed", detail: errorDetail(cause) });
        continue;
      }
      if (candidateStats.isSymbolicLink()) {
        issues.push({
          path: candidatePath,
          reason: "symlink",
          detail: "managed worktree traversal does not follow symbolic links or junctions",
        });
        continue;
      }
      if (!candidateStats.isDirectory()) {
        issues.push({ path: candidatePath, reason: "malformed", detail: "expected a directory" });
        continue;
      }

      try {
        worktrees.push(
          await validateManagedWorktreeCandidate({ candidatePath, managedRootRealPath }),
        );
      } catch (cause) {
        const reason =
          typeof cause === "object" &&
          cause !== null &&
          "reason" in cause &&
          (cause as { readonly reason?: unknown }).reason === "escaped"
            ? "escaped"
            : errorDetail(cause).includes("symbolic")
              ? "symlink"
              : "invalid-git-pointer";
        issues.push({ path: candidatePath, reason, detail: errorDetail(cause) });
      }
    }
  }

  worktrees.sort((left, right) => left.path.localeCompare(right.path));
  return { worktrees, issues };
}

export function scanManagedWorktrees(
  worktreesDir: string,
  limits: ManagedWorktreeScanLimits = {},
): Effect.Effect<ManagedWorktreeScanResult> {
  return Effect.promise(() => scanManagedWorktreesPromise(worktreesDir, limits));
}

async function protectedThreadWorktreePaths(
  threads: ReadonlyArray<ManagedWorktreeThreadReference>,
): Promise<ReadonlySet<string>> {
  const protectedPaths = new Set<string>();
  for (const thread of threads) {
    if (thread.deletedAt != null) continue;
    for (const rawPath of [thread.worktreePath, thread.associatedWorktreePath]) {
      const candidate = rawPath?.trim();
      if (!candidate) continue;
      try {
        protectedPaths.add(pathIdentity(await nodeFs.realpath(candidate)));
      } catch {
        protectedPaths.add(pathIdentity(candidate));
      }
    }
  }
  return protectedPaths;
}

export function reconcileManagedWorktrees(input: {
  readonly worktreesDir: string;
  readonly threads: ReadonlyArray<ManagedWorktreeThreadReference>;
  readonly git: ManagedWorktreeGit;
  readonly pruneOrphans: boolean;
}): Effect.Effect<ManagedWorktreeReconciliationResult> {
  return Effect.gen(function* () {
    const scan = yield* scanManagedWorktrees(input.worktreesDir);
    const protectedPaths = yield* Effect.promise(() => protectedThreadWorktreePaths(input.threads));
    const issues = [...scan.issues];
    const linked: ServerManagedWorktree[] = [];
    const removed: ServerManagedWorktree[] = [];
    const remaining: ServerManagedWorktree[] = [];

    for (const candidate of scan.worktrees) {
      const publicWorktree = { path: candidate.path, workspaceRoot: candidate.workspaceRoot };
      if (protectedPaths.has(pathIdentity(candidate.realPath))) {
        linked.push(publicWorktree);
        remaining.push(publicWorktree);
        continue;
      }
      if (!input.pruneOrphans) {
        remaining.push(publicWorktree);
        continue;
      }

      const statusExit = yield* Effect.exit(input.git.statusDetails(candidate.path));
      if (Exit.isFailure(statusExit)) {
        issues.push({
          path: candidate.path,
          reason: "status-failed",
          detail: Cause.pretty(statusExit.cause),
        });
        remaining.push(publicWorktree);
        continue;
      }
      if (!statusExit.value.isRepo) {
        issues.push({
          path: candidate.path,
          reason: "status-failed",
          detail: "Git no longer recognizes this candidate as a repository",
        });
        remaining.push(publicWorktree);
        continue;
      }
      if (statusExit.value.hasWorkingTreeChanges) {
        issues.push({
          path: candidate.path,
          reason: "dirty",
          detail: "unmatched managed worktree has working tree changes",
        });
        remaining.push(publicWorktree);
        continue;
      }

      const removalExit = yield* Effect.exit(
        input.git.removeWorktree({
          cwd: candidate.workspaceRoot,
          path: candidate.path,
          force: false,
        }),
      );
      if (Exit.isFailure(removalExit)) {
        issues.push({
          path: candidate.path,
          reason: "remove-failed",
          detail: Cause.pretty(removalExit.cause),
        });
        remaining.push(publicWorktree);
        continue;
      }

      const stillExists = yield* Effect.promise(() =>
        nodeFs
          .lstat(candidate.path)
          .then(() => true)
          .catch((cause) => (isMissingPathError(cause) ? false : true)),
      );
      if (stillExists) {
        issues.push({
          path: candidate.path,
          reason: "remove-failed",
          detail: "git worktree remove returned successfully but the worktree path remains",
        });
        remaining.push(publicWorktree);
        continue;
      }
      removed.push(publicWorktree);
    }

    return {
      worktrees: remaining,
      linked,
      removed,
      issues,
    };
  });
}

export function logManagedWorktreeReconciliation(
  phase: "list" | "startup",
  result: ManagedWorktreeReconciliationResult,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const issue of result.issues) {
      yield* Effect.logWarning("managed worktree preserved during reconciliation", {
        phase,
        path: issue.path,
        reason: issue.reason,
        detail: issue.detail,
      });
    }
    if (phase === "startup" && result.removed.length > 0) {
      yield* Effect.logInfo("removed clean orphaned managed worktrees", {
        count: result.removed.length,
        paths: result.removed.map((worktree) => worktree.path),
      });
    }
  });
}
