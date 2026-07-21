// FILE: super-synara-release-state.ts
// Purpose: Validates owner, tag, draft, rerun, and publication state transitions.
// Layer: Release publication admission

import {
  SUPER_SYNARA_RELEASE_DRAFTER_MARKER,
  superSynaraReleaseTitle,
} from "./super-synara-release-drafter.ts";

export type SuperSynaraReleasePhase =
  | "preflight"
  | "before-draft"
  | "after-draft"
  | "before-publish"
  | "after-publish";

export interface GitHubReleaseState {
  readonly id: number;
  readonly tagName: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
}

export interface SuperSynaraGitHubStateInput {
  readonly phase: SuperSynaraReleasePhase;
  readonly repository: string;
  readonly refName: string;
  readonly actor: string;
  readonly triggeringActor: string;
  readonly owner: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly tagCommit: string | null;
  readonly tagObjectType: string | null;
  readonly releases: ReadonlyArray<GitHubReleaseState>;
  readonly currentRunDraftId?: number;
}

function assertFullSha(label: string, value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full 40-character commit SHA.`);
  }
}

export function validateSuperSynaraGitHubState(input: SuperSynaraGitHubStateInput): void {
  if (input.repository !== "slashdevcorpse/synara" || input.refName !== "main") {
    throw new Error(
      "Super Synara publication is restricted to slashdevcorpse/synara protected main.",
    );
  }
  const ownerDispatch = input.actor === input.owner && input.triggeringActor === input.owner;
  const automatedDispatch =
    input.actor === "github-actions[bot]" && input.triggeringActor === "github-actions[bot]";
  if (!ownerDispatch && !automatedDispatch) {
    throw new Error(
      "Super Synara publication must be dispatched by the repository owner or its exact GitHub Actions scheduler.",
    );
  }
  if (!/^super-v\d+\.\d+\.\d+-super\.[1-9]\d*$/.test(input.tag)) {
    throw new Error(`Invalid immutable Super Synara tag: ${input.tag}.`);
  }
  assertFullSha("Source commit", input.sourceCommit);
  if (input.tagCommit !== null) {
    if (input.tagObjectType !== "commit") {
      throw new Error(`Reserved tag ${input.tag} must resolve directly to a commit object.`);
    }
    assertFullSha("Tag commit", input.tagCommit);
    if (input.tagCommit.toLowerCase() !== input.sourceCommit.toLowerCase()) {
      throw new Error(
        `Reserved tag ${input.tag} points to ${input.tagCommit}, not ${input.sourceCommit}.`,
      );
    }
  }
  if (input.tagCommit === null && input.tagObjectType !== null) {
    throw new Error("Missing tag commit cannot have a Git object type.");
  }

  const tagReleases = input.releases.filter((release) => release.tagName === input.tag);
  if (input.phase === "after-publish" && input.tagCommit === null) {
    throw new Error("Published release requires the immutable tag at the exact source commit.");
  }
  if (!Number.isSafeInteger(input.currentRunDraftId) || input.currentRunDraftId! <= 0) {
    throw new Error("Publication requires the exact current-run GitHub draft release ID.");
  }
  if (tagReleases.length !== 1) {
    throw new Error(
      `Expected exactly one current-run draft for ${input.tag}, found ${tagReleases.length}.`,
    );
  }
  const release = tagReleases[0]!;
  const version = input.tag.replace(/^super-v/, "");
  const expectedDraft = input.phase !== "after-publish";
  if (
    release.id !== input.currentRunDraftId ||
    release.draft !== expectedDraft ||
    !release.prerelease ||
    release.targetCommitish.toLowerCase() !== input.sourceCommit.toLowerCase() ||
    release.name !== superSynaraReleaseTitle(version) ||
    !release.body.includes(SUPER_SYNARA_RELEASE_DRAFTER_MARKER)
  ) {
    throw new Error(
      `Existing release is not the exact owned Release Drafter ${expectedDraft ? "draft " : ""}prerelease for the source commit.`,
    );
  }
}
