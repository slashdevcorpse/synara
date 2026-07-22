const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_FORCE_EXIT_MS = 1_500;
const DEFAULT_POLL_MS = 25;

export type PosixProcessGroupSignal = NodeJS.Signals | 0;
export type PosixProcessGroupPresence = "present" | "empty";

export interface PosixProcessGroupTeardownOptions {
  readonly displayName: string;
  readonly termGraceMs?: number;
  readonly forceExitMs?: number;
  readonly pollMs?: number;
  readonly signalProcessGroup?: (
    processGroupId: number,
    signal: PosixProcessGroupSignal,
  ) => PosixProcessGroupPresence;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly now?: () => number;
}

function signalProcessGroup(
  processGroupId: number,
  signal: PosixProcessGroupSignal,
): PosixProcessGroupPresence {
  try {
    process.kill(-processGroupId, signal);
    return "present";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return "empty";
    throw cause;
  }
}

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
  pollMs: number,
  signal: NonNullable<PosixProcessGroupTeardownOptions["signalProcessGroup"]>,
  wait: NonNullable<PosixProcessGroupTeardownOptions["sleep"]>,
  now: NonNullable<PosixProcessGroupTeardownOptions["now"]>,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (signal(processGroupId, 0) === "present") {
    if (now() >= deadline) return false;
    await wait(pollMs);
  }
  return true;
}

export async function teardownPosixProcessGroup(
  processGroupId: number,
  options: PosixProcessGroupTeardownOptions,
): Promise<void> {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    throw new TypeError(
      `${options.displayName} POSIX process-group id must be a positive integer, got ${String(processGroupId)}.`,
    );
  }

  const signal = options.signalProcessGroup ?? signalProcessGroup;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const forceExitMs = options.forceExitMs ?? DEFAULT_FORCE_EXIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  if (signal(processGroupId, "SIGTERM") === "empty") return;
  if (await waitForProcessGroupExit(processGroupId, termGraceMs, pollMs, signal, wait, now)) {
    return;
  }
  if (signal(processGroupId, "SIGKILL") === "empty") return;
  if (await waitForProcessGroupExit(processGroupId, forceExitMs, pollMs, signal, wait, now)) {
    return;
  }
  throw new Error(
    `${options.displayName} POSIX process group ${String(processGroupId)} did not prove exit.`,
  );
}
