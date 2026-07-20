import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  readonly devDependencies?: Readonly<Record<string, string>>;
};
const webPackageManifest = JSON.parse(
  readFileSync(new URL("../../apps/web/package.json", import.meta.url), "utf8"),
) as {
  readonly dependencies?: Readonly<Record<string, string>>;
};
const marketingPackageManifest = JSON.parse(
  readFileSync(new URL("../../apps/marketing/package.json", import.meta.url), "utf8"),
) as {
  readonly dependencies?: Readonly<Record<string, string>>;
};
const lockfile = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");

const securityPins = {
  "@babel/core": "7.29.7",
  "js-yaml": "4.2.0",
  picomatch: "2.3.2",
  undici: "7.28.0",
} as const;

describe("dependency security pins", () => {
  it("keeps the audited compatible major resolutions explicit", () => {
    expect(packageManifest.devDependencies).toMatchObject(securityPins);
    for (const [packageName, version] of Object.entries(securityPins)) {
      expect(lockfile).toContain(
        `${JSON.stringify(packageName)}: [${JSON.stringify(`${packageName}@${version}`)}`,
      );
    }
  });

  it("retains the web build's Babel 8 dependency beside the audited Babel 7 pin", () => {
    expect(lockfile).toContain('"@synara/web/@babel/core": ["@babel/core@8.0.1"');
  });

  it("keeps react-icons on the upstream-compatible export surface", () => {
    expect(webPackageManifest.dependencies).toMatchObject({ "react-icons": "5.6.0" });
    expect(lockfile).toContain('"react-icons": ["react-icons@5.6.0"');
    expect(lockfile).not.toContain('"react-icons": ["react-icons@5.7.0"');
  });

  it("keeps the marketing build beyond the audited Astro and esbuild ranges", () => {
    expect(marketingPackageManifest.dependencies).toMatchObject({ astro: "7.1.1" });
    expect(lockfile).toContain('"astro": ["astro@7.1.1"');
    expect(lockfile).not.toContain('["astro@6.4.8"');
    expect(lockfile).not.toContain('["esbuild@0.27.');
  });

  it("does not retain the vulnerable stale resolutions", () => {
    for (const resolution of [
      "@babel/core@7.29.0",
      "js-yaml@4.1.1",
      "picomatch@2.3.1",
      "undici@7.24.4",
    ]) {
      expect(lockfile).not.toContain(`[${JSON.stringify(resolution)}`);
    }
  });
});
