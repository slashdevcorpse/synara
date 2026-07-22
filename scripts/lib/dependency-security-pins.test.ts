import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly patchedDependencies?: Readonly<Record<string, string>>;
};
const serverPackageManifest = JSON.parse(
  readFileSync(new URL("../../apps/server/package.json", import.meta.url), "utf8"),
) as {
  readonly dependencies?: Readonly<Record<string, string>>;
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
const effectProcessPatchPath = "patches/@effect%2Fplatform-node-shared@8881a9b.patch";
const effectProcessPatch = readFileSync(
  new URL("../../patches/@effect%252Fplatform-node-shared@8881a9b.patch", import.meta.url),
  "utf8",
);
const platformNodeRequire = createRequire(require.resolve("@effect/platform-node/package.json"));
const effectProcessPackageRoot = dirname(
  platformNodeRequire.resolve("@effect/platform-node-shared/package.json"),
);
const effectProcessSource = readFileSync(
  join(effectProcessPackageRoot, "src/NodeChildProcessSpawner.ts"),
  "utf8",
);
const effectProcessRuntime = readFileSync(
  join(effectProcessPackageRoot, "dist/NodeChildProcessSpawner.js"),
  "utf8",
);

const securityPins = {
  "@babel/core": "7.29.7",
  "js-yaml": "4.3.0",
  picomatch: "2.3.2",
  undici: "7.28.0",
} as const;
const piSdkPins = {
  "@earendil-works/pi-agent-core": "0.80.6",
  "@earendil-works/pi-ai": "0.80.6",
  "@earendil-works/pi-coding-agent": "0.80.6",
} as const;

describe("dependency security pins", () => {
  it("keeps the audited compatible major resolutions explicit", () => {
    expect(packageManifest.devDependencies).toMatchObject(securityPins);
    expect(packageManifest.overrides).toMatchObject({ "js-yaml": "4.3.0" });
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

  it("keeps the Pi SDK on the adapter-compatible API surface", () => {
    expect(serverPackageManifest.dependencies).toMatchObject(piSdkPins);
    expect(packageManifest.overrides).toMatchObject({
      ...piSdkPins,
      "@earendil-works/pi-tui": "0.80.6",
    });
    for (const packageName of [...Object.keys(piSdkPins), "@earendil-works/pi-tui"]) {
      expect(lockfile).toContain(
        `${JSON.stringify(packageName)}: [${JSON.stringify(`${packageName}@0.80.6`)}`,
      );
      expect(lockfile).not.toContain(
        `${JSON.stringify(packageName)}: [${JSON.stringify(`${packageName}@0.80.10`)}`,
      );
    }
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
      "js-yaml@4.2.0",
      "picomatch@2.3.1",
      "undici@7.24.4",
    ]) {
      expect(lockfile).not.toContain(`[${JSON.stringify(resolution)}`);
    }
  });

  it("keeps Effect child processes on Synara's identity-owned teardown path", () => {
    expect(packageManifest.patchedDependencies).toMatchObject({
      "@effect/platform-node-shared@https://pkg.pr.new/Effect-TS/effect-smol/@effect/platform-node-shared@8881a9b606d84a6f5eb6615279138322984f5368":
        effectProcessPatchPath,
    });
    expect(effectProcessPatch).toContain("synaraExternallySupervised");
    expect(effectProcessPatch).toContain("synaraCloseStdin");
    expect(effectProcessPatch).toContain("synaraTerminateExact");
    expect(effectProcessPatch).not.toContain("-              if (code !== 0");
    expect(effectProcessPatch).not.toContain(
      "-                return yield* Effect.ignore(killWithTimeout(killProcessGroup))",
    );
  });

  it("keeps the patched Effect TypeScript source on a typed handle extension", () => {
    const handleInitializer = effectProcessSource.match(
      /const handle = makeHandle\(\{([\s\S]*?)\n\s*\}\)\n\s*return Object\.assign/,
    );

    expect(effectProcessSource).toContain("const handle = makeHandle({");
    expect(effectProcessSource).toContain("return Object.assign(handle, {");
    expect(effectProcessSource).toContain("synaraCloseStdin");
    expect(effectProcessSource).toContain("synaraTerminateExact: () => childProcess.kill()");
    expect(effectProcessSource).toContain("if (code !== 0 && Predicate.isNotNull(code))");
    expect(handleInitializer?.[1]).not.toContain("synaraCloseStdin");
    expect(effectProcessRuntime).toContain("synaraExternallySupervised");
    expect(effectProcessRuntime).toContain("synaraCloseStdin");
    expect(effectProcessRuntime).toContain("synaraTerminateExact: () => childProcess.kill()");
  });
});
