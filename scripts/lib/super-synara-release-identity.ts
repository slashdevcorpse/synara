// FILE: super-synara-release-identity.ts
// Purpose: Defines the one canonical marker and title for owned Super Synara releases.
// Layer: Release identity policy

export const SUPER_SYNARA_RELEASE_DRAFTER_MARKER = "<!-- super-synara-release-drafter-owned -->";

interface SuperSynaraReleaseIdentity {
  readonly name: string;
  readonly body: string;
  readonly prerelease: boolean;
}

export function superSynaraReleaseTitle(version: string): string {
  return `Unofficial downstream Super Synara ${version} (unsigned prerelease)`;
}

export function hasSuperSynaraReleaseOwnership(release: SuperSynaraReleaseIdentity): boolean {
  return release.prerelease && release.body.includes(SUPER_SYNARA_RELEASE_DRAFTER_MARKER);
}

export function hasExactSuperSynaraReleaseIdentity(
  release: SuperSynaraReleaseIdentity,
  version: string,
): boolean {
  return (
    hasSuperSynaraReleaseOwnership(release) && release.name === superSynaraReleaseTitle(version)
  );
}
