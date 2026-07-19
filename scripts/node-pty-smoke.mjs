#!/usr/bin/env node
// FILE: node-pty-smoke.mjs
// Purpose: Verifies that the native node-pty dependency can load and spawn a PTY.
// Layer: Release/CI smoke check

import { createRequire } from "node:module";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const requireRoot =
  process.env.SYNARA_NODE_PTY_SMOKE_REQUIRE_ROOT?.trim() || resolve(repoRoot, "apps/server");
const requireFromTarget = createRequire(resolve(requireRoot, "package.json"));
const expectedOutput = "synara-node-pty-smoke";

function fail(message, detail) {
  console.error(`[node-pty-smoke] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

let nodePty;
try {
  nodePty = requireFromTarget("node-pty");
} catch (error) {
  fail("Failed to load node-pty.", error instanceof Error ? error.stack : String(error));
}

const isWindows = process.platform === "win32";

if (process.platform === "darwin") {
  try {
    const nodePtyPackageRoot = dirname(requireFromTarget.resolve("node-pty/package.json"));
    const selectedNativeModules = Object.keys(requireFromTarget.cache).filter((modulePath) => {
      const relativeModulePath = relative(nodePtyPackageRoot, modulePath);
      const isInsidePackage =
        relativeModulePath !== ".." &&
        !relativeModulePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativeModulePath);
      return isInsidePackage && modulePath.endsWith(`${sep}pty.node`);
    });

    if (selectedNativeModules.length !== 1) {
      fail(
        `Expected exactly one loaded node-pty native module, found ${selectedNativeModules.length}.`,
        selectedNativeModules.join("\n"),
      );
    }

    const spawnHelperPath = resolve(dirname(selectedNativeModules[0]), "spawn-helper");
    const spawnHelperStat = lstatSync(spawnHelperPath);

    if (spawnHelperStat.isSymbolicLink() || !spawnHelperStat.isFile()) {
      fail(`Refusing to execute unsafe node-pty spawn helper: ${spawnHelperPath}`);
    }

    const executableBits = 0o111;
    if ((spawnHelperStat.mode & executableBits) !== executableBits) {
      chmodSync(spawnHelperPath, spawnHelperStat.mode | executableBits);
      console.log(`[node-pty-smoke] Restored execute permissions on ${spawnHelperPath}.`);
    }
  } catch (error) {
    fail(
      "Failed to qualify the node-pty spawn helper.",
      error instanceof Error ? error.stack : String(error),
    );
  }
}

const shell = isWindows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
const args = isWindows
  ? ["/d", "/s", "/c", `echo ${expectedOutput}`]
  : ["-lc", `printf '${expectedOutput}'`];

let output = "";
let terminal;
try {
  terminal = nodePty.spawn(shell, args, {
    cols: 80,
    rows: 24,
    cwd: requireRoot,
    env: process.env,
    name: isWindows ? "xterm-color" : "xterm-256color",
  });
} catch (error) {
  fail("Failed to spawn node-pty process.", error instanceof Error ? error.stack : String(error));
}

const timeout = setTimeout(() => {
  try {
    terminal.kill();
  } catch {
    // Best-effort cleanup; the failure below is the useful signal.
  }
  fail("Timed out waiting for node-pty output.", output);
}, 5_000);

terminal.onData((chunk) => {
  output += chunk;
});

terminal.onExit((event) => {
  clearTimeout(timeout);
  if (!output.includes(expectedOutput)) {
    fail(`Expected PTY output "${expectedOutput}" was not observed.`, output);
  }
  if (event.exitCode !== 0) {
    fail(`PTY process exited with code ${event.exitCode}.`, output);
  }
  console.log("[node-pty-smoke] node-pty loaded and spawned successfully.");
});
