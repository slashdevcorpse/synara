#!/usr/bin/env node
// FILE: install-super-desktop-stage-dependencies.ts
// Purpose: Installs Super Synara stage dependencies in an isolated fail-closed process.

import { spawnSync } from "node:child_process";

import rootPackageJson from "../package.json" with { type: "json" };

import {
  resolveDesktopStageInstallArgs,
  resolveSuperDesktopStageInstallEnvironment,
} from "./lib/desktop-artifact-policy.ts";
import {
  assertDesktopStageFilesUnchanged,
  cleanupDesktopStageInstallMetadata,
  copyDesktopStageInstallMetadata,
  verifyDesktopStagePatchedDependencies,
} from "./lib/desktop-stage-install.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";

interface HelperOptions {
  readonly repoRoot: string;
  readonly stageAppDir: string;
  readonly verbose: boolean;
  readonly keepInstallMetadata: boolean;
}

function parseOptions(argv: ReadonlyArray<string>): HelperOptions {
  let repoRoot: string | undefined;
  let stageAppDir: string | undefined;
  let verbose = false;
  let keepInstallMetadata = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    if (argument === "--keep-install-metadata") {
      keepInstallMetadata = true;
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--repo-root" && value) {
      repoRoot = value;
      index += 1;
      continue;
    }
    if (argument === "--stage-app-dir" && value) {
      stageAppDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument ?? "<missing>"}`);
  }
  if (!repoRoot || !stageAppDir) {
    throw new Error("Both --repo-root and --stage-app-dir are required.");
  }
  return { repoRoot, stageAppDir, verbose, keepInstallMetadata };
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  copyDesktopStageInstallMetadata(options.repoRoot, options.stageAppDir);

  const installArgs = resolveDesktopStageInstallArgs("super");
  console.log(
    `[desktop-stage] Installing Super Synara production dependencies with frozen=false filtered=true.`,
  );
  const result = spawnSync("bun", [...installArgs], {
    cwd: options.stageAppDir,
    env: resolveSuperDesktopStageInstallEnvironment(process.env),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    stdio: options.verbose ? "inherit" : "pipe",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        `bun ${installArgs.join(" ")} exited with ${result.status ?? "unknown"}.`,
    );
  }

  assertDesktopStageFilesUnchanged(options.repoRoot, options.stageAppDir, [
    RELEASE_LOCKFILE_PATH,
    ...RELEASE_WORKSPACE_MANIFEST_PATHS,
  ]);
  verifyDesktopStagePatchedDependencies(
    options.repoRoot,
    options.stageAppDir,
    rootPackageJson.patchedDependencies ?? {},
  );
  if (!options.keepInstallMetadata) {
    cleanupDesktopStageInstallMetadata(options.stageAppDir);
  }
}

try {
  main();
} catch (cause) {
  console.error(`[desktop-stage] ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
