#!/usr/bin/env node
// FILE: verify-super-synara-github-state.ts
// Purpose: Reads GitHub tag/release state and validates fail-closed publication transitions.
// Layer: Release publication admission

import {
  type GitHubReleaseState,
  SuperSynaraGitHubStateVisibilityError,
  type SuperSynaraReleasePhase,
  validateSuperSynaraGitHubPolicy,
  validateSuperSynaraGitHubState,
} from "./lib/super-synara-release-state.ts";
import { GH_CLI_BULK_TIMEOUT_MS, GhCliRequestError, runGh } from "./lib/gh-cli.ts";
import {
  parseSuperSynaraReleasePages,
  parseSuperSynaraTagObject,
} from "./lib/super-synara-github-payload.ts";

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
if (
  !["preflight", "before-draft", "after-draft", "before-publish", "after-publish"].includes(phase)
) {
  throw new Error(`Unsupported GitHub state phase: ${phase}.`);
}
const repository = required("--repository");
const tag = required("--tag");
const encodedTag = encodeURIComponent(tag);
const currentRunDraftId = Number(required("--current-run-draft-id"));
const refName = required("--ref-name");
const actor = required("--actor");
const triggeringActor = required("--triggering-actor");
const owner = required("--owner");
const sourceCommit = required("--source-commit");
const visibilityAttempts = 30;
let lastTransientError: Error | undefined;

validateSuperSynaraGitHubPolicy({
  repository,
  refName,
  actor,
  triggeringActor,
  owner,
  tag,
  sourceCommit,
  currentRunDraftId,
});

for (let attempt = 1; attempt <= visibilityAttempts; attempt += 1) {
  let tagObject: { readonly sha: string; readonly type: string } | undefined;
  let releases: ReadonlyArray<GitHubReleaseState>;
  try {
    const refJson = runGh(["api", `repos/${repository}/git/ref/tags/${encodedTag}`], {
      allowNotFound: true,
    });
    tagObject = refJson ? parseSuperSynaraTagObject(JSON.parse(refJson)) : undefined;
    const releasePages = JSON.parse(
      runGh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`], {
        timeoutMs: GH_CLI_BULK_TIMEOUT_MS,
      }),
    );
    releases = parseSuperSynaraReleasePages(releasePages);
  } catch (error) {
    if (!(error instanceof GhCliRequestError) || !error.retryable) throw error;
    lastTransientError = error;
    if (attempt === visibilityAttempts) break;
    console.error(
      `Transient GitHub read failed for ${phase} (attempt ${attempt}/${visibilityAttempts}); retrying: ${error.message}`,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    continue;
  }

  try {
    validateSuperSynaraGitHubState({
      phase,
      repository,
      refName,
      actor,
      triggeringActor,
      owner,
      tag,
      sourceCommit,
      tagCommit: tagObject?.sha ?? null,
      tagObjectType: tagObject?.type ?? null,
      releases,
      currentRunDraftId,
    });
    console.log(`GitHub release state admitted for ${phase}.`);
    process.exit(0);
  } catch (error) {
    if (!(error instanceof SuperSynaraGitHubStateVisibilityError)) throw error;
    lastTransientError = error;
    if (attempt === visibilityAttempts) break;
    console.error(
      `GitHub release state not yet visible for ${phase} (attempt ${attempt}/${visibilityAttempts}); retrying: ${error.message}`,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
}

throw lastTransientError ?? new Error("GitHub release state verification exhausted unexpectedly.");
