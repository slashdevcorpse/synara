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
  it("never issues the delayed create-capable open for a reattach-only identity", () => {
    expect(
      shouldScheduleTerminalSnapshotReconcile({
        reattachOnly: true,
        unavailableRecovery: false,
        outputUnchanged: true,
      }),
    ).toBe(false);
    expect(
      shouldScheduleTerminalSnapshotReconcile({
        reattachOnly: false,
        unavailableRecovery: false,
        outputUnchanged: true,
      }),
    ).toBe(true);
  });
});

describe("isUnavailableTerminalRecovery", () => {
  it("blocks follow-up opens only when a reattach-only identity has no live process", () => {
    expect(isUnavailableTerminalRecovery({ reattachOnly: true, status: "exited" })).toBe(true);
    expect(isUnavailableTerminalRecovery({ reattachOnly: true, status: "error" })).toBe(true);
    expect(isUnavailableTerminalRecovery({ reattachOnly: true, status: "running" })).toBe(false);
    expect(isUnavailableTerminalRecovery({ reattachOnly: false, status: "exited" })).toBe(false);
  });
});
