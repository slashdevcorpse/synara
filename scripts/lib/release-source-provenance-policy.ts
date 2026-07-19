// FILE: release-source-provenance-policy.ts
// Purpose: Validates formal and downstream release version/ref contracts without repository I/O.
// Layer: Release preflight helper

import type { ReleaseDistributionKind } from "./release-artifact-provenance.ts";

export interface ReleaseSourcePolicyInput {
  readonly distributionKind: ReleaseDistributionKind;
  readonly version: string;
  readonly tag: string;
  readonly publishRelease: boolean;
  readonly refType?: string;
  readonly refName?: string;
  readonly packageVersions: ReadonlyArray<{
    readonly path: string;
    readonly version: string | undefined;
  }>;
}

export interface ReleaseSourcePolicyResult {
  readonly coreVersion: string;
  readonly expectedTag: string;
  readonly expectedRefType: "branch" | "tag" | null;
  readonly expectedRefName: string | null;
}

function validatePackageVersions(
  packageVersions: ReleaseSourcePolicyInput["packageVersions"],
  expectedVersion: string,
): void {
  for (const manifest of packageVersions) {
    if (manifest.version !== expectedVersion) {
      throw new Error(
        `${manifest.path} version ${manifest.version ?? "<missing>"} does not match required core ${expectedVersion}.`,
      );
    }
  }
}

export function validateReleaseSourcePolicy(
  input: ReleaseSourcePolicyInput,
): ReleaseSourcePolicyResult {
  if (input.distributionKind === "github-unsigned-prerelease") {
    const match = /^(\d+\.\d+\.\d+)-super\.([1-9]\d*)$/.exec(input.version);
    if (!match) {
      throw new Error(
        `Super Synara version must be <core>-super.<positive integer>, got ${input.version}.`,
      );
    }
    const coreVersion = match[1]!;
    const expectedTag = `super-v${input.version}`;
    if (input.tag !== expectedTag) {
      throw new Error(`Super Synara tag must be ${expectedTag}, got ${input.tag}.`);
    }
    if (!input.publishRelease) {
      throw new Error("Super Synara workflow must explicitly authorize unsigned publication.");
    }
    if (input.refType !== "branch" || input.refName !== "main") {
      throw new Error(
        `Super Synara publication must dispatch from protected main, got ${input.refType ?? "<none>"}/${input.refName ?? "<none>"}.`,
      );
    }
    validatePackageVersions(input.packageVersions, coreVersion);
    return {
      coreVersion,
      expectedTag,
      expectedRefType: "branch",
      expectedRefName: "main",
    };
  }

  if (input.distributionKind === "build-only") {
    if (input.publishRelease) {
      throw new Error("Build-only source policy cannot authorize publication.");
    }
    validatePackageVersions(input.packageVersions, input.version);
    return {
      coreVersion: input.version,
      expectedTag: `v${input.version}`,
      expectedRefType: null,
      expectedRefName: null,
    };
  }

  const expectedTag = `v${input.version}`;
  if (input.tag !== expectedTag) {
    throw new Error(`Signed release tag must be ${expectedTag}, got ${input.tag}.`);
  }
  validatePackageVersions(input.packageVersions, input.version);
  if (input.publishRelease && (input.refType !== "tag" || input.refName !== expectedTag)) {
    throw new Error(
      `Publishing requires the workflow ref to be the exact release tag ${expectedTag}; got ${input.refType ?? "<none>"}/${input.refName ?? "<none>"}.`,
    );
  }
  return {
    coreVersion: input.version,
    expectedTag,
    expectedRefType: input.publishRelease ? "tag" : null,
    expectedRefName: input.publishRelease ? expectedTag : null,
  };
}
