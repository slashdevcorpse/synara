// FILE: gh-cli.ts
// Purpose: Executes GitHub CLI reads with explicit launch and HTTP failure diagnostics.
// Layer: GitHub release boundary

import { spawnSync } from "node:child_process";

export interface GhSpawnResult {
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type GhSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly encoding: "utf8"; readonly shell: false; readonly timeout: number },
) => GhSpawnResult;

export const GH_CLI_TIMEOUT_MS = 30_000;
export const GH_CLI_BULK_TIMEOUT_MS = 120_000;

const defaultSpawn: GhSpawn = (command, args, options) =>
  spawnSync(command, [...args], options) as GhSpawnResult;

export class GhCliStartError extends Error {
  override readonly name = "GhCliStartError";
}

const TRANSIENT_NETWORK_FAILURE =
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|connection (?:reset|timed out)|temporary failure|TLS handshake timeout|unexpected EOF|i\/o timeout|context deadline exceeded/i;

function isRetryableGhFailure(output: string): boolean {
  if (output.trim().toUpperCase() === "EOF") return true;
  const httpStatus = /HTTP\s+(\d{3})/i.exec(output)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    if ([408, 425, 429].includes(status) || (status >= 500 && status <= 599)) return true;
    if (status === 403 && /(?:API|secondary) rate limit|abuse detection/i.test(output)) return true;
  }
  return TRANSIENT_NETWORK_FAILURE.test(output);
}

export class GhCliRequestError extends Error {
  override readonly name = "GhCliRequestError";
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export function runGh(
  args: ReadonlyArray<string>,
  options: { readonly allowNotFound?: boolean; readonly timeoutMs?: number } = {},
  spawn: GhSpawn = defaultSpawn,
): string {
  const timeoutMs = options.timeoutMs ?? GH_CLI_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error("GitHub CLI timeout must be a positive safe integer no greater than 300000ms.");
  }
  const result = spawn("gh", args, {
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      throw new GhCliRequestError(
        `gh ${args.join(" ")} timed out after ${timeoutMs}ms: ${result.error.message}`,
        true,
      );
    }
    throw new GhCliStartError(`gh could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    if (options.allowNotFound && /HTTP\s+404\b/i.test(output)) return "";
    const diagnostic =
      output.trim() ||
      (result.signal
        ? `terminated by signal ${result.signal}`
        : `exited with status ${String(result.status)}`);
    throw new GhCliRequestError(
      `gh ${args.join(" ")} failed: ${diagnostic}`,
      isRetryableGhFailure(result.stderr) || isRetryableGhFailure(result.stdout),
    );
  }
  return result.stdout;
}
