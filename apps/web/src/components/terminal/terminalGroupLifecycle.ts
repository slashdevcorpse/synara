// FILE: terminalGroupLifecycle.ts
// Purpose: Transactional running-terminal stop policy used before group archival.
// Layer: Terminal lifecycle orchestration

export interface StopTerminalGroupForArchiveResult {
  archived: boolean;
  stoppedTerminalIds: string[];
  failedTerminalIds: string[];
}

export async function stopTerminalGroupForArchive(input: {
  terminalIds: readonly string[];
  stopTerminal: (terminalId: string) => Promise<void>;
  markTerminalStopped: (terminalId: string) => void;
  archiveGroup: () => void;
}): Promise<StopTerminalGroupForArchiveResult> {
  const results = await Promise.allSettled(
    input.terminalIds.map((terminalId) => input.stopTerminal(terminalId)),
  );
  const stoppedTerminalIds: string[] = [];
  const failedTerminalIds: string[] = [];
  results.forEach((result, index) => {
    const terminalId = input.terminalIds[index];
    if (!terminalId) return;
    if (result.status === "fulfilled") {
      stoppedTerminalIds.push(terminalId);
      input.markTerminalStopped(terminalId);
    } else {
      failedTerminalIds.push(terminalId);
    }
  });
  if (failedTerminalIds.length > 0) {
    return { archived: false, stoppedTerminalIds, failedTerminalIds };
  }
  input.archiveGroup();
  return { archived: true, stoppedTerminalIds, failedTerminalIds };
}

export interface CloseTerminalGroupResult {
  closed: boolean;
  failedTerminalIds: string[];
}

export async function closeTerminalGroupTransaction(input: {
  terminalIds: readonly string[];
  closeTerminals: (terminalIds: readonly string[]) => Promise<void>;
  disposeTerminal: (terminalId: string) => void;
  removeGroup: () => void;
}): Promise<CloseTerminalGroupResult> {
  if (input.terminalIds.length === 0) {
    input.removeGroup();
    return { closed: true, failedTerminalIds: [] };
  }
  try {
    await input.closeTerminals(input.terminalIds);
  } catch {
    return { closed: false, failedTerminalIds: [...input.terminalIds] };
  }
  for (const terminalId of input.terminalIds) input.disposeTerminal(terminalId);
  input.removeGroup();
  return { closed: true, failedTerminalIds: [] };
}
