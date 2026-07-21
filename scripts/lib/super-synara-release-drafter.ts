// FILE: super-synara-release-drafter.ts
// Purpose: Resolves the one owned next Super Synara draft without mutating GitHub state.
// Layer: Release scheduling policy

import { assertFullCommitSha } from "./git-sha.ts";
import type { SuperSynaraDraftRelease, SuperSynaraTagRef } from "./super-synara-github-payload.ts";
import {
  hasExactSuperSynaraReleaseIdentity,
  hasSuperSynaraReleaseOwnership,
  SUPER_SYNARA_RELEASE_DRAFTER_MARKER,
  superSynaraReleaseTitle,
} from "./super-synara-release-identity.ts";

export { SUPER_SYNARA_RELEASE_DRAFTER_MARKER, superSynaraReleaseTitle };
export type { SuperSynaraDraftRelease, SuperSynaraTagRef } from "./super-synara-github-payload.ts";

export interface SuperSynaraDraftPlan {
  readonly version: string;
  readonly tag: string;
  readonly existingDraftId: number | null;
  readonly latestTag: string;
  readonly latestTagCommit: string;
}

interface ParsedSuperVersion {
  readonly version: string;
  readonly iteration: number;
}

export function assertSuperSynaraCoreVersion(coreVersion: string): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(coreVersion)) {
    throw new Error(`Invalid Super Synara core version: ${coreVersion}.`);
  }
}

function parseTag(coreVersion: string, tag: string): ParsedSuperVersion | null {
  const match = new RegExp(
    `^super-v${coreVersion.replaceAll(".", "\\.")}-super\\.([1-9]\\d*)$`,
  ).exec(tag);
  if (!match) return null;
  const iteration = Number(match[1]);
  if (!Number.isSafeInteger(iteration)) {
    throw new Error(`Super Synara iteration is not a safe integer: ${tag}.`);
  }
  return { version: `${coreVersion}-super.${iteration}`, iteration };
}

function isOwnedDraft(release: SuperSynaraDraftRelease): boolean {
  return release.draft && hasSuperSynaraReleaseOwnership(release);
}

export function resolveSuperSynaraDraftPlan(input: {
  readonly coreVersion: string;
  readonly sourceCommit: string;
  readonly tags: ReadonlyArray<SuperSynaraTagRef>;
  readonly releases: ReadonlyArray<SuperSynaraDraftRelease>;
}): SuperSynaraDraftPlan {
  assertSuperSynaraCoreVersion(input.coreVersion);
  assertFullCommitSha("Source commit", input.sourceCommit);

  const matchingTags = input.tags.flatMap((tag) => {
    const parsed = parseTag(input.coreVersion, tag.name);
    if (!parsed) return [];
    assertFullCommitSha(`Tag ${tag.name} commit`, tag.commit);
    return [{ ...tag, ...parsed }];
  });
  if (matchingTags.length === 0) {
    throw new Error(`No immutable Super Synara baseline tag exists for ${input.coreVersion}.`);
  }
  const duplicateTag = matchingTags.find(
    (tag, index) => matchingTags.findIndex((candidate) => candidate.name === tag.name) !== index,
  );
  if (duplicateTag) throw new Error(`Duplicate Super Synara tag state: ${duplicateTag.name}.`);

  const matchingReleases = input.releases.flatMap((release) => {
    const parsed = parseTag(input.coreVersion, release.tagName);
    return parsed ? [{ ...release, ...parsed }] : [];
  });
  const foreignDraft = matchingReleases.find((release) => release.draft && !isOwnedDraft(release));
  if (foreignDraft) {
    throw new Error(`Refusing to adopt unowned Super Synara draft ${foreignDraft.id}.`);
  }
  const ownedDrafts = matchingReleases.filter(isOwnedDraft);
  if (ownedDrafts.length > 1) {
    throw new Error(`Expected at most one owned Super Synara draft, found ${ownedDrafts.length}.`);
  }

  const latestTag = matchingTags.reduce((latest, tag) =>
    tag.iteration > latest.iteration ? tag : latest,
  );
  const ownedDraft = ownedDrafts[0];
  if (ownedDraft) {
    if (!Number.isSafeInteger(ownedDraft.id) || ownedDraft.id <= 0) {
      throw new Error("Owned Super Synara draft ID must be a positive safe integer.");
    }
    if (!hasExactSuperSynaraReleaseIdentity(ownedDraft, ownedDraft.version)) {
      throw new Error(`Owned Super Synara draft ${ownedDraft.id} has an unexpected title.`);
    }
    const sameTagReleases = matchingReleases.filter(
      (release) => release.tagName === ownedDraft.tagName,
    );
    if (sameTagReleases.length !== 1) {
      throw new Error(`Owned Super Synara draft tag ${ownedDraft.tagName} is not unique.`);
    }
    const reservedTag = matchingTags.find((tag) => tag.name === ownedDraft.tagName);
    if (reservedTag) {
      throw new Error(
        `Owned draft ${ownedDraft.id} unexpectedly has immutable tag ${ownedDraft.tagName}; draft publication must create the tag atomically.`,
      );
    }
    if (ownedDraft.iteration <= latestTag.iteration) {
      throw new Error(`Owned draft ${ownedDraft.id} does not advance ${latestTag.name}.`);
    }
    return {
      version: ownedDraft.version,
      tag: ownedDraft.tagName,
      existingDraftId: ownedDraft.id,
      latestTag: latestTag.name,
      latestTagCommit: latestTag.commit,
    };
  }

  const latestReleaseIteration = matchingReleases.reduce(
    (latest, release) => Math.max(latest, release.iteration),
    0,
  );
  const iteration = Math.max(latestTag.iteration, latestReleaseIteration) + 1;
  const version = `${input.coreVersion}-super.${iteration}`;
  const tag = `super-v${version}`;
  if (matchingReleases.some((release) => release.tagName === tag)) {
    throw new Error(`Next Super Synara tag ${tag} already has release state.`);
  }
  return {
    version,
    tag,
    existingDraftId: null,
    latestTag: latestTag.name,
    latestTagCommit: latestTag.commit,
  };
}
