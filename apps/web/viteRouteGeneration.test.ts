import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGeneratedRouteTree } from "./viteRouteGeneration";

describe("Vite route generation policy", () => {
  it("uses the committed output by default and accepts an absolute redirect", () => {
    const redirectedPath = resolve("release-stage/generated-route-tree/routeTree.gen.ts");

    expect(resolveGeneratedRouteTree({})).toBeUndefined();
    expect(resolveGeneratedRouteTree({ SYNARA_GENERATED_ROUTE_TREE: "  " })).toBeUndefined();
    expect(resolveGeneratedRouteTree({ SYNARA_GENERATED_ROUTE_TREE: ` ${redirectedPath} ` })).toBe(
      redirectedPath,
    );
  });

  it("rejects relative redirects that could write into reviewed source", () => {
    expect(() =>
      resolveGeneratedRouteTree({ SYNARA_GENERATED_ROUTE_TREE: "src/routeTree.gen.ts" }),
    ).toThrow("must be an absolute path");
  });
});
