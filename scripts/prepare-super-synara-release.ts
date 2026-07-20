#!/usr/bin/env node
// FILE: prepare-super-synara-release.ts
// Purpose: Creates or revalidates the exact unsigned prerelease staging set.
// Layer: Release publication admission

import { readFileSync } from "node:fs";

import {
  prepareSuperSynaraRelease,
  type SuperSynaraReleaseScope,
  verifyPreparedSuperSynaraRelease,
} from "./lib/super-synara-release-admission.ts";
import {
  type MacSignatureAllowlist,
  validateMacSignatureAllowlist,
} from "./lib/super-synara-macos-signatures.ts";

export function parseArgs(argv: ReadonlyArray<string>): {
  readonly mode: "prepare" | "verify";
  readonly directory: string;
  readonly licensePath?: string;
  readonly releaseScope: SuperSynaraReleaseScope;
  readonly macSignatureAllowlistPath?: string;
  readonly version: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly absorbedUpstreamSha: string;
  readonly maxTotalBytes: number;
} {
  const mode = argv[0];
  if (mode !== "prepare" && mode !== "verify") {
    throw new Error("First argument must be prepare or verify.");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid release admission argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  const known = new Set([
    "--directory",
    "--license",
    "--release-scope",
    "--mac-signature-allowlist",
    "--version",
    "--tag",
    "--source-commit",
    "--absorbed-upstream-sha",
    "--max-total-bytes",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown release admission argument: ${name}.`);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing release admission argument: ${name}.`);
    return value;
  };
  const maxTotalBytes = Number(required("--max-total-bytes"));
  const licensePath = values.get("--license");
  const releaseScopeValue = required("--release-scope");
  if (releaseScopeValue !== "windows-only" && releaseScopeValue !== "windows-and-macos") {
    throw new Error(
      `Release admission --release-scope must be windows-only or windows-and-macos, got ${releaseScopeValue}.`,
    );
  }
  const releaseScope: SuperSynaraReleaseScope = releaseScopeValue;
  const hasMacSignatureAllowlistArgument = values.has("--mac-signature-allowlist");
  const macSignatureAllowlistPath = values.get("--mac-signature-allowlist");
  if (mode === "prepare" && !licensePath) {
    throw new Error("Prepare mode requires --license.");
  }
  if (releaseScope === "windows-and-macos" && !macSignatureAllowlistPath) {
    throw new Error(
      "Combined release admission requires --mac-signature-allowlist with a committed reviewed policy.",
    );
  }
  if (releaseScope === "windows-only" && hasMacSignatureAllowlistArgument) {
    throw new Error("Windows-only release admission does not accept --mac-signature-allowlist.");
  }
  return {
    mode,
    directory: required("--directory"),
    ...(licensePath ? { licensePath } : {}),
    releaseScope,
    ...(macSignatureAllowlistPath ? { macSignatureAllowlistPath } : {}),
    version: required("--version"),
    tag: required("--tag"),
    sourceCommit: required("--source-commit"),
    absorbedUpstreamSha: required("--absorbed-upstream-sha"),
    maxTotalBytes,
  };
}

export function main(argv: ReadonlyArray<string>): void {
  const options = parseArgs(argv);
  const macSignatureAllowlist = options.macSignatureAllowlistPath
    ? validateMacSignatureAllowlist(
        JSON.parse(
          readFileSync(options.macSignatureAllowlistPath, "utf8"),
        ) as MacSignatureAllowlist,
      )
    : undefined;
  const coordinates = {
    version: options.version,
    tag: options.tag,
    sourceCommit: options.sourceCommit,
    absorbedUpstreamSha: options.absorbedUpstreamSha,
  };
  const releaseInput = {
    directory: options.directory,
    releaseScope: options.releaseScope,
    ...(macSignatureAllowlist ? { macSignatureAllowlist } : {}),
    coordinates,
    maxTotalBytes: options.maxTotalBytes,
  };
  const index =
    options.mode === "prepare"
      ? prepareSuperSynaraRelease({
          ...releaseInput,
          licensePath: options.licensePath!,
        })
      : verifyPreparedSuperSynaraRelease(releaseInput);
  console.log(JSON.stringify(index, null, 2));
}

if (import.meta.main) main(process.argv.slice(2));
