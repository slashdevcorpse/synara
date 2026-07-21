import { describe, expect, it } from "vitest";

import { assertFullCommitSha } from "./git-sha.ts";

describe("assertFullCommitSha", () => {
  it("accepts exact lowercase and uppercase hexadecimal commits", () => {
    expect(() => assertFullCommitSha("Commit", "a".repeat(40))).not.toThrow();
    expect(() => assertFullCommitSha("Commit", "A".repeat(40))).not.toThrow();
  });

  it.each(["a".repeat(39), "a".repeat(41), `${"a".repeat(39)}g`])(
    "rejects a non-commit value: %s",
    (value) => {
      expect(() => assertFullCommitSha("Commit", value)).toThrow(
        "Commit must be a full 40-character commit SHA.",
      );
    },
  );
});
