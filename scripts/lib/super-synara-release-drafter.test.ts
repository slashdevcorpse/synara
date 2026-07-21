import { describe, expect, it } from "vitest";

import {
  SUPER_SYNARA_RELEASE_DRAFTER_MARKER,
  resolveSuperSynaraDraftPlan,
  superSynaraReleaseTitle,
  type SuperSynaraDraftRelease,
} from "./super-synara-release-drafter.ts";

const sourceCommit = "a".repeat(40);

function release(overrides: Partial<SuperSynaraDraftRelease> = {}): SuperSynaraDraftRelease {
  const version = "0.5.5-super.8";
  return {
    id: 80,
    tagName: `super-v${version}`,
    targetCommitish: "b".repeat(40),
    name: superSynaraReleaseTitle(version),
    body: `${SUPER_SYNARA_RELEASE_DRAFTER_MARKER}\n\nchanges`,
    draft: true,
    prerelease: true,
    ...overrides,
  };
}

const tags = [
  { name: "super-v0.5.5-super.6", commit: "6".repeat(40) },
  { name: "super-v0.5.5-super.7", commit: "7".repeat(40) },
];

describe("Super Synara Release Drafter planning", () => {
  it("allocates the next immutable iteration after the latest tag", () => {
    expect(
      resolveSuperSynaraDraftPlan({ coreVersion: "0.5.5", sourceCommit, tags, releases: [] }),
    ).toEqual({
      version: "0.5.5-super.8",
      tag: "super-v0.5.5-super.8",
      existingDraftId: null,
      latestTag: "super-v0.5.5-super.7",
      latestTagCommit: "7".repeat(40),
    });
  });

  it("reuses the one marked draft before its immutable tag is reserved", () => {
    expect(
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit,
        tags,
        releases: [release()],
      }),
    ).toMatchObject({
      version: "0.5.5-super.8",
      tag: "super-v0.5.5-super.8",
      existingDraftId: 80,
    });
  });

  it("rejects any non-atomic draft and immutable-tag state", () => {
    expect(() =>
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit,
        tags: [...tags, { name: "super-v0.5.5-super.8", commit: sourceCommit }],
        releases: [release({ targetCommitish: sourceCommit })],
      }),
    ).toThrow("must create the tag atomically");
    expect(() =>
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit,
        tags: [...tags, { name: "super-v0.5.5-super.8", commit: "c".repeat(40) }],
        releases: [release()],
      }),
    ).toThrow("must create the tag atomically");
  });

  it("rejects unowned, duplicate, and malformed draft state", () => {
    expect(() =>
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit,
        tags,
        releases: [release({ body: "no marker" })],
      }),
    ).toThrow("unowned");
    expect(() =>
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit,
        tags,
        releases: [release(), release({ id: 81, tagName: "super-v0.5.5-super.9" })],
      }),
    ).toThrow("at most one owned");
    expect(() =>
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit,
        tags,
        releases: [release({ name: "Unsigned build" })],
      }),
    ).toThrow("unexpected title");
  });

  it("requires an exact core version, source SHA, and baseline tag", () => {
    expect(() =>
      resolveSuperSynaraDraftPlan({ coreVersion: "v0.5.5", sourceCommit, tags, releases: [] }),
    ).toThrow("core version");
    expect(() =>
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit: "short",
        tags,
        releases: [],
      }),
    ).toThrow("40-character");
    expect(() =>
      resolveSuperSynaraDraftPlan({
        coreVersion: "0.5.5",
        sourceCommit,
        tags: [],
        releases: [],
      }),
    ).toThrow("baseline tag");
  });
});
