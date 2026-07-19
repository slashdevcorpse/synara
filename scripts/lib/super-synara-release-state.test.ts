import { describe, expect, it } from "vitest";

import {
  type SuperSynaraGitHubStateInput,
  validateSuperSynaraGitHubState,
} from "./super-synara-release-state.ts";

function state(
  overrides: Partial<SuperSynaraGitHubStateInput> = {},
): SuperSynaraGitHubStateInput {
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
    releases: [],
    ...overrides,
  };
}

describe("Super Synara GitHub release state", () => {
  it("allows a first attempt and an exact orphan-tag rerun", () => {
    expect(() => validateSuperSynaraGitHubState(state())).not.toThrow();
    expect(() =>
      validateSuperSynaraGitHubState(
        state({ phase: "reserve-tag", tagCommit: "a".repeat(40) }),
      ),
    ).not.toThrow();
  });

  it("rejects non-owner reruns, moved tags, and any pre-existing release", () => {
    expect(() =>
      validateSuperSynaraGitHubState(state({ triggeringActor: "someone-else" })),
    ).toThrow("triggering_actor");
    expect(() =>
      validateSuperSynaraGitHubState(state({ tagCommit: "b".repeat(40) })),
    ).toThrow("points to");
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          releases: [
            {
              id: 1,
              tagName: "super-v0.5.5-super.1",
              targetCommitish: "a".repeat(40),
              draft: true,
              prerelease: true,
            },
          ],
        }),
      ),
    ).toThrow("already has a draft release");
  });

  it("admits only the exact current-run draft before publication", () => {
    const exactDraft = {
      id: 42,
      tagName: "super-v0.5.5-super.1",
      targetCommitish: "a".repeat(40),
      draft: true,
      prerelease: true,
    };
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          phase: "before-publish",
          tagCommit: "a".repeat(40),
          releases: [exactDraft],
          currentRunDraftId: 42,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSuperSynaraGitHubState(
        state({
          phase: "before-publish",
          tagCommit: "a".repeat(40),
          releases: [exactDraft],
          currentRunDraftId: 43,
        }),
      ),
    ).toThrow("not the exact current-run");
  });
});
