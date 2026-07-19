#!/usr/bin/env node
// FILE: verify-release-worktree-clean.ts
// Purpose: CLI guard for immutable release source and explicitly declared output roots.
// Layer: Release provenance

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseWorktreeCleanliness } from "./lib/release-worktree-cleanliness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedOutputRoots = process.argv.slice(2);
verifyReleaseWorktreeCleanliness(repoRoot, allowedOutputRoots);
console.log(
  allowedOutputRoots.length === 0
    ? "Release worktree exactly matches HEAD."
    : `Release worktree matches HEAD outside declared outputs: ${allowedOutputRoots.join(", ")}.`,
);
