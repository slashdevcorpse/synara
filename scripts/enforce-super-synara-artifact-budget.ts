#!/usr/bin/env node
// FILE: enforce-super-synara-artifact-budget.ts
// Purpose: Fails before Actions upload when an intermediate artifact exceeds its byte budget.
// Layer: Release publication admission

import { enforceReleaseByteCap } from "./lib/super-synara-release-admission.ts";

const [directory, maxBytesInput] = process.argv.slice(2);
if (!directory || !maxBytesInput) {
  throw new Error(
    "Usage: node scripts/enforce-super-synara-artifact-budget.ts <directory> <max-bytes>",
  );
}
const maxBytes = Number(maxBytesInput);
const usedBytes = enforceReleaseByteCap(directory, maxBytes);
console.log(`Artifact staging uses ${usedBytes} of ${maxBytes} allowed bytes.`);
