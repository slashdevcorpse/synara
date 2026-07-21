// FILE: super-synara-release-state.ts
// Purpose: Validates owner, tag, draft, rerun, and publication state transitions.
// Layer: Release publication admission

import { assertFullCommitSha } from "./git-sha.ts";
import { hasExactSuperSynaraReleaseIdentity } from "./super-synara-release-identity.ts";

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

export type SuperSynaraGitHubPolicyInput = Pick<
  SuperSynaraGitHubStateInput,
  | "repository"
  | "refName"
  | "actor"
  | "triggeringActor"
  | "owner"
  | "tag"
  | "sourceCommit"
  | "currentRunDraftId"
>;

export class SuperSynaraGitHubStateVisibilityError extends Error {
  override readonly name = "SuperSynaraGitHubStateVisibilityError";
}

export function validateSuperSynaraGitHubPolicy(input: SuperSynaraGitHubPolicyInput): void {
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
  assertFullCommitSha("Source commit", input.sourceCommit);
  if (!Number.isSafeInteger(input.currentRunDraftId) || input.currentRunDraftId! <= 0) {
    throw new Error("Publication requires the exact current-run GitHub draft release ID.");
  }
}

export function validateSuperSynaraGitHubState(input: SuperSynaraGitHubStateInput): void {
  validateSuperSynaraGitHubPolicy(input);
  if (input.tagCommit !== null) {
    if (input.tagObjectType !== "commit") {
      throw new Error(`Reserved tag ${input.tag} must resolve directly to a commit object.`);
    }
    assertFullCommitSha("Tag commit", input.tagCommit);
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
    throw new SuperSynaraGitHubStateVisibilityError(
      "Published release requires the immutable tag at the exact source commit.",
    );
  }
  if (tagReleases.length === 0) {
    throw new SuperSynaraGitHubStateVisibilityError(
      `Expected the current-run release for ${input.tag}, but it is not visible yet.`,
    );
  }
  if (tagReleases.length > 1) {
    throw new Error(
      `Expected exactly one current-run release for ${input.tag}, found ${tagReleases.length}.`,
    );
  }
  const release = tagReleases[0]!;
  const version = input.tag.replace(/^super-v/, "");
  const expectedDraft = input.phase !== "after-publish";
  if (release.id !== input.currentRunDraftId) {
    throw new Error(
      `Release ${release.id} for ${input.tag} is not current-run draft ${input.currentRunDraftId}.`,
    );
  }
  if (
    release.draft !== expectedDraft ||
    !release.prerelease ||
    release.targetCommitish.toLowerCase() !== input.sourceCommit.toLowerCase() ||
    !hasExactSuperSynaraReleaseIdentity(release, version)
  ) {
    throw new SuperSynaraGitHubStateVisibilityError(
      `Existing release is not the exact owned Release Drafter ${expectedDraft ? "draft " : ""}prerelease for the source commit.`,
    );
  }
}
