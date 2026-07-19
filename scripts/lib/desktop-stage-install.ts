// FILE: desktop-stage-install.ts
// Purpose: Provides fail-closed filesystem operations for desktop dependency staging.

import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { desktopStageFileBytesMatch } from "./desktop-artifact-policy.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./release-workspace-manifests.ts";

interface PatchFileExpectation {
  readonly file: string;
  readonly addedLines: ReadonlyArray<string>;
}

export function canonicalizeDesktopStagePath(
  stagePath: string,
  canonicalize: (path: string) => string = realpathSync.native,
): string {
  return canonicalize(stagePath);
}

function parsePatchAddedLines(patchContents: string): PatchFileExpectation[] {
  const expectations: Array<{ file: string; addedLines: string[] }> = [];
  let current: { file: string; addedLines: string[] } | null = null;
  for (const line of patchContents.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      current = { file: target.startsWith("b/") ? target.slice(2) : target, addedLines: [] };
      expectations.push(current);
      continue;
    }
    if (current && line.startsWith("+")) {
      const added = line.slice(1).trim();
      if (added.length > 0) current.addedLines.push(added);
    }
  }
  return expectations.filter((expectation) => expectation.addedLines.length > 0);
}

export function copyDesktopStageInstallMetadata(repoRoot: string, stageAppDir: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const destination = join(stageAppDir, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, relativePath), destination);
  }
  copyFileSync(join(repoRoot, RELEASE_LOCKFILE_PATH), join(stageAppDir, RELEASE_LOCKFILE_PATH));
  cpSync(join(repoRoot, RELEASE_PATCHES_PATH), join(stageAppDir, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

export function assertDesktopStageFilesUnchanged(
  repoRoot: string,
  stageAppDir: string,
  relativePaths: ReadonlyArray<string>,
): void {
  for (const relativePath of relativePaths) {
    const repositoryFile = readFileSync(join(repoRoot, relativePath));
    const stagedFile = readFileSync(join(stageAppDir, relativePath));
    if (!desktopStageFileBytesMatch(repositoryFile, stagedFile)) {
      throw new Error(
        `Staged dependency install changed ${relativePath}; refusing to package rewritten release metadata.`,
      );
    }
  }
}

export function verifyDesktopStagePatchedDependencies(
  repoRoot: string,
  stageAppDir: string,
  patchedDependencies: Readonly<Record<string, string>>,
): void {
  for (const [dependency, patchRelativePath] of Object.entries(patchedDependencies)) {
    const packageName = dependency.slice(0, dependency.indexOf("@", 1));
    const patchContents = readFileSync(join(repoRoot, patchRelativePath), "utf8");
    for (const expectation of parsePatchAddedLines(patchContents)) {
      const stagedFilePath = join(stageAppDir, "node_modules", packageName, expectation.file);
      let stagedContents: string;
      try {
        stagedContents = readFileSync(stagedFilePath, "utf8");
      } catch (cause) {
        throw new Error(
          `Patched dependency file is missing from the stage: ${stagedFilePath} (expected by ${patchRelativePath}).`,
          { cause },
        );
      }
      for (const addedLine of expectation.addedLines) {
        if (!stagedContents.includes(addedLine)) {
          throw new Error(
            `Staged dependency ${packageName} is missing patched content: ${expectation.file} does not contain "${addedLine}" from ${patchRelativePath}. The tracked patch was not applied by the staged install.`,
          );
        }
      }
    }
  }
}

export function cleanupDesktopStageInstallMetadata(stageAppDir: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    if (relativePath !== "package.json") {
      rmSync(join(stageAppDir, relativePath), { force: true });
    }
  }
  rmSync(join(stageAppDir, RELEASE_LOCKFILE_PATH), { force: true });
  rmSync(join(stageAppDir, RELEASE_PATCHES_PATH), { recursive: true, force: true });
}
