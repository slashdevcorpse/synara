#!/usr/bin/env node
// FILE: plan-super-synara-release-drafter.ts
// Purpose: Resolves the exact owned draft/tag coordinates for Release Drafter.
// Layer: Release scheduling entrypoint

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGh } from "./lib/gh-cli.ts";
import { serializeReleaseGithubOutput } from "./lib/release-github-output.ts";
import {
  assertSuperSynaraCoreVersion,
  resolveSuperSynaraDraftPlan,
} from "./lib/super-synara-release-drafter.ts";
import {
  parseSuperSynaraMatchingTagRefs,
  parseSuperSynaraReleasePages,
} from "./lib/super-synara-github-payload.ts";
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
assertSuperSynaraCoreVersion(coreVersion);
for (const manifest of packageVersions) {
  if (manifest.version !== coreVersion) {
    throw new Error(
      `${manifest.path} version ${manifest.version} does not match release core ${coreVersion}.`,
    );
  }
}

const tags = parseSuperSynaraMatchingTagRefs(
  JSON.parse(
    runGh(["api", `repos/${repository}/git/matching-refs/tags/super-v${coreVersion}-super.`]),
  ) as unknown,
);
const releases = parseSuperSynaraReleasePages(
  JSON.parse(
    runGh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
  ) as unknown,
);
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
