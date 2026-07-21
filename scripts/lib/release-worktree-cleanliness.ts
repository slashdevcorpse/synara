// FILE: release-worktree-cleanliness.ts
// Purpose: Proves release source bytes still match HEAD while admitting only declared output roots.
// Layer: Release provenance

import { spawnSync } from "node:child_process";

export interface ReleaseWorktreeCleanlinessInput {
  readonly trackedPaths: ReadonlyArray<string>;
  readonly untrackedPaths: ReadonlyArray<string>;
  readonly allowedOutputRoots: ReadonlyArray<string>;
}

function normalizeOutputRoot(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Release output root must be a normalized repository-relative path: ${value}.`);
  }
  return normalized;
}

export function validateReleaseWorktreeCleanliness(input: ReleaseWorktreeCleanlinessInput): void {
  if (input.trackedPaths.length > 0) {
    throw new Error(
      `Tracked release source bytes differ from the recorded HEAD commit: ${input.trackedPaths.join(", ")}.`,
    );
  }
  const allowedRoots = input.allowedOutputRoots.map(normalizeOutputRoot);
  const unexpected = input.untrackedPaths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !allowedRoots.some((root) => path === root || path.startsWith(`${root}/`)));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected untracked release input outside declared output roots: ${unexpected.join(", ")}.`,
    );
  }
}

function runGit(
  repoRoot: string,
  args: ReadonlyArray<string>,
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw new Error(`git could not start: ${result.error.message}`);
  return {
    status: result.status ?? -1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export function verifyReleaseWorktreeCleanliness(
  repoRoot: string,
  allowedOutputRoots: ReadonlyArray<string> = [],
): void {
  const diff = runGit(repoRoot, ["diff", "--name-only", "--no-ext-diff", "-z", "HEAD", "--", "."]);
  if (diff.status !== 0) {
    throw new Error(`Unable to compare release worktree with HEAD: ${diff.stderr.trim()}.`);
  }
  const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.status !== 0) {
    throw new Error(`Unable to enumerate untracked release files: ${untracked.stderr.trim()}.`);
  }
  validateReleaseWorktreeCleanliness({
    trackedPaths: diff.stdout.split("\0").filter(Boolean),
    untrackedPaths: untracked.stdout.split("\0").filter(Boolean),
    allowedOutputRoots,
  });
}
