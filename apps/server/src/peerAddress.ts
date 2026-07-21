// FILE: peerAddress.ts
// Purpose: Canonicalizes direct socket peer addresses for bounded transport admission.
// Layer: Server transport utility

export function normalizePeerAddress(remoteAddress: string | null | undefined): string {
  const normalized = remoteAddress?.trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}
