// FILE: prepare-effect-language-service.ts
// Purpose: Applies the Effect TypeScript patch once without mutating Bun's package cache.
// Layer: Repository install lifecycle

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeEffectLanguageServicePatchTargetsPrivate,
  resolveEffectLanguageServicePatchDirectory,
  verifyRepositoryEffectLanguageServiceInstallPolicy,
} from "./lib/effect-language-service-install.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

verifyRepositoryEffectLanguageServiceInstallPolicy(repoRoot);
const privateTargets = makeEffectLanguageServicePatchTargetsPrivate(
  resolveEffectLanguageServicePatchDirectory(repoRoot),
);
if (privateTargets.length > 0) {
  console.log(
    `Isolated ${privateTargets.length} TypeScript patch targets from Bun's package cache.`,
  );
}

const cliPath = resolve(repoRoot, "node_modules/@effect/language-service/cli.js");
for (const command of ["patch", "check"]) {
  const result = spawnSync(process.execPath, [cliPath, command], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw new Error(
      `Unable to start the Effect language service ${command}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Effect language service ${command} exited with status ${result.status ?? "unknown"}.`,
    );
  }
}
