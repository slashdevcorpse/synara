// FILE: scratchWorkspaces.test.ts
// Purpose: Verifies per-thread scratch workspace paths stay inside the shared
//          temp root even when thread ids contain path-like characters.
// Layer: Server filesystem utility tests

import { mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { SCRATCH_WORKSPACES_DIRNAME } from "@synara/shared/threadWorkspace";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  makeScratchWorkspaceCleanupLive,
  ScratchWorkspaceCleanup,
} from "./scratchWorkspaceCleanup";
import {
  ensureIsolatedScratchWorkspace,
  removeIsolatedScratchWorkspace,
  scratchWorkspaceSegment,
  sweepStaleScratchWorkspaces,
} from "./scratchWorkspaces";

function scratchRoot(): string {
  return path.join(tmpdir(), SCRATCH_WORKSPACES_DIRNAME);
}

describe("ensureIsolatedScratchWorkspace", () => {
  it("creates a readable per-thread directory under the scratch root", () => {
    const workspace = ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("thread-1"));
    try {
      expect(workspace).toContain(`${path.sep}${SCRATCH_WORKSPACES_DIRNAME}${path.sep}thread-1-`);
      expect(path.relative(scratchRoot(), workspace).startsWith("..")).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not let path-like thread ids escape the scratch root", () => {
    const workspace = ensureIsolatedScratchWorkspace(ThreadId.makeUnsafe("../outside/thread"));
    try {
      const relative = path.relative(scratchRoot(), workspace);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(workspace).not.toContain(`${path.sep}..${path.sep}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("scratch workspace cleanup", () => {
  it("runs a stale-orphan sweep while the cleanup layer starts", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "synara-scratch-startup-"));
    const staleDir = path.join(
      rootDir,
      scratchWorkspaceSegment(ThreadId.makeUnsafe("startup-stale-thread")),
    );
    mkdirSync(staleDir);
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(staleDir, staleDate, staleDate);
    const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: new Date(0).toISOString(),
        }),
    } as unknown as ProjectionSnapshotQueryShape);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* ScratchWorkspaceCleanup;
          }),
        ).pipe(
          Effect.provide(
            makeScratchWorkspaceCleanupLive({ rootDir }).pipe(Layer.provide(projectionLayer)),
          ),
        ),
      );

      expect(() => writeFileSync(path.join(staleDir, "gone.txt"), "gone")).toThrow();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("removes only stale orphaned managed directories", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "synara-scratch-sweep-"));
    const activeId = ThreadId.makeUnsafe("active-thread");
    const staleId = ThreadId.makeUnsafe("stale-thread");
    const freshId = ThreadId.makeUnsafe("fresh-thread");
    const activeDir = path.join(rootDir, scratchWorkspaceSegment(activeId));
    const staleDir = path.join(rootDir, scratchWorkspaceSegment(staleId));
    const freshDir = path.join(rootDir, scratchWorkspaceSegment(freshId));
    const malformedDir = path.join(rootDir, "unowned-directory");
    for (const directory of [activeDir, staleDir, freshDir, malformedDir]) {
      mkdirSync(directory);
      writeFileSync(path.join(directory, "proof.txt"), "preserve or delete");
    }
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 48 * 60 * 60 * 1_000);
    utimesSync(activeDir, staleDate, staleDate);
    utimesSync(staleDir, staleDate, staleDate);
    try {
      const result = await sweepStaleScratchWorkspaces({
        activeThreadIds: new Set([String(activeId)]),
        rootDir,
        nowMs,
      });

      expect(result).toMatchObject({ removed: 1, preservedActive: 1, preservedUnsafe: 1 });
      expect(() => writeFileSync(path.join(staleDir, "gone.txt"), "gone")).toThrow();
      expect(() => writeFileSync(path.join(activeDir, "alive.txt"), "alive")).not.toThrow();
      expect(() => writeFileSync(path.join(freshDir, "alive.txt"), "alive")).not.toThrow();
      expect(() => writeFileSync(path.join(malformedDir, "alive.txt"), "alive")).not.toThrow();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("preserves symbolic links even when they look managed and stale", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "synara-scratch-symlink-"));
    const outsideDir = await mkdtemp(path.join(tmpdir(), "synara-scratch-outside-"));
    const linkPath = path.join(
      rootDir,
      scratchWorkspaceSegment(ThreadId.makeUnsafe("linked-thread")),
    );
    writeFileSync(path.join(outsideDir, "proof.txt"), "outside");
    try {
      symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      const result = await sweepStaleScratchWorkspaces({
        activeThreadIds: new Set(),
        rootDir,
        nowMs: Date.now() + 48 * 60 * 60 * 1_000,
      });

      expect(result).toMatchObject({ removed: 0, preservedUnsafe: 1 });
      expect(writeFileSync(path.join(outsideDir, "still-here.txt"), "safe")).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("preserves a candidate replaced immediately before recursive deletion", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "synara-scratch-replaced-candidate-"));
    const candidate = path.join(
      rootDir,
      scratchWorkspaceSegment(ThreadId.makeUnsafe("replaced-candidate-thread")),
    );
    const originalCandidate = `${candidate}-original`;
    mkdirSync(candidate);
    writeFileSync(path.join(candidate, "proof.txt"), "original");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 48 * 60 * 60 * 1_000);
    utimesSync(candidate, staleDate, staleDate);

    try {
      const result = await sweepStaleScratchWorkspaces({
        activeThreadIds: new Set(),
        rootDir,
        nowMs,
        beforeFinalDelete: async () => {
          renameSync(candidate, originalCandidate);
          mkdirSync(candidate);
          writeFileSync(path.join(candidate, "proof.txt"), "replacement");
          utimesSync(candidate, staleDate, staleDate);
        },
      });

      expect(result).toMatchObject({ removed: 0, preservedUnsafe: 1 });
      expect(() => writeFileSync(path.join(candidate, "still-here.txt"), "safe")).not.toThrow();
      expect(() =>
        writeFileSync(path.join(originalCandidate, "still-here.txt"), "safe"),
      ).not.toThrow();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("removes the exact thread directory on explicit deletion", async () => {
    const threadId = ThreadId.makeUnsafe(`delete-thread-${Date.now()}`);
    const workspace = ensureIsolatedScratchWorkspace(threadId);
    try {
      writeFileSync(path.join(workspace, "proof.txt"), "delete me");

      await removeIsolatedScratchWorkspace(threadId);
      await expect(removeIsolatedScratchWorkspace(threadId)).resolves.toBeUndefined();
      expect(() => writeFileSync(path.join(workspace, "gone.txt"), "gone")).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a replaced scratch root without deleting through its junction", async () => {
    const parentDir = await mkdtemp(path.join(tmpdir(), "synara-scratch-root-replaced-"));
    const outsideDir = await mkdtemp(path.join(tmpdir(), "synara-scratch-root-outside-"));
    const rootDir = path.join(parentDir, "managed");
    const originalRootDir = path.join(parentDir, "managed-original");
    const threadId = ThreadId.makeUnsafe("root-replacement-thread");
    const segment = scratchWorkspaceSegment(threadId);
    mkdirSync(path.join(rootDir, segment), { recursive: true });
    mkdirSync(path.join(outsideDir, segment), { recursive: true });
    const outsideProof = path.join(outsideDir, segment, "must-survive.txt");
    writeFileSync(outsideProof, "outside");

    try {
      renameSync(rootDir, originalRootDir);
      symlinkSync(outsideDir, rootDir, process.platform === "win32" ? "junction" : "dir");

      await expect(removeIsolatedScratchWorkspace(threadId, { rootDir })).rejects.toThrow(
        "Scratch workspace root is not a managed directory.",
      );
      expect(() => writeFileSync(outsideProof, "still outside")).not.toThrow();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(originalRootDir, { recursive: true, force: true });
      rmSync(parentDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
