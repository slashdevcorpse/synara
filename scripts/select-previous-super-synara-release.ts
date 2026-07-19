#!/usr/bin/env node
// FILE: select-previous-super-synara-release.ts
// Purpose: Exposes fail-closed previous-prerelease selection to the Windows release lane.

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectPreviousSuperSynaraRelease } from "./lib/super-synara-previous-release.ts";

interface Options {
  readonly releasesJson: string;
  readonly currentVersion: string;
  readonly githubOutput: string;
}

export function parsePreviousReleaseSelectionArgs(argv: ReadonlyArray<string>): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid previous-release argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  for (const name of values.keys()) {
    if (!["--releases-json", "--current-version", "--github-output"].includes(name)) {
      throw new Error(`Unknown previous-release argument: ${name}.`);
    }
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing previous-release argument: ${name}.`);
    return value;
  };
  return {
    releasesJson: resolve(required("--releases-json")),
    currentVersion: required("--current-version"),
    githubOutput: resolve(required("--github-output")),
  };
}

export function writePreviousReleaseSelection(options: Options): void {
  const raw = readFileSync(options.releasesJson, "utf8").replace(/^\uFEFF/, "");
  const selected = selectPreviousSuperSynaraRelease(JSON.parse(raw), options.currentVersion);
  const lines = selected
    ? [
        "found=true",
        `previous_version=${selected.version}`,
        `previous_tag=${selected.tag}`,
        `previous_asset_name=${selected.assetName}`,
      ]
    : ["found=false", "previous_version=", "previous_tag=", "previous_asset_name="];
  appendFileSync(options.githubOutput, `${lines.join("\n")}\n`, "utf8");
  console.log(
    selected
      ? `Selected previous Super Synara prerelease ${selected.tag}.`
      : "No older published Super Synara prerelease with the exact Windows asset exists; upgrade qualification will report not-run-no-previous-release.",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  writePreviousReleaseSelection(parsePreviousReleaseSelectionArgs(process.argv.slice(2)));
}
