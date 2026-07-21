// FILE: viteRouteGeneration.ts
// Purpose: Redirects TanStack route-tree generation and bundling away from reviewed source.
// Layer: Web build configuration

import { isAbsolute } from "node:path";

export function resolveGeneratedRouteTree(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.SYNARA_GENERATED_ROUTE_TREE?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) {
    throw new Error("SYNARA_GENERATED_ROUTE_TREE must be an absolute path when set.");
  }
  return value;
}
