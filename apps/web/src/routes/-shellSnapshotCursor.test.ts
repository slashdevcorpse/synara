import { describe, expect, it } from "vitest";

import { shellResnapshotRetryDelayMs, shouldCommitShellSnapshot } from "./-shellSnapshotCursor";

describe("shell snapshot cursor reconciliation", () => {
  it("rejects an in-flight response older than a newer stream snapshot", () => {
    expect(
      shouldCommitShellSnapshot({
        snapshotSequence: 15,
        currentSequence: 20,
        requiredSequence: 10,
      }),
    ).toBe(false);
  });

  it("rejects a snapshot before the visibility invalidation cursor", () => {
    expect(
      shouldCommitShellSnapshot({
        snapshotSequence: 9,
        currentSequence: 8,
        requiredSequence: 10,
      }),
    ).toBe(false);
    expect(
      shouldCommitShellSnapshot({
        snapshotSequence: 10,
        currentSequence: 8,
        requiredSequence: 10,
      }),
    ).toBe(true);
  });

  it("backs stale retries off to a bounded one-second cadence", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(shellResnapshotRetryDelayMs)).toEqual([
      50, 100, 200, 400, 800, 1_000, 1_000,
    ]);
  });
});
