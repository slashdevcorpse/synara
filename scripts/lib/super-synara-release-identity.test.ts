import { describe, expect, it } from "vitest";

import {
  hasExactSuperSynaraReleaseIdentity,
  hasSuperSynaraReleaseOwnership,
  SUPER_SYNARA_RELEASE_DRAFTER_MARKER,
  superSynaraReleaseTitle,
} from "./super-synara-release-identity.ts";

const version = "0.5.5-super.8";
const owned = {
  name: superSynaraReleaseTitle(version),
  body: `${SUPER_SYNARA_RELEASE_DRAFTER_MARKER}\n\nchanges`,
  prerelease: true,
};

describe("Super Synara release identity", () => {
  it("recognizes the canonical marker and exact title", () => {
    expect(hasSuperSynaraReleaseOwnership(owned)).toBe(true);
    expect(hasExactSuperSynaraReleaseIdentity(owned, version)).toBe(true);
  });

  it("rejects stable, unmarked, and wrong-title releases", () => {
    expect(hasSuperSynaraReleaseOwnership({ ...owned, prerelease: false })).toBe(false);
    expect(hasSuperSynaraReleaseOwnership({ ...owned, body: "changes" })).toBe(false);
    expect(hasExactSuperSynaraReleaseIdentity({ ...owned, name: "wrong" }, version)).toBe(false);
  });
});
