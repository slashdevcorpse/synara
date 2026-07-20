import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  resolveReleaseLockfileSha256,
  verifyReleaseLockfileSha256,
} from "./release-lockfile-provenance.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("release lockfile provenance", () => {
  it("pins bun.lock to LF so clean Windows checkouts preserve source digest bytes", () => {
    const attributes = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8").split(/\r?\n/);
    expect(attributes).toContain("bun.lock text eol=lf");
  });

  it("distinguishes a Windows-converted lockfile from the committed source bytes", () => {
    const committedBytes = Buffer.from('lockfileVersion = 1\nentry = "same"\n');
    const windowsConvertedBytes = Buffer.from('lockfileVersion = 1\r\nentry = "same"\r\n');
    const expectedSha256 = resolveReleaseLockfileSha256(committedBytes);

    expect(resolveReleaseLockfileSha256(windowsConvertedBytes)).not.toBe(expectedSha256);
    expect(() => verifyReleaseLockfileSha256(windowsConvertedBytes, expectedSha256)).toThrow(
      "Release lockfile digest mismatch",
    );
  });

  it("accepts exact source bytes and rejects a tampered source lockfile", () => {
    const sourceBytes = Buffer.from('lockfileVersion = 1\nentry = "expected"\n');
    const expectedSha256 = resolveReleaseLockfileSha256(sourceBytes);

    expect(verifyReleaseLockfileSha256(sourceBytes, expectedSha256.toUpperCase())).toBe(
      expectedSha256,
    );
    expect(() =>
      verifyReleaseLockfileSha256(
        Buffer.from('lockfileVersion = 1\nentry = "tampered"\n'),
        expectedSha256,
      ),
    ).toThrow("Release lockfile digest mismatch");
    expect(() => verifyReleaseLockfileSha256(sourceBytes, "not-a-digest")).toThrow(
      "Expected a 64-character lockfile SHA-256",
    );
  });
});
