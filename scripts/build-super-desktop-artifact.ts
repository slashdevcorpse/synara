#!/usr/bin/env node
// FILE: build-super-desktop-artifact.ts
// Purpose: Prepares Super production dependencies before starting the Effect artifact builder.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSuperDesktopStageInstallEnvironment } from "./lib/desktop-artifact-policy.ts";
import { canonicalizeDesktopStagePath } from "./lib/desktop-stage-install.ts";

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = spawnSync(command, [...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? "unknown"}.`);
  }
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ownedPreparedRoot = mkdtempSync(join(tmpdir(), "super-synara-prepared-dependencies-"));
chmodSync(ownedPreparedRoot, 0o700);
const preparedRoot = canonicalizeDesktopStagePath(ownedPreparedRoot);
const preparedAppDir = join(preparedRoot, "app");
const verbose = process.argv.slice(2).includes("--verbose");

try {
  const helperArgs = [
    join(repoRoot, "scripts/install-super-desktop-stage-dependencies.ts"),
    "--repo-root",
    repoRoot,
    "--stage-app-dir",
    preparedAppDir,
    "--keep-install-metadata",
  ];
  if (verbose) helperArgs.push("--verbose");
  run(
    process.execPath,
    helperArgs,
    repoRoot,
    resolveSuperDesktopStageInstallEnvironment(process.env),
  );

  run(
    process.execPath,
    [
      join(repoRoot, "scripts/build-desktop-artifact.ts"),
      ...process.argv.slice(2),
      "--prepared-dependencies-path",
      preparedAppDir,
    ],
    repoRoot,
  );
} catch (cause) {
  console.error(
    `[super-desktop-artifact] ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(ownedPreparedRoot, { recursive: true, force: true });
}
