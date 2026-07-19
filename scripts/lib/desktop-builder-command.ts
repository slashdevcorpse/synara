// FILE: desktop-builder-command.ts
// Purpose: Resolves a shell-free electron-builder command for every desktop flavor.

import { existsSync } from "node:fs";
import { join } from "node:path";

interface PathJoiner {
  readonly join: (...paths: string[]) => string;
}

export interface DesktopBuilderCommandPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: false;
}

export function resolveDesktopBuilderCliPath(
  repoRoot: string,
  pathJoiner: PathJoiner = { join },
  fileExists: (path: string) => boolean = existsSync,
): string {
  const cliPath = pathJoiner.join(
    repoRoot,
    "scripts",
    "node_modules",
    "electron-builder",
    "out",
    "cli",
    "cli.js",
  );
  if (!fileExists(cliPath)) {
    throw new Error(`electron-builder JavaScript CLI is missing: ${cliPath}`);
  }
  return cliPath;
}

export function createDesktopBuilderCommandPlan(input: {
  readonly repoRoot: string;
  readonly nodeExecutable: string;
  readonly platformCliFlag: string;
  readonly arch: string;
  readonly pathJoiner?: PathJoiner;
  readonly fileExists?: (path: string) => boolean;
}): DesktopBuilderCommandPlan {
  const cliPath = resolveDesktopBuilderCliPath(input.repoRoot, input.pathJoiner, input.fileExists);
  return {
    command: input.nodeExecutable,
    args: [cliPath, input.platformCliFlag, `--${input.arch}`, "--publish", "never"],
    shell: false,
  };
}
