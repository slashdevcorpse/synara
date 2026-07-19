#!/usr/bin/env node
// FILE: verify-super-synara-github-state.ts
// Purpose: Reads GitHub tag/release state and validates fail-closed publication transitions.
// Layer: Release publication admission

import { spawnSync } from "node:child_process";

import {
  type GitHubReleaseState,
  type SuperSynaraReleasePhase,
  validateSuperSynaraGitHubState,
} from "./lib/super-synara-release-state.ts";

function runGh(args: ReadonlyArray<string>, allowNotFound = false): string {
  const result = spawnSync("gh", [...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    const output = `${result.stderr || ""}${result.stdout || ""}`;
    if (allowNotFound && /HTTP 404|Not Found/i.test(output)) return "";
    throw new Error(`gh ${args.join(" ")} failed: ${output.trim()}`);
  }
  return result.stdout;
}

function parseArgs(argv: ReadonlyArray<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid GitHub state argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  const known = new Set([
    "--phase",
    "--repository",
    "--ref-name",
    "--actor",
    "--triggering-actor",
    "--owner",
    "--tag",
    "--source-commit",
    "--current-run-draft-id",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown GitHub state argument: ${name}.`);
  }
  return values;
}

const values = parseArgs(process.argv.slice(2));
const required = (name: string): string => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing GitHub state argument: ${name}.`);
  return value;
};
const phase = required("--phase") as SuperSynaraReleasePhase;
if (!["preflight", "reserve-tag", "before-draft", "after-draft", "before-publish"].includes(phase)) {
  throw new Error(`Unsupported GitHub state phase: ${phase}.`);
}
const repository = required("--repository");
const tag = required("--tag");
const encodedTag = encodeURIComponent(tag);
const refJson = runGh(
  ["api", `repos/${repository}/git/ref/tags/${encodedTag}`],
  true,
);
const refObject = refJson
  ? (JSON.parse(refJson) as { object?: { sha?: string; type?: string } }).object
  : undefined;
const tagCommit = refObject?.sha ?? null;
const tagObjectType = refObject?.type ?? null;
const releasePages = JSON.parse(
  runGh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
) as ReadonlyArray<ReadonlyArray<{
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
}>>;
const releases: ReadonlyArray<GitHubReleaseState> = releasePages.flat().map((release) => ({
  id: release.id,
  tagName: release.tag_name,
  targetCommitish: release.target_commitish,
  draft: release.draft,
  prerelease: release.prerelease,
}));
const draftIdInput = values.get("--current-run-draft-id");
validateSuperSynaraGitHubState({
  phase,
  repository,
  refName: required("--ref-name"),
  actor: required("--actor"),
  triggeringActor: required("--triggering-actor"),
  owner: required("--owner"),
  tag,
  sourceCommit: required("--source-commit"),
  tagCommit,
  tagObjectType,
  releases,
  ...(draftIdInput ? { currentRunDraftId: Number(draftIdInput) } : {}),
});
console.log(`GitHub release state admitted for ${phase}.`);
