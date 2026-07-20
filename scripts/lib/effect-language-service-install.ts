// FILE: effect-language-service-install.ts
// Purpose: Keeps the Effect TypeScript patch single-owner and isolated from Bun's package cache.
// Layer: Repository install policy

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { RELEASE_WORKSPACE_MANIFEST_PATHS } from "./release-workspace-manifests.ts";

export const EFFECT_LANGUAGE_SERVICE_PREPARE_SCRIPT =
  "node scripts/prepare-effect-language-service.ts";

export const EFFECT_LANGUAGE_SERVICE_PATCH_TARGETS = ["typescript.js", "_tsc.js"] as const;

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface WorkspacePackageManifest {
  readonly path: string;
  readonly manifest: PackageManifest;
}

export function verifyEffectLanguageServiceInstallPolicy(
  workspaceManifests: ReadonlyArray<WorkspacePackageManifest>,
): void {
  const root = workspaceManifests.find(({ path }) => path === "package.json");
  if (!root) {
    throw new Error("Expected the repository root package.json install policy.");
  }
  if (root.manifest.scripts?.prepare !== EFFECT_LANGUAGE_SERVICE_PREPARE_SCRIPT) {
    throw new Error(
      `Expected root prepare to be ${JSON.stringify(EFFECT_LANGUAGE_SERVICE_PREPARE_SCRIPT)}.`,
    );
  }
  for (const dependency of ["@effect/language-service", "typescript"]) {
    if (root.manifest.devDependencies?.[dependency] !== "catalog:") {
      throw new Error(`Expected root devDependency ${dependency} to resolve from the catalog.`);
    }
  }

  const duplicateOwners = workspaceManifests
    .filter(({ path }) => path !== "package.json")
    .filter(({ manifest }) =>
      Object.values(manifest.scripts ?? {}).some((script) => {
        const normalized = script.toLowerCase();
        return (
          normalized.includes("prepare-effect-language-service") ||
          ((normalized.includes("effect-language-service") ||
            normalized.includes("@effect/language-service")) &&
            normalized.includes("patch"))
        );
      }),
    )
    .map(({ path }) => path);
  if (duplicateOwners.length > 0) {
    throw new Error(
      `Effect language service patching must have one root owner; remove workspace hooks from ${duplicateOwners.join(", ")}.`,
    );
  }
}

export function verifyRepositoryEffectLanguageServiceInstallPolicy(repoRoot: string): void {
  verifyEffectLanguageServiceInstallPolicy(
    RELEASE_WORKSPACE_MANIFEST_PATHS.map((path) => ({
      path,
      manifest: JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as PackageManifest,
    })),
  );
}

export function resolveEffectLanguageServicePatchDirectory(repoRoot: string): string {
  const nodeModulesDirectory = realpathSync(resolve(repoRoot, "node_modules"));
  const typescriptLibDirectory = realpathSync(resolve(repoRoot, "node_modules/typescript/lib"));
  const relativePath = relative(nodeModulesDirectory, typescriptLibDirectory);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..\\`) ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing to patch TypeScript outside this worktree's node_modules: ${typescriptLibDirectory}.`,
    );
  }
  return typescriptLibDirectory;
}

export function makeEffectLanguageServicePatchTargetsPrivate(
  typescriptLibDirectory: string,
): ReadonlyArray<string> {
  const replaced: Array<string> = [];
  for (const filename of EFFECT_LANGUAGE_SERVICE_PATCH_TARGETS) {
    const targetPath = resolve(typescriptLibDirectory, filename);
    const sourceStat = statSync(targetPath);

    const temporaryPath = resolve(
      dirname(targetPath),
      `.${basename(targetPath)}.synara-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      copyFileSync(targetPath, temporaryPath);
      chmodSync(temporaryPath, sourceStat.mode);
      renameSync(temporaryPath, targetPath);
      replaced.push(targetPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  return replaced;
}

export function prepareEffectLanguageServiceInstall(repoRoot: string): void {
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
}
