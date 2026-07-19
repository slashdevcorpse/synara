import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDesktopSmokeEnvironment,
  superviseDesktopSmokeProcess,
} from "./smoke-test-lifecycle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const electronBin = require("electron");
const mainJs = resolve(desktopDir, "dist-electron/main.js");

console.log("\nLaunching Electron smoke test...");

const child = spawn(electronBin, [mainJs], {
  stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32",
  env: createDesktopSmokeEnvironment(),
});

const result = await superviseDesktopSmokeProcess({ child });
if (!result.ok) {
  console.error("\nDesktop smoke test failed:");
  for (const failure of result.failures) {
    console.error(` - ${failure}`);
  }
  for (const diagnostic of result.teardownDiagnostics) {
    console.error(` - ${diagnostic}`);
  }
  console.error("\nFull output:\n" + result.output);
  process.exit(1);
}

console.log("Desktop smoke test passed.");
process.exit(0);
