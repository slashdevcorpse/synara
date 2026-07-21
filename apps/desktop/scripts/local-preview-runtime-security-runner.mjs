// FILE: local-preview-runtime-security-runner.mjs
// Purpose: Runs the Electron security probe with a recoverable result channel on Windows.
// Layer: Desktop security smoke-test launcher

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const resultDirectory = mkdtempSync(join(tmpdir(), "synara-local-preview-security-result-"));
const resultPath = join(resultDirectory, "result.json");
const appDirectory = join(resultDirectory, "app");
const profileDirectory = join(resultDirectory, "profile");
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const probeMainPath = join(scriptsDirectory, "local-preview-runtime-security.cjs");
mkdirSync(appDirectory);
mkdirSync(profileDirectory);
writeFileSync(
  join(appDirectory, "package.json"),
  `${JSON.stringify({ name: "synara-local-preview-security", version: "1.0.0", main: "main.cjs" })}\n`,
);
writeFileSync(join(appDirectory, "main.cjs"), `require(${JSON.stringify(probeMainPath)});\n`);
const childEnv = {
  ...process.env,
  SYNARA_LOCAL_PREVIEW_SECURITY_RESULT: resultPath,
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(resolveElectronPath(), [`--user-data-dir=${profileDirectory}`, appDirectory], {
  cwd: desktopDir,
  env: childEnv,
  stdio: "inherit",
});

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 30_000);

const exit = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ error, code: null, signal: null }));
  child.once("exit", (code, signal) => resolve({ error: null, code, signal }));
});
clearTimeout(timeout);

let result = null;
try {
  result = JSON.parse(readFileSync(resultPath, "utf8"));
} catch {
  result = null;
}
rmSync(resultDirectory, { force: true, recursive: true });

if (result) {
  process.stdout.write(`LOCAL_PREVIEW_RUNTIME_SECURITY=${JSON.stringify(result)}\n`);
}
if (timedOut || exit.error || exit.signal || exit.code !== 0 || result?.passed !== true) {
  if (!result) {
    process.stderr.write(
      `Local-preview runtime security probe failed without a result (timeout=${timedOut}, code=${String(exit.code)}, signal=${String(exit.signal)}).\n`,
    );
  }
  process.exit(1);
}
