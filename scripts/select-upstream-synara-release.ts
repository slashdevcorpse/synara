#!/usr/bin/env node
// FILE: select-upstream-synara-release.ts
// Purpose: Selects the exact stable upstream Synara installer used for side-by-side qualification.

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectPublishedUpstreamSynaraRelease } from "./lib/super-synara-previous-release.ts";

interface Options {
  readonly releasesJson: string;
  readonly currentVersion: string;
  readonly githubOutput: string;
}

export function parseUpstreamReleaseSelectionArgs(argv: ReadonlyArray<string>): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid upstream-release argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  for (const name of values.keys()) {
    if (!["--releases-json", "--current-version", "--github-output"].includes(name)) {
      throw new Error(`Unknown upstream-release argument: ${name}.`);
    }
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`Missing upstream-release argument: ${name}.`);
    return value;
  };
  return {
    releasesJson: resolve(required("--releases-json")),
    currentVersion: required("--current-version"),
    githubOutput: resolve(required("--github-output")),
  };
}

export function writeUpstreamReleaseSelection(options: Options): void {
  const raw = readFileSync(options.releasesJson, "utf8").replace(/^\uFEFF/, "");
  const selected = selectPublishedUpstreamSynaraRelease(JSON.parse(raw), options.currentVersion);
  appendFileSync(
    options.githubOutput,
    [
      `upstream_version=${selected.version}`,
      `upstream_tag=${selected.tag}`,
      `upstream_asset_name=${selected.assetName}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`Selected upstream Synara ${selected.tag} for side-by-side qualification.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  writeUpstreamReleaseSelection(parseUpstreamReleaseSelectionArgs(process.argv.slice(2)));
}
