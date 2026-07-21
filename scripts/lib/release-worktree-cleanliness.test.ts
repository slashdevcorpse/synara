import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateReleaseWorktreeCleanliness,
  verifyReleaseWorktreeCleanliness,
} from "./release-worktree-cleanliness.ts";

describe("release worktree cleanliness", () => {
  it("admits only untracked files beneath declared output roots", () => {
    expect(() =>
      validateReleaseWorktreeCleanliness({
        trackedPaths: [],
        untrackedPaths: ["release-build/app.exe", "release-publish/provenance.json"],
        allowedOutputRoots: ["release-build", "release-publish"],
      }),
    ).not.toThrow();
    expect(() =>
      validateReleaseWorktreeCleanliness({
        trackedPaths: [],
        untrackedPaths: ["release-build-input.txt"],
        allowedOutputRoots: ["release-build"],
      }),
    ).toThrow("Unexpected untracked release input");
  });

  it("rejects tracked mutations and unsafe output roots", () => {
    expect(() =>
      validateReleaseWorktreeCleanliness({
        trackedPaths: ["apps/web/src/routeTree.gen.ts"],
        untrackedPaths: [],
        allowedOutputRoots: [],
      }),
    ).toThrow(
      "Tracked release source bytes differ from the recorded HEAD commit: apps/web/src/routeTree.gen.ts",
    );
    expect(() =>
      validateReleaseWorktreeCleanliness({
        trackedPaths: [],
        untrackedPaths: [],
        allowedOutputRoots: ["../outside"],
      }),
    ).toThrow("normalized repository-relative path");
  });

  it("checks actual Git content while allowing a declared generated directory", () => {
    const root = mkdtempSync(join(tmpdir(), "release-cleanliness-test-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "release-test@example.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
      writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
      writeFileSync(join(root, "source.txt"), "source\n");
      execFileSync("git", ["add", ".gitattributes", "source.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

      writeFileSync(join(root, "source.txt"), "source\r\n");
      expect(() => verifyReleaseWorktreeCleanliness(root)).not.toThrow();

      mkdirSync(join(root, "release-build"));
      writeFileSync(join(root, "release-build", "artifact.bin"), "artifact");
      expect(() => verifyReleaseWorktreeCleanliness(root, ["release-build"])).not.toThrow();
      expect(() => verifyReleaseWorktreeCleanliness(root)).toThrow("Unexpected untracked");

      writeFileSync(join(root, "source.txt"), "mutated\n");
      expect(() => verifyReleaseWorktreeCleanliness(root, ["release-build"])).toThrow(
        "Tracked release source bytes differ",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
