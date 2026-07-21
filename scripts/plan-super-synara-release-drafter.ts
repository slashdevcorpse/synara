#!/usr/bin/env node
// FILE: plan-super-synara-release-drafter.ts
// Purpose: Resolves the exact owned draft/tag coordinates for Release Drafter.
// Layer: Release scheduling entrypoint

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeReleaseGithubOutput } from "./lib/release-github-output.ts";
import {
  resolveSuperSynaraDraftPlan,
  type SuperSynaraDraftRelease,
  type SuperSynaraTagRef,
} from "./lib/super-synara-release-drafter.ts";
import { releasePackageFiles } from "./update-release-package-versions.ts";

function parseArgs(argv: ReadonlyArray<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid Release Drafter planner argument near ${name ?? "<end>"}.`);
    }
    values.set(name, value);
  }
  for (const name of values.keys()) {
    if (!["--repository", "--source-commit", "--github-output"].includes(name)) {
      throw new Error(`Unknown Release Drafter planner argument: ${name}.`);
    }
  }
  return values;
}

function runGh(args: ReadonlyArray<string>): string {
  const result = spawnSync("gh", [...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

const values = parseArgs(process.argv.slice(2));
const required = (name: string): string => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing Release Drafter planner argument: ${name}.`);
  return value;
};
const repository = required("--repository");
const sourceCommit = required("--source-commit");
const githubOutput = required("--github-output");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersions = releasePackageFiles.map((relativePath) => {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as {
    version?: string;
  };
  if (!manifest.version) throw new Error(`${relativePath} is missing its release version.`);
  return { path: relativePath, version: manifest.version };
});
const coreVersion = packageVersions[0]!.version;
for (const manifest of packageVersions) {
  if (manifest.version !== coreVersion) {
    throw new Error(
      `${manifest.path} version ${manifest.version} does not match release core ${coreVersion}.`,
    );
  }
}

const tagPayload = JSON.parse(
  runGh([
    "api",
    `repos/${repository}/git/matching-refs/tags/super-v${coreVersion}-super.`,
  ]),
) as ReadonlyArray<{ ref: string; object: { sha: string; type: string } }>;
const tags: ReadonlyArray<SuperSynaraTagRef> = tagPayload.map((tag) => {
  if (tag.object.type !== "commit") {
    throw new Error(`Super Synara tag ${tag.ref} must point directly to a commit.`);
  }
  return { name: tag.ref.replace(/^refs\/tags\//, ""), commit: tag.object.sha };
});
const releasePages = JSON.parse(
  runGh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
) as ReadonlyArray<
  ReadonlyArray<{
    id: number;
    tag_name: string;
    target_commitish: string;
    name: string | null;
    body: string | null;
    draft: boolean;
    prerelease: boolean;
  }>
>;
const releases: ReadonlyArray<SuperSynaraDraftRelease> = releasePages.flat().map((release) => ({
  id: release.id,
  tagName: release.tag_name,
  targetCommitish: release.target_commitish,
  name: release.name ?? "",
  body: release.body ?? "",
  draft: release.draft,
  prerelease: release.prerelease,
}));
const plan = resolveSuperSynaraDraftPlan({ coreVersion, sourceCommit, tags, releases });
appendFileSync(
  githubOutput,
  serializeReleaseGithubOutput({
    version: plan.version,
    tag: plan.tag,
    existing_draft_id: plan.existingDraftId?.toString() ?? "",
    latest_tag: plan.latestTag,
    latest_tag_commit: plan.latestTagCommit,
  }),
);
console.log(`Resolved ${plan.tag} from ${plan.latestTag} at ${sourceCommit}.`);
