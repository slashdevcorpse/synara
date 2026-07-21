import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopSourceBuildEnvironment,
  resolveDesktopGeneratedRouteTreePath,
} from "./desktop-source-build-environment.ts";

describe("desktop source build environment", () => {
  it("uses one hashed route-tree path across exact-build retries", () => {
    const turboConfig = JSON.parse(
      readFileSync(new URL("../../turbo.json", import.meta.url), "utf8"),
    ) as {
      readonly globalEnv?: ReadonlyArray<string>;
      readonly globalPassThroughEnv?: ReadonlyArray<string>;
    };
    const repoRoot = resolve("release-worktree");
    const generatedPath = resolveDesktopGeneratedRouteTreePath(repoRoot);

    expect(generatedPath).toBe(
      resolve(repoRoot, "node_modules", ".cache", "super-synara-route-tree", "routeTree.gen.ts"),
    );
    expect(resolveDesktopGeneratedRouteTreePath(repoRoot)).toBe(generatedPath);
    expect(turboConfig.globalEnv ?? []).toContain("SYNARA_GENERATED_ROUTE_TREE");
    expect(turboConfig.globalPassThroughEnv ?? []).not.toContain("SYNARA_GENERATED_ROUTE_TREE");
  });

  it("redirects route-tree generation for exact-provenance builds", () => {
    expect(
      createDesktopSourceBuildEnvironment({
        baseEnvironment: { SYNARA_GENERATED_ROUTE_TREE: "inherited", PRESERVED: "yes" },
        flavor: "super",
        disableUpdates: true,
        exactProvenanceRequested: true,
        generatedRouteTreePath: "C:\\release-stage\\routeTree.gen.ts",
      }),
    ).toMatchObject({
      PRESERVED: "yes",
      SYNARA_DESKTOP_FLAVOR: "super",
      SYNARA_DESKTOP_DISABLE_UPDATES: "1",
      SYNARA_GENERATED_ROUTE_TREE: "C:\\release-stage\\routeTree.gen.ts",
    });
  });

  it("preserves caller route-tree output outside exact-provenance builds", () => {
    expect(
      createDesktopSourceBuildEnvironment({
        baseEnvironment: { SYNARA_GENERATED_ROUTE_TREE: "inherited" },
        flavor: "production",
        disableUpdates: false,
        exactProvenanceRequested: false,
      }),
    ).toMatchObject({
      SYNARA_DESKTOP_FLAVOR: "production",
      SYNARA_DESKTOP_DISABLE_UPDATES: "0",
      SYNARA_GENERATED_ROUTE_TREE: "inherited",
    });
  });

  it("fails closed when an exact build has no redirect", () => {
    expect(() =>
      createDesktopSourceBuildEnvironment({
        baseEnvironment: {},
        flavor: "super",
        disableUpdates: true,
        exactProvenanceRequested: true,
      }),
    ).toThrow("require a generated route-tree redirect path");
  });
});
