// FILE: super-synara-release-drafter.ts
// Purpose: Resolves the one owned next Super Synara draft without mutating GitHub state.
// Layer: Release scheduling policy

export const SUPER_SYNARA_RELEASE_DRAFTER_MARKER = "<!-- super-synara-release-drafter-owned -->";

export interface SuperSynaraTagRef {
  readonly name: string;
  readonly commit: string;
}

export interface SuperSynaraDraftRelease {
  readonly id: number;
  readonly tagName: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
}

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

function assertCoreVersion(coreVersion: string): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(coreVersion)) {
    throw new Error(`Invalid Super Synara core version: ${coreVersion}.`);
  }
}

function assertFullSha(label: string, value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full 40-character commit SHA.`);
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

export function superSynaraReleaseTitle(version: string): string {
  return `Unofficial downstream Super Synara ${version} (unsigned prerelease)`;
}

function isOwnedDraft(release: SuperSynaraDraftRelease): boolean {
  return (
    release.draft &&
    release.prerelease &&
    release.body.includes(SUPER_SYNARA_RELEASE_DRAFTER_MARKER)
  );
}

export function resolveSuperSynaraDraftPlan(input: {
  readonly coreVersion: string;
  readonly sourceCommit: string;
  readonly tags: ReadonlyArray<SuperSynaraTagRef>;
  readonly releases: ReadonlyArray<SuperSynaraDraftRelease>;
}): SuperSynaraDraftPlan {
  assertCoreVersion(input.coreVersion);
  assertFullSha("Source commit", input.sourceCommit);

  const matchingTags = input.tags.flatMap((tag) => {
    const parsed = parseTag(input.coreVersion, tag.name);
    if (!parsed) return [];
    assertFullSha(`Tag ${tag.name} commit`, tag.commit);
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
    if (ownedDraft.name !== superSynaraReleaseTitle(ownedDraft.version)) {
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
    if (!reservedTag && ownedDraft.iteration <= latestTag.iteration) {
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
