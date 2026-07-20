const SHELL_RESNAPSHOT_RETRY_MIN_MS = 50;
const SHELL_RESNAPSHOT_RETRY_MAX_MS = 1_000;

export function shouldCommitShellSnapshot(input: {
  readonly snapshotSequence: number;
  readonly currentSequence: number;
  readonly requiredSequence: number;
}): boolean {
  return (
    input.snapshotSequence >= input.currentSequence &&
    input.snapshotSequence >= input.requiredSequence
  );
}

export function shellResnapshotRetryDelayMs(staleAttempt: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(staleAttempt)), 5);
  return Math.min(SHELL_RESNAPSHOT_RETRY_MIN_MS * 2 ** exponent, SHELL_RESNAPSHOT_RETRY_MAX_MS);
}
