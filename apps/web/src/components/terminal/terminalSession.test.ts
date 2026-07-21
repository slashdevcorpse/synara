import type { NativeApi } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeRegistry = vi.hoisted(() => ({ disposeTerminal: vi.fn() }));

vi.mock("./terminalRuntimeRegistry", () => ({ terminalRuntimeRegistry: runtimeRegistry }));

import {
  closeTerminalSessionsStrict,
  restartTerminalSession,
  shouldAttachTerminalRuntime,
  stopTerminalSessionPreservingHistory,
  terminalExitStateFromProcessExit,
  terminalExitStateFromRecovery,
} from "./terminalSession";

function apiWithTerminal(terminal: Record<string, unknown>): NativeApi {
  return { terminal } as unknown as NativeApi;
}

describe("terminal session lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not dispose the local runtime when the preserving close rejects", async () => {
    const close = vi.fn().mockRejectedValue(new Error("close rejected"));

    await expect(
      stopTerminalSessionPreservingHistory({
        api: apiWithTerminal({ close }),
        threadId: "thread",
        terminalId: "terminal",
      }),
    ).rejects.toThrow("close rejected");
    expect(runtimeRegistry.disposeTerminal).not.toHaveBeenCalled();
  });

  it("disposes only after a preserving close succeeds", async () => {
    const close = vi.fn().mockResolvedValue(undefined);

    await stopTerminalSessionPreservingHistory({
      api: apiWithTerminal({ close }),
      threadId: "thread",
      terminalId: "terminal",
    });
    expect(close).toHaveBeenCalledWith({
      threadId: "thread",
      terminalId: "terminal",
      deleteHistory: false,
    });
    expect(runtimeRegistry.disposeTerminal).toHaveBeenCalledWith("thread", "terminal");
  });

  it("does not write exit or dispose when acknowledged preserving close is unavailable", async () => {
    const write = vi.fn().mockResolvedValue(undefined);

    await expect(
      stopTerminalSessionPreservingHistory({
        api: apiWithTerminal({ write }),
        threadId: "thread",
        terminalId: "terminal",
      }),
    ).rejects.toThrow("Acknowledged terminal close is unavailable");
    expect(write).not.toHaveBeenCalled();
    expect(runtimeRegistry.disposeTerminal).not.toHaveBeenCalled();
  });

  it("restarts with the retained cwd and reports success only after the API resolves", async () => {
    const restart = vi.fn().mockResolvedValue({});
    await expect(
      restartTerminalSession({
        api: apiWithTerminal({ restart }),
        threadId: "thread",
        terminalId: "terminal",
        cwd: "C:/workspace",
      }),
    ).resolves.toBe(true);
    expect(restart).toHaveBeenCalledWith({
      threadId: "thread",
      terminalId: "terminal",
      cwd: "C:/workspace",
      cols: 80,
      rows: 24,
    });
  });

  it("does not attach a runtime for a persisted stopped or failed terminal", () => {
    expect(
      shouldAttachTerminalRuntime({
        runtimeCwdReady: true,
        exitState: { kind: "stopped", exitCode: null, exitSignal: null },
      }),
    ).toBe(false);
    expect(
      shouldAttachTerminalRuntime({
        runtimeCwdReady: true,
        exitState: { kind: "failed", exitCode: 1, exitSignal: null },
      }),
    ).toBe(false);
    expect(shouldAttachTerminalRuntime({ runtimeCwdReady: true, exitState: undefined })).toBe(true);
  });

  it("maps unavailable cold recovery snapshots to durable exit markers", () => {
    expect(
      terminalExitStateFromRecovery({ status: "exited", exitCode: 0, exitSignal: null }),
    ).toEqual({ kind: "stopped", exitCode: 0, exitSignal: null });
    expect(
      terminalExitStateFromRecovery({ status: "error", exitCode: null, exitSignal: null }),
    ).toEqual({ kind: "failed", exitCode: null, exitSignal: null });
    expect(
      terminalExitStateFromRecovery({ status: "running", exitCode: null, exitSignal: null }),
    ).toBeNull();
    expect(
      terminalExitStateFromRecovery({ status: "starting", exitCode: null, exitSignal: null }),
    ).toBeNull();
    expect(
      terminalExitStateFromRecovery({ status: "exited", exitCode: null, exitSignal: 9 }),
    ).toEqual({ kind: "failed", exitCode: null, exitSignal: "9" });
  });

  it("maps signal-only live exits to failed", () => {
    expect(terminalExitStateFromProcessExit({ exitCode: null, exitSignal: 15 })).toEqual({
      kind: "failed",
      exitCode: null,
      exitSignal: "15",
    });
    expect(terminalExitStateFromProcessExit({ exitCode: 0, exitSignal: 0 })).toEqual({
      kind: "stopped",
      exitCode: 0,
      exitSignal: "0",
    });
  });

  it("closes a terminal group with one acknowledged atomic batch", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    await closeTerminalSessionsStrict({
      api: apiWithTerminal({ close }),
      threadId: "thread",
      terminalIds: ["one", "two"],
    });
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({
      threadId: "thread",
      terminalIds: ["one", "two"],
      deleteHistory: true,
    });
  });
});
