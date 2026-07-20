import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { GitCoreShape } from "./git/Services/GitCore";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";
import { listManagedWorktreesForRpc } from "./wsRpc";

const tempRoots = new Set<string>();

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("server.listWorktrees", () => {
  it("returns the current validated managed worktree list", async () => {
    const shortRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synara-worktree-rpc-"));
    const root = fs.realpathSync.native(shortRoot);
    tempRoots.add(root);
    const repository = path.join(root, "source");
    const worktreesDir = path.join(root, "managed-worktrees");
    const worktree = path.join(worktreesDir, "source", "rpc-visible");
    fs.mkdirSync(repository, { recursive: true });
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    runGit(repository, ["init"]);
    runGit(repository, ["config", "user.name", "Synara Test"]);
    runGit(repository, ["config", "user.email", "synara@example.test"]);
    fs.writeFileSync(path.join(repository, "README.md"), "rpc fixture\n");
    runGit(repository, ["add", "README.md"]);
    runGit(repository, ["commit", "-m", "fixture"]);
    runGit(repository, ["worktree", "add", "-b", "rpc-visible", worktree, "HEAD"]);

    const result = await Effect.runPromise(
      listManagedWorktreesForRpc({
        worktreesDir,
        projectionSnapshotQuery: {
          getCommandReadModel: () => Effect.succeed({ threads: [] } as never),
        } as Pick<ProjectionSnapshotQueryShape, "getCommandReadModel">,
        git: {} as Pick<GitCoreShape, "removeWorktree" | "statusDetails">,
      }),
    );

    expect(result).toEqual({ worktrees: [{ path: worktree, workspaceRoot: repository }] });
    expect(fs.existsSync(worktree)).toBe(true);
  });
});
