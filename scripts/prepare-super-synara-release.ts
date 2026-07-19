#!/usr/bin/env node
// FILE: prepare-super-synara-release.ts
// Purpose: Creates or revalidates the exact unsigned prerelease staging set.
// Layer: Release publication admission

import { readFileSync } from "node:fs";

import {
  prepareSuperSynaraRelease,
  verifyPreparedSuperSynaraRelease,
} from "./lib/super-synara-release-admission.ts";
import {
  type MacSignatureAllowlist,
  validateMacSignatureAllowlist,
} from "./lib/super-synara-macos-signatures.ts";

function parseArgs(argv: ReadonlyArray<string>): {
  readonly mode: "prepare" | "verify";
  readonly directory: string;
  readonly licensePath?: string;
  readonly macSignatureAllowlistPath: string;
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
  if (mode === "prepare" && !licensePath) {
    throw new Error("Prepare mode requires --license.");
  }
  return {
    mode,
    directory: required("--directory"),
    ...(licensePath ? { licensePath } : {}),
    macSignatureAllowlistPath: required("--mac-signature-allowlist"),
    version: required("--version"),
    tag: required("--tag"),
    sourceCommit: required("--source-commit"),
    absorbedUpstreamSha: required("--absorbed-upstream-sha"),
    maxTotalBytes,
  };
}

const options = parseArgs(process.argv.slice(2));
const macSignatureAllowlist = validateMacSignatureAllowlist(
  JSON.parse(readFileSync(options.macSignatureAllowlistPath, "utf8")) as MacSignatureAllowlist,
);
const coordinates = {
  version: options.version,
  tag: options.tag,
  sourceCommit: options.sourceCommit,
  absorbedUpstreamSha: options.absorbedUpstreamSha,
};
const index =
  options.mode === "prepare"
    ? prepareSuperSynaraRelease({
        directory: options.directory,
        licensePath: options.licensePath!,
        macSignatureAllowlist,
        coordinates,
        maxTotalBytes: options.maxTotalBytes,
      })
    : verifyPreparedSuperSynaraRelease({
        directory: options.directory,
        macSignatureAllowlist,
        coordinates,
        maxTotalBytes: options.maxTotalBytes,
      });
console.log(JSON.stringify(index, null, 2));
