// FILE: terminalSession.ts
// Purpose: Shared terminal-session primitives reused by every terminal surface
//          (chat drawer, workspace page, right-dock pane): a stable id factory and
//          the dispose + server-close + fallback routine that was duplicated verbatim.
// Layer: Web terminal runtime helpers
// Depends on: terminalRuntimeRegistry (xterm instances), NativeApi terminal channel.

import { type NativeApi } from "@synara/contracts";

import { randomUUID } from "~/lib/utils";
import { terminalRuntimeRegistry } from "./terminalRuntimeRegistry";
import type { TerminalRecoveryResolution } from "./terminalRuntimeTypes";
import type { TerminalExitState } from "../../types";

// Stable, collision-resistant id for a new terminal pane/tab/split.
export function randomTerminalId(): string {
  return `terminal-${randomUUID()}`;
}

// Tear down a terminal everywhere it lives: drop the local xterm instance, then
// ask the server to close it (deleting history) with a best-effort `exit` write
// fallback for transports that lack a structured close. `clearHistoryBeforeClose`
// mirrors the chat surface's behavior when closing the final terminal of a thread.
export function disposeAndCloseTerminalSession(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalId: string;
  clearHistoryBeforeClose?: boolean;
}): void {
  const { api, threadId, terminalId } = input;
  terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);

  const fallbackExitWrite = () =>
    api?.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);

  if (api && "close" in api.terminal && typeof api.terminal.close === "function") {
    void (async () => {
      if (input.clearHistoryBeforeClose) {
        await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
      }
      await api.terminal.close({ threadId, terminalId, deleteHistory: true });
    })().catch(() => fallbackExitWrite());
  } else {
    void fallbackExitWrite();
  }
}

export function shouldAttachTerminalRuntime(input: {
  runtimeCwdReady: boolean;
  exitState: TerminalExitState | undefined;
}): boolean {
  return input.runtimeCwdReady && input.exitState === undefined;
}

export function terminalExitStateFromRecovery(
  input: TerminalRecoveryResolution,
): TerminalExitState | null {
  if (input.status === "running" || input.status === "starting") return null;
  const exitState = terminalExitStateFromProcessExit(input);
  return {
    ...exitState,
    kind: input.status === "error" ? "failed" : exitState.kind,
  };
}

export function terminalExitStateFromProcessExit(input: {
  exitCode: number | null;
  exitSignal: number | null;
}): TerminalExitState {
  return {
    kind:
      (input.exitCode !== null && input.exitCode !== 0) ||
      (input.exitSignal !== null && input.exitSignal !== 0)
        ? "failed"
        : "stopped",
    exitCode: input.exitCode,
    exitSignal: input.exitSignal === null ? null : String(input.exitSignal),
  };
}

// One acknowledged server request closes a complete group. The server preflights
// every session before mutating any of them, preventing partial destructive closes.
export async function closeTerminalSessionsStrict(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalIds: readonly string[];
}): Promise<void> {
  const { api, threadId, terminalIds } = input;
  if (!api || !("close" in api.terminal) || typeof api.terminal.close !== "function") {
    throw new Error("Strict terminal close is unavailable");
  }
  if (terminalIds.length === 0) {
    throw new Error("Cannot close an empty terminal group");
  }
  await api.terminal.close({
    threadId,
    terminalIds: [...terminalIds],
    deleteHistory: true,
  });
}

// Stop the backing PTY without deleting its durable terminal identity/history.
// Archived groups can therefore restore the same terminal and restart it explicitly.
export async function stopTerminalSessionPreservingHistory(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalId: string;
}): Promise<void> {
  const { api, threadId, terminalId } = input;
  if (!api || !("close" in api.terminal) || typeof api.terminal.close !== "function") {
    throw new Error("Acknowledged terminal close is unavailable");
  }
  await api.terminal.close({ threadId, terminalId, deleteHistory: false });
  terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
}

export async function restartTerminalSession(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalId: string;
  cwd: string;
  env?: Record<string, string> | undefined;
}): Promise<boolean> {
  const { api, threadId, terminalId, cwd, env } = input;
  if (!api || !("restart" in api.terminal) || typeof api.terminal.restart !== "function") {
    return false;
  }
  await api.terminal.restart({
    threadId,
    terminalId,
    cwd,
    cols: 80,
    rows: 24,
    ...(env ? { env } : {}),
  });
  return true;
}
