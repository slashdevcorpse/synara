// FILE: git-sha.ts
// Purpose: Validates exact Git commit identifiers at release trust boundaries.
// Layer: Release integrity primitive

export function assertFullCommitSha(label: string, value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full 40-character commit SHA.`);
  }
}
