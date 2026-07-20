export interface PosixBackendShutdownProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): this;
  off(event: "exit", listener: () => void): this;
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
}

export type PosixBackendShutdownDisposition =
  | { readonly type: "already-exited"; readonly exitConfirmed: true; readonly forced: false }
  | { readonly type: "exited"; readonly exitConfirmed: true; readonly forced: boolean }
  | { readonly type: "timed-out"; readonly exitConfirmed: false; readonly forced: boolean }
  | { readonly type: "failed"; readonly exitConfirmed: false; readonly forced: boolean };

interface PosixBackendShutdownInput {
  readonly child: PosixBackendShutdownProcess;
  readonly forceKillDelayMs: number;
  readonly timeoutMs: number;
}

const activeShutdowns = new WeakMap<
  PosixBackendShutdownProcess,
  Promise<PosixBackendShutdownDisposition>
>();

function hasBackendProcessExited(child: PosixBackendShutdownProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function runPosixBackendShutdown(
  input: PosixBackendShutdownInput,
): Promise<PosixBackendShutdownDisposition> {
  if (hasBackendProcessExited(input.child)) {
    return { type: "already-exited", exitConfirmed: true, forced: false };
  }

  return await new Promise<PosixBackendShutdownDisposition>((resolve) => {
    let settled = false;
    let forced = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (disposition: PosixBackendShutdownDisposition): void => {
      if (settled) return;
      settled = true;
      input.child.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve(disposition);
    };

    const onExit = (): void => {
      settle({ type: "exited", exitConfirmed: true, forced });
    };

    input.child.once("exit", onExit);
    try {
      input.child.kill("SIGTERM");
    } catch {
      if (hasBackendProcessExited(input.child)) {
        onExit();
      } else {
        settle({ type: "failed", exitConfirmed: false, forced });
      }
      return;
    }

    if (hasBackendProcessExited(input.child)) {
      onExit();
      return;
    }

    const forceIfRunning = (): void => {
      if (settled || hasBackendProcessExited(input.child)) {
        if (hasBackendProcessExited(input.child)) {
          onExit();
        }
        return;
      }
      forced = true;
      try {
        input.child.kill("SIGKILL");
      } catch {
        // The absolute deadline remains authoritative when force delivery fails.
      }
      if (hasBackendProcessExited(input.child)) {
        onExit();
      }
    };

    if (input.forceKillDelayMs === 0) {
      forceIfRunning();
    } else {
      forceKillTimer = setTimeout(forceIfRunning, input.forceKillDelayMs);
      forceKillTimer.unref();
    }

    if (settled) return;

    exitTimeoutTimer = setTimeout(() => {
      if (hasBackendProcessExited(input.child)) {
        onExit();
        return;
      }
      settle({ type: "timed-out", exitConfirmed: false, forced });
    }, input.timeoutMs);
    exitTimeoutTimer.unref();
  });
}

export function stopPosixBackendAndWait(
  input: PosixBackendShutdownInput,
): Promise<PosixBackendShutdownDisposition> {
  const activeShutdown = activeShutdowns.get(input.child);
  if (activeShutdown) {
    return activeShutdown;
  }

  const shutdown = runPosixBackendShutdown(input);
  activeShutdowns.set(input.child, shutdown);
  const clearShutdown = (): void => {
    if (activeShutdowns.get(input.child) === shutdown) {
      activeShutdowns.delete(input.child);
    }
  };
  void shutdown.then(clearShutdown, clearShutdown);
  return shutdown;
}
