import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Path } from "effect";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitCoreShape, GitStatusDetails } from "../git/Services/GitCore";
import {
  parseManagedWorktreeWorkspaceRoot,
  reconcileManagedWorktrees,
  scanManagedWorktrees,
} from "./managedWorktree";

const tempRoots = new Set<string>();

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-managed-worktrees-"));
  const realRoot = fs.realpathSync.native(root);
  tempRoots.add(realRoot);
  return realRoot;
}

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initializeRepository(root: string): string {
  const repository = path.join(root, "source-repository");
  fs.mkdirSync(repository, { recursive: true });
  runGit(repository, ["init"]);
  runGit(repository, ["config", "user.name", "Synara Test"]);
  runGit(repository, ["config", "user.email", "synara@example.test"]);
  fs.writeFileSync(path.join(repository, "README.md"), "managed worktree fixture\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, ["commit", "-m", "fixture"]);
  return repository;
}

function addNamedWorktree(input: {
  readonly repository: string;
  readonly worktreesDir: string;
  readonly name: string;
}): string {
  const worktreePath = path.join(input.worktreesDir, path.basename(input.repository), input.name);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(input.repository, ["worktree", "add", "-b", input.name, worktreePath, "HEAD"]);
  return worktreePath;
}

function addDetachedWorktree(input: {
  readonly repository: string;
  readonly worktreesDir: string;
  readonly id: string;
}): string {
  const worktreePath = path.join(input.worktreesDir, input.id, "synara");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  runGit(input.repository, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
  return worktreePath;
}

function cleanStatus(hasWorkingTreeChanges: boolean): GitStatusDetails {
  return {
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: false,
    branch: null,
    upstreamRef: null,
    upstreamBranch: null,
    hasWorkingTreeChanges,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
  };
}

function makeRealGit(removeInputs: Array<{ cwd: string; path: string; force?: boolean }>) {
  return {
    statusDetails: (cwd: string) =>
      Effect.sync(() => cleanStatus(runGit(cwd, ["status", "--porcelain"]).trim().length > 0)),
    removeWorktree: (input: { cwd: string; path: string; force?: boolean }) =>
      Effect.sync(() => {
        removeInputs.push(input);
        runGit(input.cwd, ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path]);
      }),
  } as Pick<GitCoreShape, "removeWorktree" | "statusDetails">;
}

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("parseManagedWorktreeWorkspaceRoot", () => {
  it("parses a POSIX worktree pointer", () => {
    expect(
      parseManagedWorktreeWorkspaceRoot({
        gitPointerFileContents: "gitdir: /srv/source/.git/worktrees/feature-a\n",
        path: path.posix as unknown as Path.Path,
        worktreePath: "/srv/synara/worktrees/source/feature-a",
      }),
    ).toBe("/srv/source");
  });

  it("parses and case-normalizes the structure of a Windows worktree pointer", () => {
    expect(
      parseManagedWorktreeWorkspaceRoot({
        gitPointerFileContents: "gitdir: C:/Users/Ada/Source/.GIT/WORKTREES/feature-a\r\n",
        path: path.win32 as unknown as Path.Path,
        worktreePath: "C:\\Users\\Ada\\Synara\\worktrees\\source\\feature-a",
      }),
    ).toBe("C:\\Users\\Ada\\Source");
  });
});

describe("managed worktree scanning", () => {
  it("discovers the named and generated detached creation layouts", async () => {
    const root = makeTempRoot();
    const repository = initializeRepository(root);
    const worktreesDir = path.join(root, "managed-worktrees");
    const named = addNamedWorktree({ repository, worktreesDir, name: "feature-named" });
    const detached = addDetachedWorktree({ repository, worktreesDir, id: "a1b2" });

    const result = await Effect.runPromise(scanManagedWorktrees(worktreesDir));

    expect(result.issues).toEqual([]);
    expect(result.worktrees).toEqual([
      expect.objectContaining({ path: detached, workspaceRoot: repository }),
      expect.objectContaining({ path: named, workspaceRoot: repository }),
    ]);
  });

  it("does not follow a managed candidate symlink or junction outside the root", async () => {
    const root = makeTempRoot();
    const worktreesDir = path.join(root, "managed-worktrees");
    const parent = path.join(worktreesDir, "source-repository");
    const outside = path.join(root, "outside");
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "preserve");
    fs.symlinkSync(
      outside,
      path.join(parent, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await Effect.runPromise(scanManagedWorktrees(worktreesDir));

    expect(result.worktrees).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ path: path.join(parent, "escaped"), reason: "symlink" }),
    ]);
    expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("preserve");
  });

  it("preserves malformed and escaped pointer relationships", async () => {
    const root = makeTempRoot();
    const repository = initializeRepository(root);
    const worktreesDir = path.join(root, "managed-worktrees");
    const malformed = path.join(worktreesDir, "source-repository", "malformed");
    const escaped = path.join(worktreesDir, "source-repository", "escaped");
    fs.mkdirSync(path.join(malformed, ".git"), { recursive: true });
    fs.mkdirSync(escaped, { recursive: true });

    const adminDir = path.join(repository, ".git", "worktrees", "escaped-admin");
    const outsidePointer = path.join(root, "outside", ".git");
    fs.mkdirSync(adminDir, { recursive: true });
    fs.mkdirSync(path.dirname(outsidePointer), { recursive: true });
    fs.writeFileSync(outsidePointer, "outside pointer\n");
    fs.writeFileSync(path.join(escaped, ".git"), `gitdir: ${adminDir}\n`);
    fs.writeFileSync(path.join(adminDir, "gitdir"), `${outsidePointer}\n`);
    fs.writeFileSync(path.join(adminDir, "commondir"), "../..\n");

    const result = await Effect.runPromise(scanManagedWorktrees(worktreesDir));

    expect(result.worktrees).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: escaped, reason: "escaped" }),
        expect.objectContaining({ path: malformed, reason: "invalid-git-pointer" }),
      ]),
    );
    expect(fs.existsSync(escaped)).toBe(true);
    expect(fs.existsSync(malformed)).toBe(true);
  });

  it("caps all inspected children, including malformed candidates", async () => {
    const root = makeTempRoot();
    const worktreesDir = path.join(root, "managed-worktrees");
    const parent = path.join(worktreesDir, "source-repository");
    for (const name of ["a", "b", "c"]) {
      fs.mkdirSync(path.join(parent, name), { recursive: true });
    }

    const result = await Effect.runPromise(
      scanManagedWorktrees(worktreesDir, {
        maxParentEntries: 10,
        maxChildEntriesPerParent: 10,
        maxCandidates: 2,
      }),
    );

    expect(result.worktrees).toEqual([]);
    expect(result.issues.filter((issue) => issue.reason === "traversal-limit")).toEqual([
      expect.objectContaining({ detail: expect.stringContaining("2-candidate") }),
    ]);
    expect(result.issues.filter((issue) => issue.reason === "invalid-git-pointer")).toHaveLength(2);
  });
});

describe("managed worktree reconciliation", () => {
  it("preserves worktrees linked through either surviving thread path", async () => {
    const root = makeTempRoot();
    const repository = initializeRepository(root);
    const worktreesDir = path.join(root, "managed-worktrees");
    const active = addNamedWorktree({ repository, worktreesDir, name: "active-worktree" });
    const associated = addNamedWorktree({
      repository,
      worktreesDir,
      name: "associated-worktree",
    });
    const statusDetails = vi.fn(() => Effect.die("linked worktree status must not run"));
    const removeWorktree = vi.fn(() => Effect.die("linked worktree removal must not run"));

    const result = await Effect.runPromise(
      reconcileManagedWorktrees({
        worktreesDir,
        threads: [
          { deletedAt: null, worktreePath: `${active}${path.sep}.` },
          {
            deletedAt: null,
            associatedWorktreePath: path.join(associated, "..", path.basename(associated)),
          },
        ],
        git: { statusDetails, removeWorktree } as unknown as Pick<
          GitCoreShape,
          "removeWorktree" | "statusDetails"
        >,
        pruneOrphans: true,
      }),
    );

    expect(result.linked).toHaveLength(2);
    expect(result.worktrees).toHaveLength(2);
    expect(result.removed).toEqual([]);
    expect(statusDetails).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("removes an unmatched clean worktree without force and is idempotent", async () => {
    const root = makeTempRoot();
    const repository = initializeRepository(root);
    const worktreesDir = path.join(root, "managed-worktrees");
    const orphan = addNamedWorktree({ repository, worktreesDir, name: "clean-orphan" });
    const removeInputs: Array<{ cwd: string; path: string; force?: boolean }> = [];
    const git = makeRealGit(removeInputs);

    const first = await Effect.runPromise(
      reconcileManagedWorktrees({
        worktreesDir,
        threads: [{ deletedAt: new Date(0).toISOString(), worktreePath: orphan }],
        git,
        pruneOrphans: true,
      }),
    );
    const second = await Effect.runPromise(
      reconcileManagedWorktrees({ worktreesDir, threads: [], git, pruneOrphans: true }),
    );

    expect(first.removed).toEqual([{ path: orphan, workspaceRoot: repository }]);
    expect(first.worktrees).toEqual([]);
    expect(removeInputs).toEqual([{ cwd: repository, path: orphan, force: false }]);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(second).toMatchObject({ worktrees: [], removed: [], issues: [] });
  });

  it("preserves a dirty orphan", async () => {
    const root = makeTempRoot();
    const repository = initializeRepository(root);
    const worktreesDir = path.join(root, "managed-worktrees");
    const orphan = addDetachedWorktree({ repository, worktreesDir, id: "d1r7" });
    fs.writeFileSync(path.join(orphan, "untracked.txt"), "do not remove\n");
    const removeInputs: Array<{ cwd: string; path: string; force?: boolean }> = [];

    const result = await Effect.runPromise(
      reconcileManagedWorktrees({
        worktreesDir,
        threads: [],
        git: makeRealGit(removeInputs),
        pruneOrphans: true,
      }),
    );

    expect(result.worktrees).toEqual([{ path: orphan, workspaceRoot: repository }]);
    expect(result.issues).toEqual([expect.objectContaining({ path: orphan, reason: "dirty" })]);
    expect(removeInputs).toEqual([]);
    expect(fs.readFileSync(path.join(orphan, "untracked.txt"), "utf8")).toBe("do not remove\n");
  });

  it("preserves a clean orphan when non-force removal fails", async () => {
    const root = makeTempRoot();
    const repository = initializeRepository(root);
    const worktreesDir = path.join(root, "managed-worktrees");
    const orphan = addNamedWorktree({ repository, worktreesDir, name: "failed-removal" });
    const removeWorktree = vi.fn(() => Effect.fail(new Error("simulated git refusal") as never));

    const result = await Effect.runPromise(
      reconcileManagedWorktrees({
        worktreesDir,
        threads: [],
        git: {
          statusDetails: () => Effect.succeed(cleanStatus(false)),
          removeWorktree,
        } as unknown as Pick<GitCoreShape, "removeWorktree" | "statusDetails">,
        pruneOrphans: true,
      }),
    );

    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: repository,
      path: orphan,
      force: false,
    });
    expect(result.worktrees).toEqual([{ path: orphan, workspaceRoot: repository }]);
    expect(result.issues).toEqual([
      expect.objectContaining({ path: orphan, reason: "remove-failed" }),
    ]);
    expect(fs.existsSync(orphan)).toBe(true);
  });
});
