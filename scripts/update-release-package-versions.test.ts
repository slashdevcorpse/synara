import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";

const releasePackages = [
  ["apps/server/package.json", "@synara/cli"],
  ["apps/desktop/package.json", "@synara/desktop"],
  ["apps/web/package.json", "@synara/web"],
  ["packages/contracts/package.json", "@synara/contracts"],
] as const;

function writeReleaseFixture(root: string, lockfilePackageName = "@synara/cli"): void {
  for (const [manifestPath, packageName] of releasePackages) {
    const filePath = resolve(root, manifestPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({ name: packageName, version: "0.5.5", private: true }, null, 2)}\n`,
    );
  }

  const workspaceImporters = releasePackages
    .map(([manifestPath, packageName]) => {
      const workspacePath = dirname(manifestPath).replaceAll("\\", "/");
      const effectivePackageName =
        manifestPath === "apps/server/package.json" ? lockfilePackageName : packageName;
      return `    ${JSON.stringify(workspacePath)}: {
      "name": ${JSON.stringify(effectivePackageName)},
      "version": "0.5.5",
      "dependencies": {
        "effect": "catalog:",
      },
    },`;
    })
    .join("\n");
  writeFileSync(
    resolve(root, "bun.lock"),
    `{
  "lockfileVersion": 1,
  "workspaces": {
${workspaceImporters}
  },
  "packages": {
    "effect": ["effect@3.0.0", "", {}, "sha512-preserved"],
  },
}
`,
  );
}

describe("updateReleasePackageVersions", () => {
  it("updates package manifests and lockfile importer versions without changing resolutions", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-version-test-"));
    try {
      writeReleaseFixture(root);

      expect(updateReleasePackageVersions("0.5.5-super.4", { rootDir: root })).toEqual({
        changed: true,
      });
      for (const manifestPath of releasePackageFiles) {
        expect(JSON.parse(readFileSync(resolve(root, manifestPath), "utf8"))).toMatchObject({
          version: "0.5.5-super.4",
        });
      }

      const lockfile = readFileSync(resolve(root, "bun.lock"), "utf8");
      expect(lockfile.match(/"version": "0\.5\.5-super\.4"/g)).toHaveLength(4);
      expect(lockfile).toContain('"effect": ["effect@3.0.0", "", {}, "sha512-preserved"]');
      expect(updateReleasePackageVersions("0.5.5-super.4", { rootDir: root })).toEqual({
        changed: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails before writing manifests when the matching lockfile importer is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-version-test-"));
    try {
      writeReleaseFixture(root, "@synara/not-cli");
      const originalManifest = readFileSync(resolve(root, releasePackageFiles[0]), "utf8");

      expect(() => updateReleasePackageVersions("0.5.5-super.4", { rootDir: root })).toThrow(
        "Expected bun.lock importer apps/server to identify package @synara/cli.",
      );
      expect(readFileSync(resolve(root, releasePackageFiles[0]), "utf8")).toBe(originalManifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
