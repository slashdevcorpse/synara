// FILE: release-lockfile-provenance.ts
// Purpose: Resolves and verifies the exact source bun.lock digest used by release artifacts.
// Layer: Release provenance

import { createHash } from "node:crypto";

export function resolveReleaseLockfileSha256(lockfileBytes: Uint8Array): string {
  return createHash("sha256").update(lockfileBytes).digest("hex");
}

export function verifyReleaseLockfileSha256(
  lockfileBytes: Uint8Array,
  expectedSha256: string,
): string {
  if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw new Error(`Expected a 64-character lockfile SHA-256, got '${expectedSha256}'.`);
  }

  const resolvedSha256 = resolveReleaseLockfileSha256(lockfileBytes);
  if (resolvedSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Release lockfile digest mismatch: expected ${expectedSha256}, got ${resolvedSha256}.`,
    );
  }
  return resolvedSha256;
}
