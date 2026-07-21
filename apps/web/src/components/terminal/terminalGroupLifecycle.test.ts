import { describe, expect, it, vi } from "vitest";

import {
  closeTerminalGroupTransaction,
  stopTerminalGroupForArchive,
} from "./terminalGroupLifecycle";

describe("stopTerminalGroupForArchive", () => {
  it("archives only after every terminal stops", async () => {
    const markTerminalStopped = vi.fn();
    const archiveGroup = vi.fn();
    const result = await stopTerminalGroupForArchive({
      terminalIds: ["one", "two"],
      stopTerminal: async () => undefined,
      markTerminalStopped,
      archiveGroup,
    });

    expect(result).toEqual({
      archived: true,
      stoppedTerminalIds: ["one", "two"],
      failedTerminalIds: [],
    });
    expect(markTerminalStopped.mock.calls).toEqual([["one"], ["two"]]);
    expect(archiveGroup).toHaveBeenCalledOnce();
  });

  it("keeps the group visible and never marks a rejected stop as stopped", async () => {
    const markTerminalStopped = vi.fn();
    const archiveGroup = vi.fn();
    const result = await stopTerminalGroupForArchive({
      terminalIds: ["stopped", "failed"],
      stopTerminal: async (terminalId) => {
        if (terminalId === "failed") throw new Error("close rejected");
      },
      markTerminalStopped,
      archiveGroup,
    });

    expect(result).toEqual({
      archived: false,
      stoppedTerminalIds: ["stopped"],
      failedTerminalIds: ["failed"],
    });
    expect(markTerminalStopped).toHaveBeenCalledWith("stopped");
    expect(markTerminalStopped).not.toHaveBeenCalledWith("failed");
    expect(archiveGroup).not.toHaveBeenCalled();
  });
});

describe("closeTerminalGroupTransaction", () => {
  it("removes an empty group locally without issuing a server close", async () => {
    const closeTerminals = vi.fn().mockResolvedValue(undefined);
    const disposeTerminal = vi.fn();
    const removeGroup = vi.fn();
    const result = await closeTerminalGroupTransaction({
      terminalIds: [],
      closeTerminals,
      disposeTerminal,
      removeGroup,
    });

    expect(result).toEqual({ closed: true, failedTerminalIds: [] });
    expect(closeTerminals).not.toHaveBeenCalled();
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(removeGroup).toHaveBeenCalledOnce();
  });

  it("removes local state and runtimes only after every server close succeeds", async () => {
    const disposeTerminal = vi.fn();
    const removeGroup = vi.fn();
    const result = await closeTerminalGroupTransaction({
      terminalIds: ["one", "two"],
      closeTerminals: async () => undefined,
      disposeTerminal,
      removeGroup,
    });

    expect(result).toEqual({ closed: true, failedTerminalIds: [] });
    expect(disposeTerminal.mock.calls).toEqual([["one"], ["two"]]);
    expect(removeGroup).toHaveBeenCalledOnce();
  });

  it("preserves every local runtime and group when the atomic server close fails", async () => {
    const disposeTerminal = vi.fn();
    const removeGroup = vi.fn();
    const result = await closeTerminalGroupTransaction({
      terminalIds: ["closed", "failed"],
      closeTerminals: async () => {
        throw new Error("batch close rejected");
      },
      disposeTerminal,
      removeGroup,
    });

    expect(result).toEqual({ closed: false, failedTerminalIds: ["closed", "failed"] });
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(removeGroup).not.toHaveBeenCalled();
  });
});
