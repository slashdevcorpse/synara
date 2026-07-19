#!/usr/bin/env node
// FILE: verify-super-synara-macos-allowlist.ts
// Purpose: Fails publication preflight unless a populated reviewed macOS signature policy is committed.
// Layer: Release publication admission

import { readFileSync } from "node:fs";

import {
  type MacSignatureAllowlist,
  validateMacSignatureAllowlist,
} from "./lib/super-synara-macos-signatures.ts";

const [allowlistPath, electronVersion] = process.argv.slice(2);
if (!allowlistPath || !electronVersion) {
  throw new Error(
    "Usage: node scripts/verify-super-synara-macos-allowlist.ts <allowlist-path> <electron-version>",
  );
}
const allowlist = validateMacSignatureAllowlist(
  JSON.parse(readFileSync(allowlistPath, "utf8")) as MacSignatureAllowlist,
);
if (allowlist.electronVersion !== electronVersion) {
  throw new Error(
    `Reviewed macOS signature policy pins Electron ${allowlist.electronVersion}, expected ${electronVersion}.`,
  );
}
console.log(
  `Admitted reviewed macOS signature policy with ${allowlist.productOwnedPaths.length} product paths and ${allowlist.thirdParty.length} third-party paths.`,
);
