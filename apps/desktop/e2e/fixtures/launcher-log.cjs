// FILE: launcher-log.cjs
// Purpose: Records every fake Codex launcher invocation before the fixture process starts.

"use strict";

const FS = require("node:fs");
const Path = require("node:path");

const networkGuardPath = process.env.SYNARA_FAKE_CODEX_NETWORK_GUARD_PATH;
if (!networkGuardPath) {
  throw new Error("Fake Codex launcher logger requires SYNARA_FAKE_CODEX_NETWORK_GUARD_PATH.");
}
require(networkGuardPath);

const invocationLogPath = process.env.SYNARA_FAKE_CODEX_INVOCATION_LOG_PATH;
if (!invocationLogPath) {
  throw new Error("Fake Codex launcher logger requires SYNARA_FAKE_CODEX_INVOCATION_LOG_PATH.");
}

FS.mkdirSync(Path.dirname(invocationLogPath), { recursive: true });
FS.appendFileSync(
  invocationLogPath,
  `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, args: process.argv.slice(2) })}\n`,
  "utf8",
);
