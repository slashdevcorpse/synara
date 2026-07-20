import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EFFECT_LANGUAGE_SERVICE_PREPARE_SCRIPT,
  makeEffectLanguageServicePatchTargetsPrivate,
  resolveEffectLanguageServicePatchDirectory,
  verifyEffectLanguageServiceInstallPolicy,
  verifyRepositoryEffectLanguageServiceInstallPolicy,
  type WorkspacePackageManifest,
} from "./effect-language-service-install.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function validManifests(): Array<WorkspacePackageManifest> {
  return [
    {
      path: "package.json",
      manifest: {
        scripts: { prepare: EFFECT_LANGUAGE_SERVICE_PREPARE_SCRIPT },
        devDependencies: {
          "@effect/language-service": "catalog:",
          typescript: "catalog:",
        },
      },
    },
    { path: "apps/web/package.json", manifest: { scripts: { build: "vite build" } } },
  ];
}

describe("Effect language service install policy", () => {
  it("keeps the checked-in workspace topology on one explicit root patch owner", () => {
    expect(() => verifyRepositoryEffectLanguageServiceInstallPolicy(repoRoot)).not.toThrow();
  });

  it("rejects a duplicate workspace patch hook or an implicit root dependency", () => {
    const duplicate = validManifests();
    duplicate[1] = {
      path: "apps/web/package.json",
      manifest: { scripts: { prepare: "effect-language-service patch" } },
    };
    expect(() => verifyEffectLanguageServiceInstallPolicy(duplicate)).toThrow(
      "must have one root owner",
    );
    duplicate[1] = {
      path: "apps/web/package.json",
      manifest: {
        scripts: { prepare: "node node_modules/@effect/language-service/cli.js patch" },
      },
    };
    expect(() => verifyEffectLanguageServiceInstallPolicy(duplicate)).toThrow(
      "must have one root owner",
    );

    const missingDependency = validManifests();
    missingDependency[0] = {
      path: "package.json",
      manifest: {
        scripts: { prepare: EFFECT_LANGUAGE_SERVICE_PREPARE_SCRIPT },
        devDependencies: { typescript: "catalog:" },
      },
    };
    expect(() => verifyEffectLanguageServiceInstallPolicy(missingDependency)).toThrow(
      "root devDependency @effect/language-service",
    );
  });

  it("replaces only shared TypeScript patch targets with private copies", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "effect-language-service-install-test-"));
    const cacheLib = join(fixtureRoot, "cache");
    const projectLib = join(fixtureRoot, "project");
    mkdirSync(cacheLib);
    mkdirSync(projectLib);
    try {
      for (const filename of ["typescript.js", "_tsc.js"]) {
        const cachePath = join(cacheLib, filename);
        writeFileSync(cachePath, `${filename}: pristine`);
        linkSync(cachePath, join(projectLib, filename));
        expect(statSync(cachePath).nlink).toBe(2);
      }

      expect(makeEffectLanguageServicePatchTargetsPrivate(projectLib)).toHaveLength(2);
      for (const filename of ["typescript.js", "_tsc.js"]) {
        writeFileSync(join(projectLib, filename), `${filename}: patched`);
        expect(readFileSync(join(cacheLib, filename), "utf8")).toBe(`${filename}: pristine`);
        expect(statSync(join(cacheLib, filename)).nlink).toBe(1);
        expect(statSync(join(projectLib, filename)).nlink).toBe(1);
      }
      expect(makeEffectLanguageServicePatchTargetsPrivate(projectLib)).toHaveLength(2);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("refuses a TypeScript package that resolves through node_modules into an external cache", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "effect-language-service-location-test-"));
    const nodeModules = join(fixtureRoot, "project", "node_modules");
    const externalTypescript = join(fixtureRoot, "cache", "typescript");
    mkdirSync(join(externalTypescript, "lib"), { recursive: true });
    mkdirSync(nodeModules, { recursive: true });
    try {
      symlinkSync(externalTypescript, join(nodeModules, "typescript"), "junction");
      expect(() =>
        resolveEffectLanguageServicePatchDirectory(join(fixtureRoot, "project")),
      ).toThrow("Refusing to patch TypeScript outside this worktree's node_modules");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
