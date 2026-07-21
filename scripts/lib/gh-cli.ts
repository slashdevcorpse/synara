// FILE: gh-cli.ts
// Purpose: Executes GitHub CLI reads with explicit launch and HTTP failure diagnostics.
// Layer: GitHub release boundary

import { spawnSync } from "node:child_process";

export interface GhSpawnResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type GhSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly encoding: "utf8"; readonly shell: false },
) => GhSpawnResult;

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

  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function runGh(
  args: ReadonlyArray<string>,
  options: { readonly allowNotFound?: boolean } = {},
  spawn: GhSpawn = defaultSpawn,
): string {
  const result = spawn("gh", args, { encoding: "utf8", shell: false });
  if (result.error) {
    throw new GhCliStartError(`gh could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    if (options.allowNotFound && /HTTP\s+404\b/i.test(output)) return "";
    throw new GhCliRequestError(
      `gh ${args.join(" ")} failed: ${output.trim()}`,
      isRetryableGhFailure(result.stderr) || isRetryableGhFailure(result.stdout),
    );
  }
  return result.stdout;
}
