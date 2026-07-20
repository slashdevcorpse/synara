export interface WindowsProcessTreeKillResult {
  readonly ok: boolean;
  readonly diagnostic?: string;
}

export function killWindowsProcessTree(
  pid: number,
  options: {
    readonly timeoutMs: number;
    readonly environment?: NodeJS.ProcessEnv;
  },
): Promise<WindowsProcessTreeKillResult>;
