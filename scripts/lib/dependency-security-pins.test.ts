import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  readonly devDependencies?: Readonly<Record<string, string>>;
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
