import { describe, expect, it } from "vitest";

import {
  type SuperSynaraGitHubStateInput,
  validateSuperSynaraGitHubState,
} from "./super-synara-release-state.ts";
import {
  SUPER_SYNARA_RELEASE_DRAFTER_MARKER,
  superSynaraReleaseTitle,
} from "./super-synara-release-drafter.ts";

function state(overrides: Partial<SuperSynaraGitHubStateInput> = {}): SuperSynaraGitHubStateInput {
  return {
    phase: "preflight",
    repository: "slashdevcorpse/synara",
    refName: "main",
    actor: "slashdevcorpse",
    triggeringActor: "slashdevcorpse",
    owner: "slashdevcorpse",
    tag: "super-v0.5.5-super.1",
    sourceCommit: "a".repeat(40),
    tagCommit: null,
    tagObjectType: null,
    releases: [exactDraft()],
    currentRunDraftId: 42,
    ...overrides,
  };
}

function exactDraft() {
  const version = "0.5.5-super.1";
  return {
    id: 42,
    tagName: `super-v${version}`,
    targetCommitish: "a".repeat(40),
    name: superSynaraReleaseTitle(version),
    body: `${SUPER_SYNARA_RELEASE_DRAFTER_MARKER}\n\nchanges`,
    draft: true,
    prerelease: true,
  };
}

describe("Super Synara GitHub release state", () => {
  it("allows an exact owned draft with no tag or an exact preexisting tag", () => {
    expect(() => validateSuperSynaraGitHubState(state())).not.toThrow();
    expect(() =>
      validateSuperSynaraGitHubState(
        state({ phase: "before-publish", tagCommit: "a".repeat(40), tagObjectType: "commit" }),
      ),
    ).not.toThrow();
  });

  it("allows the exact scheduler identity", () => {
    expect(() =>
      validateSuperSynaraGitHubState(
        state({ actor: "github-actions[bot]", triggeringActor: "github-actions[bot]" }),
      ),
    ).not.toThrow();
  });

  it("rejects unknown reruns, moved tags, and unowned releases", () => {
    expect(() =>
      validateSuperSynaraGitHubState(state({ triggeringActor: "someone-else" })),
    ).toThrow("repository owner or its exact GitHub Actions scheduler");
    expect(() =>
      validateSuperSynaraGitHubState(state({ tagCommit: "b".repeat(40), tagObjectType: "commit" })),
    ).toThrow("points to");
    expect(() =>
      validateSuperSynaraGitHubState(state({ tagCommit: "a".repeat(40), tagObjectType: "tag" })),
    ).toThrow("directly to a commit object");
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          releases: [exactDraft(), { ...exactDraft(), id: 1 }],
        }),
      ),
    ).toThrow("found 2");
    expect(() =>
      validateSuperSynaraGitHubState(
        state({ releases: [{ ...exactDraft(), body: "missing marker" }] }),
      ),
    ).toThrow("exact owned Release Drafter");
  });

  it("admits only the exact current-run draft before publication", () => {
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          phase: "before-publish",
          tagCommit: "a".repeat(40),
          tagObjectType: "commit",
          releases: [exactDraft()],
          currentRunDraftId: 42,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          phase: "before-publish",
          tagCommit: "a".repeat(40),
          tagObjectType: "commit",
          releases: [exactDraft()],
          currentRunDraftId: 43,
        }),
      ),
    ).toThrow("not the exact owned Release Drafter");
  });

  it("requires the exact published prerelease and tag after publication", () => {
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          phase: "after-publish",
          tagCommit: "a".repeat(40),
          tagObjectType: "commit",
          releases: [{ ...exactDraft(), draft: false }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSuperSynaraGitHubState(
        state({ phase: "after-publish", releases: [{ ...exactDraft(), draft: false }] }),
      ),
    ).toThrow("requires the immutable tag");
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          phase: "after-publish",
          tagCommit: "a".repeat(40),
          tagObjectType: "commit",
          releases: [exactDraft()],
        }),
      ),
    ).toThrow("exact owned Release Drafter prerelease");
  });
});
