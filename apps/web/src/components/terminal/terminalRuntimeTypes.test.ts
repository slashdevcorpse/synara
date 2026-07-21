// FILE: terminalRuntimeTypes.test.ts
// Purpose: Cover stable runtime identity helpers without pulling browser-only runtime modules.
// Layer: Terminal runtime tests

import { describe, expect, it } from "vitest";

import {
  buildTerminalRuntimeKey,
  isUnavailableTerminalRecovery,
  shouldScheduleTerminalSnapshotReconcile,
} from "./terminalRuntimeTypes";

describe("buildTerminalRuntimeKey", () => {
  it("builds a thread-scoped runtime key for terminal persistence", () => {
    expect(buildTerminalRuntimeKey("thread-123", "terminal-abc")).toBe("thread-123::terminal-abc");
  });
});

describe("shouldScheduleTerminalSnapshotReconcile", () => {
  it.each([
    [false, false, false, false],
    [false, false, true, true],
    [false, true, false, false],
    [false, true, true, false],
    [true, false, false, false],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, false],
  ] as const)(
    "returns %s/%s/%s => %s for every reconcile guard permutation",
    (reattachOnly, unavailableRecovery, outputUnchanged, expected) => {
      expect(
        shouldScheduleTerminalSnapshotReconcile({
          reattachOnly,
          unavailableRecovery,
          outputUnchanged,
        }),
      ).toBe(expected);
    },
  );
});

describe("isUnavailableTerminalRecovery", () => {
  it("blocks follow-up opens only when a reattach-only identity has no live process", () => {
    expect(isUnavailableTerminalRecovery({ reattachOnly: true, status: "exited" })).toBe(true);
    expect(isUnavailableTerminalRecovery({ reattachOnly: true, status: "error" })).toBe(true);
    expect(isUnavailableTerminalRecovery({ reattachOnly: true, status: "running" })).toBe(false);
    expect(isUnavailableTerminalRecovery({ reattachOnly: false, status: "exited" })).toBe(false);
  });
});
