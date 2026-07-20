import { spawn } from "node:child_process";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  EFFECT_LANGUAGE_SERVICE_PATCH_TARGETS,
  EFFECT_LANGUAGE_SERVICE_PREPARE_SCRIPT,
  makeEffectLanguageServicePatchTargetsPrivate,
  resolveEffectLanguageServicePatchDirectory,
  verifyEffectLanguageServiceInstallPolicy,
  verifyRepositoryEffectLanguageServiceInstallPolicy,
  type WorkspacePackageManifest,
} from "./effect-language-service-install.ts";
import { RELEASE_WORKSPACE_MANIFEST_PATHS } from "./release-workspace-manifests.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface ChildProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

function createPrepareFixture(fixtureRoot: string, name: string): string {
  const projectRoot = join(fixtureRoot, name);
  for (const manifestPath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const destinationPath = resolve(projectRoot, manifestPath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(resolve(repoRoot, manifestPath), destinationPath);
  }

  const typescriptRoot = resolve(projectRoot, "node_modules/typescript");
  mkdirSync(resolve(typescriptRoot, "lib"), { recursive: true });

  const effectLanguageServiceRoot = resolve(projectRoot, "node_modules/@effect/language-service");
  mkdirSync(effectLanguageServiceRoot, { recursive: true });
  writeFileSync(
    resolve(effectLanguageServiceRoot, "cli.js"),
    `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const command = process.argv[2];
const marker = "/* @effect-lsp-patch fixture */";
const targets = ${JSON.stringify(EFFECT_LANGUAGE_SERVICE_PATCH_TARGETS)};
const barrierDirectory = ${JSON.stringify(resolve(fixtureRoot, "patch-barrier"))};
const participants = ${JSON.stringify(["project-a", "project-b"])};
console.log("fixture effect-language-service " + command);
if (command === "patch") {
  mkdirSync(barrierDirectory, { recursive: true });
  writeFileSync(resolve(barrierDirectory, ${JSON.stringify(`${name}.ready`)}), "ready\\n");
  const deadline = Date.now() + 10_000;
  while (
    !participants.every((participant) =>
      existsSync(resolve(barrierDirectory, participant + ".ready")),
    )
  ) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for concurrent prepare fixture participants");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
for (const filename of targets) {
  const target = resolve(process.cwd(), "node_modules/typescript/lib", filename);
  const source = readFileSync(target, "utf8");
  if (command === "patch") {
    if (!source.includes(marker)) {
      writeFileSync(target, source + "\\n" + marker + "\\n");
    }
  } else if (command === "check") {
    if (!source.includes(marker)) {
      throw new Error(target + " was not patched");
    }
  } else {
    throw new Error("Unexpected command: " + command);
  }
}
`,
  );
  return projectRoot;
}

function runPrepareChild(
  driverPath: string,
  installModulePath: string,
  projectRoot: string,
): Promise<ChildProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [driverPath, installModulePath, projectRoot], {
      cwd: projectRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal, stderr, stdout });
    });
  });
}

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

  it("runs concurrent real prepare flows without mutating their shared TypeScript cache", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "effect-language-service-concurrency-test-"));
    const sharedCacheLib = resolve(fixtureRoot, "shared-cache/typescript/lib");
    const projects = [
      createPrepareFixture(fixtureRoot, "project-a"),
      createPrepareFixture(fixtureRoot, "project-b"),
    ];
    mkdirSync(sharedCacheLib, { recursive: true });
    try {
      const pristineCache = new Map<
        string,
        { readonly bytes: Buffer; readonly device: bigint; readonly inode: bigint }
      >();
      for (const filename of EFFECT_LANGUAGE_SERVICE_PATCH_TARGETS) {
        const cachePath = resolve(sharedCacheLib, filename);
        writeFileSync(cachePath, `${filename}: pristine\n`);
        const cacheStat = statSync(cachePath, { bigint: true });
        pristineCache.set(filename, {
          bytes: readFileSync(cachePath),
          device: cacheStat.dev,
          inode: cacheStat.ino,
        });
        for (const projectRoot of projects) {
          linkSync(cachePath, resolve(projectRoot, "node_modules/typescript/lib", filename));
        }
        expect(statSync(cachePath).nlink).toBe(3);
      }

      const driverPath = resolve(fixtureRoot, "run-prepare.mjs");
      writeFileSync(
        driverPath,
        `import { pathToFileURL } from "node:url";\n\nconst [, , installModulePath, projectRoot] = process.argv;\nconst { prepareEffectLanguageServiceInstall } = await import(pathToFileURL(installModulePath).href);\nprepareEffectLanguageServiceInstall(projectRoot);\n`,
      );
      const installModulePath = resolve(repoRoot, "scripts/lib/effect-language-service-install.ts");
      const results = await Promise.all(
        projects.map((projectRoot) => runPrepareChild(driverPath, installModulePath, projectRoot)),
      );

      for (const result of results) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
        expect(result.stdout).toContain(
          "Isolated 2 TypeScript patch targets from Bun's package cache.",
        );
        expect(result.stdout).toContain("fixture effect-language-service patch");
        expect(result.stdout).toContain("fixture effect-language-service check");
      }
      expect(readdirSync(resolve(fixtureRoot, "patch-barrier")).sort()).toEqual([
        "project-a.ready",
        "project-b.ready",
      ]);
      for (const filename of EFFECT_LANGUAGE_SERVICE_PATCH_TARGETS) {
        const cachePath = resolve(sharedCacheLib, filename);
        const cacheStat = statSync(cachePath, { bigint: true });
        const pristine = pristineCache.get(filename);
        if (!pristine) {
          throw new Error(`Missing pristine cache evidence for ${filename}.`);
        }
        expect(readFileSync(cachePath)).toEqual(pristine.bytes);
        expect({ device: cacheStat.dev, inode: cacheStat.ino }).toEqual({
          device: pristine.device,
          inode: pristine.inode,
        });
        expect(cacheStat.nlink).toBe(1n);
        for (const projectRoot of projects) {
          const typescriptLib = resolve(projectRoot, "node_modules/typescript/lib");
          const projectTarget = resolve(typescriptLib, filename);
          expect(statSync(projectTarget).nlink).toBe(1);
          expect(readFileSync(projectTarget, "utf8")).toContain("@effect-lsp-patch");
          expect(
            readdirSync(typescriptLib).filter(
              (entry) => entry.includes(".synara-") && entry.endsWith(".tmp"),
            ),
          ).toEqual([]);
        }
      }
      expect(
        readdirSync(sharedCacheLib).filter(
          (entry) => entry.includes(".synara-") && entry.endsWith(".tmp"),
        ),
      ).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

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
