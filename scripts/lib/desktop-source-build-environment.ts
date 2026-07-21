// FILE: desktop-source-build-environment.ts
// Purpose: Builds the environment used to compile reviewed desktop release source.
// Layer: Release/build helper

import { join } from "node:path";

export interface DesktopSourceBuildEnvironmentInput {
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly flavor: string;
  readonly disableUpdates: boolean;
  readonly exactProvenanceRequested: boolean;
  readonly generatedRouteTreePath?: string;
}

export function resolveDesktopGeneratedRouteTreePath(repoRoot: string): string {
  return join(repoRoot, "node_modules", ".cache", "super-synara-route-tree", "routeTree.gen.ts");
}

export function createDesktopSourceBuildEnvironment(
  input: DesktopSourceBuildEnvironmentInput,
): NodeJS.ProcessEnv {
  if (input.exactProvenanceRequested && !input.generatedRouteTreePath) {
    throw new Error("Exact-provenance builds require a generated route-tree redirect path.");
  }
  const baseEnvironment = { ...input.baseEnvironment };
  delete baseEnvironment.SYNARA_GENERATED_ROUTE_TREE;
  return {
    ...baseEnvironment,
    SYNARA_DESKTOP_FLAVOR: input.flavor,
    SYNARA_DESKTOP_DISABLE_UPDATES: input.disableUpdates ? "1" : "0",
    ...(input.exactProvenanceRequested
      ? { SYNARA_GENERATED_ROUTE_TREE: input.generatedRouteTreePath }
      : {}),
  };
}
