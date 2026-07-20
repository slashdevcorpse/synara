import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDesktopSmokeEnvironment,
  createDesktopSmokeSpawnSpec,
  superviseDesktopSmokeProcess,
} from "./smoke-test-lifecycle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const electronBin = require("electron");
const mainJs = resolve(desktopDir, "dist-electron/main.js");
const windowsHelperPath = resolve(__dirname, "smoke-test-windows-job.ps1");
const windowsJobRunId = randomUUID();

console.log("\nLaunching Electron smoke test...");

const spawnSpec = createDesktopSmokeSpawnSpec({
  executable: electronBin,
  args: [mainJs],
  environment: createDesktopSmokeEnvironment(),
  windowsHelperPath,
  windowsJobRunId,
  workingDirectory: desktopDir,
});
const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);

const result = await superviseDesktopSmokeProcess({ child, windowsJobRunId });
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
