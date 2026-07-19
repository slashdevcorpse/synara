// FILE: super-synara-previous-release.ts
// Purpose: Selects the newest older published Super Synara prerelease with the exact Windows asset.

export interface SuperSynaraVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly iteration: number;
  readonly text: string;
}

export interface PreviousSuperSynaraRelease {
  readonly version: string;
  readonly tag: string;
  readonly assetName: string;
}

export interface UpstreamSynaraRelease {
  readonly version: string;
  readonly tag: string;
  readonly assetName: string;
}

interface GitHubReleaseAsset {
  readonly name?: unknown;
}

interface GitHubRelease {
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly tag_name?: unknown;
  readonly assets?: unknown;
}

export function parseSuperSynaraVersion(input: string): SuperSynaraVersion {
  const text = input.trim();
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-super\.([1-9]\d*)$/.exec(text);
  if (!match) {
    throw new Error(`Invalid Super Synara version: ${input}.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    iteration: Number(match[4]),
    text,
  };
}

export function compareSuperSynaraVersions(
  left: SuperSynaraVersion,
  right: SuperSynaraVersion,
): number {
  for (const key of ["major", "minor", "patch", "iteration"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function superSynaraWindowsInstallerName(version: string): string {
  const parsed = parseSuperSynaraVersion(version);
  return `Super-Synara-${parsed.text}-windows-x64-unsigned.exe`;
}

function flattenReleasePayload(input: unknown): ReadonlyArray<GitHubRelease> {
  if (!Array.isArray(input)) {
    throw new Error("GitHub releases payload must be an array.");
  }
  const flattened = input.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
  return flattened.filter(
    (entry): entry is GitHubRelease => typeof entry === "object" && entry !== null,
  );
}

export function selectPreviousSuperSynaraRelease(
  releasesPayload: unknown,
  currentVersionInput: string,
): PreviousSuperSynaraRelease | null {
  const currentVersion = parseSuperSynaraVersion(currentVersionInput);
  let selected: { release: PreviousSuperSynaraRelease; parsed: SuperSynaraVersion } | null = null;

  for (const release of flattenReleasePayload(releasesPayload)) {
    if (
      release.draft === true ||
      release.prerelease !== true ||
      typeof release.tag_name !== "string"
    ) {
      continue;
    }
    const tagMatch = /^super-v(.+)$/.exec(release.tag_name);
    if (!tagMatch) continue;

    let version: SuperSynaraVersion;
    try {
      version = parseSuperSynaraVersion(tagMatch[1]!);
    } catch {
      continue;
    }
    if (compareSuperSynaraVersions(version, currentVersion) >= 0) continue;

    const expectedAssetName = superSynaraWindowsInstallerName(version.text);
    const assets = Array.isArray(release.assets)
      ? release.assets.filter(
          (asset): asset is GitHubReleaseAsset => typeof asset === "object" && asset !== null,
        )
      : [];
    const exactAssetCount = assets.filter((asset) => asset.name === expectedAssetName).length;
    if (exactAssetCount !== 1) continue;

    if (!selected || compareSuperSynaraVersions(version, selected.parsed) > 0) {
      selected = {
        parsed: version,
        release: {
          version: version.text,
          tag: release.tag_name,
          assetName: expectedAssetName,
        },
      };
    }
  }

  return selected?.release ?? null;
}

export function selectPublishedUpstreamSynaraRelease(
  releasesPayload: unknown,
  superVersionInput: string,
): UpstreamSynaraRelease {
  const superVersion = parseSuperSynaraVersion(superVersionInput);
  const version = `${superVersion.major}.${superVersion.minor}.${superVersion.patch}`;
  const expectedTag = `v${version}`;
  const assetName = `Synara-${version}-x64.exe`;
  const matches: UpstreamSynaraRelease[] = [];
  for (const release of flattenReleasePayload(releasesPayload)) {
    if (
      release.draft === true ||
      release.prerelease === true ||
      typeof release.tag_name !== "string"
    ) {
      continue;
    }
    if (release.tag_name !== expectedTag) continue;
    const assets = Array.isArray(release.assets)
      ? release.assets.filter(
          (asset): asset is GitHubReleaseAsset => typeof asset === "object" && asset !== null,
        )
      : [];
    if (assets.filter((asset) => asset.name === assetName).length !== 1) continue;
    matches.push({ version, tag: release.tag_name, assetName });
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one published upstream Synara ${expectedTag} release with exact asset ${assetName}, found ${matches.length}.`,
    );
  }
  return matches[0]!;
}
