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
    const environment = createDesktopSourceBuildEnvironment({
      baseEnvironment: { synara_generated_route_tree: "inherited", PRESERVED: "yes" },
      flavor: "super",
      disableUpdates: true,
      exactProvenanceRequested: true,
      generatedRouteTreePath: "C:\\release-stage\\routeTree.gen.ts",
    });

    expect(environment).toMatchObject({
      PRESERVED: "yes",
      SYNARA_DESKTOP_FLAVOR: "super",
      SYNARA_DESKTOP_DISABLE_UPDATES: "1",
      SYNARA_GENERATED_ROUTE_TREE: "C:\\release-stage\\routeTree.gen.ts",
    });
    expect(environment).not.toHaveProperty("synara_generated_route_tree");
  });

  it("removes inherited route-tree redirects outside exact-provenance builds", () => {
    const environment = createDesktopSourceBuildEnvironment({
      baseEnvironment: {
        SYNARA_GENERATED_ROUTE_TREE: "inherited-uppercase",
        Synara_Generated_Route_Tree: "inherited-mixed-case",
        synara_generated_route_tree: "inherited-lowercase",
        PRESERVED: "yes",
      },
      flavor: "production",
      disableUpdates: false,
      exactProvenanceRequested: false,
    });

    expect(environment).toMatchObject({
      PRESERVED: "yes",
      SYNARA_DESKTOP_FLAVOR: "production",
      SYNARA_DESKTOP_DISABLE_UPDATES: "0",
    });
    expect(
      Object.keys(environment).filter((key) => key.toUpperCase() === "SYNARA_GENERATED_ROUTE_TREE"),
    ).toEqual([]);
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
