// FILE: desktopIdentityProof.ts
// Purpose: Defines the stable, non-secret packaged desktop identity startup proof.

export const PACKAGED_DESKTOP_IDENTITY_PROOF_PREFIX = "packaged desktop identity proof ";

export interface PackagedDesktopIdentityProof {
  readonly flavor: string;
  readonly appUserModelId: string | null;
  readonly bundleId: string;
  readonly internalProtocolScheme: string;
  readonly internalProtocolRegistered: true;
  readonly userDataDirectoryName: string;
  readonly userDataPath: string;
  readonly backendHomePath: string;
}

export function renderPackagedDesktopIdentityProof(proof: PackagedDesktopIdentityProof): string {
  return `${PACKAGED_DESKTOP_IDENTITY_PROOF_PREFIX}${JSON.stringify(proof)}`;
}

export function parsePackagedDesktopIdentityProof(
  line: string,
): PackagedDesktopIdentityProof | null {
  if (!line.startsWith(PACKAGED_DESKTOP_IDENTITY_PROOF_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(line.slice(PACKAGED_DESKTOP_IDENTITY_PROOF_PREFIX.length));
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<PackagedDesktopIdentityProof>;
    if (
      typeof candidate.flavor !== "string" ||
      (candidate.appUserModelId !== null && typeof candidate.appUserModelId !== "string") ||
      typeof candidate.bundleId !== "string" ||
      typeof candidate.internalProtocolScheme !== "string" ||
      candidate.internalProtocolRegistered !== true ||
      typeof candidate.userDataDirectoryName !== "string" ||
      typeof candidate.userDataPath !== "string" ||
      typeof candidate.backendHomePath !== "string"
    ) {
      return null;
    }
    return candidate as PackagedDesktopIdentityProof;
  } catch {
    return null;
  }
}
