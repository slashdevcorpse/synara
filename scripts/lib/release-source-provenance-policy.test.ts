import { describe, expect, it } from "vitest";

import { validateReleaseSourcePolicy } from "./release-source-provenance-policy.ts";

const packageVersions = [
  { path: "apps/desktop/package.json", version: "0.5.5" },
  { path: "apps/server/package.json", version: "0.5.5" },
];

describe("release source provenance policy", () => {
  it("accepts core package versions for a protected-main Super Synara dispatch", () => {
    expect(
      validateReleaseSourcePolicy({
        distributionKind: "github-unsigned-prerelease",
        version: "0.5.5-super.3",
        tag: "super-v0.5.5-super.3",
        publishRelease: true,
        refType: "branch",
        refName: "main",
        packageVersions,
      }),
    ).toEqual({
      coreVersion: "0.5.5",
      expectedTag: "super-v0.5.5-super.3",
      expectedRefType: "branch",
      expectedRefName: "main",
    });
  });

  it("rejects malformed downstream versions, wrong refs, and mismatched package cores", () => {
    expect(() =>
      validateReleaseSourcePolicy({
        distributionKind: "github-unsigned-prerelease",
        version: "0.5.5-super.0",
        tag: "super-v0.5.5-super.0",
        publishRelease: true,
        refType: "branch",
        refName: "main",
        packageVersions,
      }),
    ).toThrow("positive integer");
    expect(() =>
      validateReleaseSourcePolicy({
        distributionKind: "github-unsigned-prerelease",
        version: "0.5.5-super.1",
        tag: "super-v0.5.5-super.1",
        publishRelease: true,
        refType: "tag",
        refName: "super-v0.5.5-super.1",
        packageVersions,
      }),
    ).toThrow("protected main");
    expect(() =>
      validateReleaseSourcePolicy({
        distributionKind: "github-unsigned-prerelease",
        version: "0.5.5-super.1",
        tag: "super-v0.5.5-super.1",
        publishRelease: true,
        refType: "branch",
        refName: "main",
        packageVersions: [{ path: "apps/desktop/package.json", version: "0.5.6" }],
      }),
    ).toThrow("required core 0.5.5");
  });

  it("preserves strict signed-release tag and package rules", () => {
    expect(() =>
      validateReleaseSourcePolicy({
        distributionKind: "signed-release",
        version: "0.5.5",
        tag: "v0.5.5",
        publishRelease: true,
        refType: "branch",
        refName: "main",
        packageVersions,
      }),
    ).toThrow("exact release tag");
    expect(
      validateReleaseSourcePolicy({
        distributionKind: "signed-release",
        version: "0.5.5",
        tag: "v0.5.5",
        publishRelease: true,
        refType: "tag",
        refName: "v0.5.5",
        packageVersions,
      }).coreVersion,
    ).toBe("0.5.5");
  });
});
