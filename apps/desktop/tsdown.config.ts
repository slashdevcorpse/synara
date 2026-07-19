// FILE: tsdown.config.ts
// Purpose: Builds Electron main/preload code and controls diagnostic source maps.
// Layer: Desktop build config
// Depends on: tsdown.

import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.SYNARA_DESKTOP_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const windowsUpdaterPublisher = process.env.AZURE_TRUSTED_SIGNING_SUBJECT_DN?.trim() ?? "";
const packagedDesktopFlavor =
  process.env.SYNARA_DESKTOP_FLAVOR?.trim().toLowerCase() || "production";
if (!new Set(["production", "canary", "super"]).has(packagedDesktopFlavor)) {
  throw new Error(`Invalid packaged desktop flavor '${packagedDesktopFlavor}'.`);
}
const packagedUpdatesDisabled =
  packagedDesktopFlavor === "super" ||
  ["1", "true"].includes(process.env.SYNARA_DESKTOP_DISABLE_UPDATES?.trim().toLowerCase() ?? "");

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: buildSourcemap,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    define: {
      __SYNARA_WINDOWS_UPDATER_PUBLISHER__: JSON.stringify(windowsUpdaterPublisher),
      __SYNARA_PACKAGED_DESKTOP_FLAVOR__: JSON.stringify(packagedDesktopFlavor),
      __SYNARA_PACKAGED_UPDATES_DISABLED__: JSON.stringify(packagedUpdatesDisabled),
    },
    noExternal: (id) => id.startsWith("@synara/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
]);
