// FILE: tsdown.config.ts
// Purpose: Builds the Synara server CLI and controls diagnostic source maps.
// Layer: Server build config
// Depends on: tsdown.

import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.SYNARA_SERVER_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";

export function bundleServerRuntimeDependency(id: string): boolean {
  return id.startsWith("@synara/") || id.startsWith("@effect/platform-node");
}

export default defineConfig({
  entry: ["src/index.ts", "src/restoreMigrationBackup.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: buildSourcemap,
  clean: true,
  // ACP lifecycle ownership relies on Synara's audited platform-node-shared patch. The standalone
  // npm package cannot ask npm to apply a transitive Bun patch, so platform-node and its shared
  // implementation must ship inside the server bundle. `effect` remains external so runtime
  // service identities are shared with the rest of the dependency graph.
  noExternal: bundleServerRuntimeDependency,
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
