import {
  admissionRetryAfterMs,
  type AdmissionTokenBucket,
  normalizeAdmissionPositiveInteger,
  refillAdmissionTokenBucket,
} from "./admissionTokenBucket";
import { normalizePeerAddress } from "./peerAddress";

export const MAX_UPLOADS_PER_MINUTE_PER_PRINCIPAL = 20;
export const MAX_UPLOADS_PER_MINUTE_PER_PEER = 50;
export const UPLOAD_ADMISSION_IDLE_KEY_TTL_MS = 2 * 60_000;
export const MAX_TRACKED_UPLOAD_PRINCIPALS = 4_096;
export const MAX_TRACKED_UPLOAD_PEERS = 4_096;

interface BucketSlot {
  readonly bucket: AdmissionTokenBucket | undefined;
  readonly commit: (bucket: AdmissionTokenBucket) => void;
}

export interface UploadAdmissionOptions {
  readonly now?: () => number;
  readonly uploadsPerMinutePerPrincipal?: number;
  readonly uploadsPerMinutePerPeer?: number;
  readonly idleKeyTtlMs?: number;
  readonly maxTrackedPrincipals?: number;
  readonly maxTrackedPeers?: number;
}

export interface UploadAdmissionInput {
  readonly principalKey: string;
  readonly remoteAddress: string | null | undefined;
  /** Disable only when an authenticated session is known to be behind publicUrl proxy mode. */
  readonly rateLimitPeer?: boolean;
}

export type UploadAdmissionOutcome =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: "principal-rate" | "peer-rate";
      readonly retryAfterMs: number;
    };

function refillBucket(input: {
  readonly bucket: AdmissionTokenBucket | undefined;
  readonly nowMs: number;
  readonly capacity: number;
  readonly refillPerMs: number;
}): AdmissionTokenBucket {
  const effectiveNowMs = Math.max(input.nowMs, input.bucket?.refilledAtMs ?? input.nowMs);
  return refillAdmissionTokenBucket({ ...input, nowMs: effectiveNowMs });
}

export const normalizeUploadPeerAddress = normalizePeerAddress;

function normalizePrincipalKey(principalKey: string): string {
  const normalized = principalKey.trim();
  return normalized || "unknown-principal";
}

export function makeUploadAdmission(options: UploadAdmissionOptions = {}) {
  const now = options.now ?? Date.now;
  const principalCapacity = normalizeAdmissionPositiveInteger(
    options.uploadsPerMinutePerPrincipal,
    MAX_UPLOADS_PER_MINUTE_PER_PRINCIPAL,
  );
  const peerCapacity = normalizeAdmissionPositiveInteger(
    options.uploadsPerMinutePerPeer,
    MAX_UPLOADS_PER_MINUTE_PER_PEER,
  );
  const principalRefillPerMs = principalCapacity / 60_000;
  const peerRefillPerMs = peerCapacity / 60_000;
  const idleKeyTtlMs = Math.max(
    60_000,
    normalizeAdmissionPositiveInteger(options.idleKeyTtlMs, UPLOAD_ADMISSION_IDLE_KEY_TTL_MS),
  );
  const maxTrackedPrincipals = normalizeAdmissionPositiveInteger(
    options.maxTrackedPrincipals,
    MAX_TRACKED_UPLOAD_PRINCIPALS,
  );
  const maxTrackedPeers = normalizeAdmissionPositiveInteger(
    options.maxTrackedPeers,
    MAX_TRACKED_UPLOAD_PEERS,
  );

  const principalBuckets = new Map<string, AdmissionTokenBucket>();
  const peerBuckets = new Map<string, AdmissionTokenBucket>();
  let overflowPrincipalBucket: AdmissionTokenBucket | undefined;
  let overflowPeerBucket: AdmissionTokenBucket | undefined;
  let nextPruneAtMs = 0;

  const pruneIdleKeys = (nowMs: number): void => {
    if (nowMs < nextPruneAtMs) return;
    nextPruneAtMs = nowMs + idleKeyTtlMs;
    for (const [key, bucket] of principalBuckets) {
      if (nowMs - bucket.lastSeenAtMs >= idleKeyTtlMs) principalBuckets.delete(key);
    }
    for (const [key, bucket] of peerBuckets) {
      if (nowMs - bucket.lastSeenAtMs >= idleKeyTtlMs) peerBuckets.delete(key);
    }
    if (overflowPrincipalBucket && nowMs - overflowPrincipalBucket.lastSeenAtMs >= idleKeyTtlMs) {
      overflowPrincipalBucket = undefined;
    }
    if (overflowPeerBucket && nowMs - overflowPeerBucket.lastSeenAtMs >= idleKeyTtlMs) {
      overflowPeerBucket = undefined;
    }
  };

  const principalSlot = (key: string): BucketSlot => {
    const existing = principalBuckets.get(key);
    if (existing || principalBuckets.size < maxTrackedPrincipals) {
      return {
        bucket: existing,
        commit: (bucket) => principalBuckets.set(key, bucket),
      };
    }
    return {
      bucket: overflowPrincipalBucket,
      commit: (bucket) => {
        overflowPrincipalBucket = bucket;
      },
    };
  };

  const peerSlot = (key: string): BucketSlot => {
    const existing = peerBuckets.get(key);
    if (existing || peerBuckets.size < maxTrackedPeers) {
      return {
        bucket: existing,
        commit: (bucket) => peerBuckets.set(key, bucket),
      };
    }
    return {
      bucket: overflowPeerBucket,
      commit: (bucket) => {
        overflowPeerBucket = bucket;
      },
    };
  };

  const admit = (input: UploadAdmissionInput): UploadAdmissionOutcome => {
    const currentNow = now();
    const nowMs = Number.isFinite(currentNow) ? Math.max(0, currentNow) : 0;
    pruneIdleKeys(nowMs);

    const principal = principalSlot(normalizePrincipalKey(input.principalKey));
    const peer =
      input.rateLimitPeer === false
        ? undefined
        : peerSlot(normalizeUploadPeerAddress(input.remoteAddress));
    const principalBucket = refillBucket({
      bucket: principal.bucket,
      nowMs,
      capacity: principalCapacity,
      refillPerMs: principalRefillPerMs,
    });
    const peerBucket = peer
      ? refillBucket({
          bucket: peer.bucket,
          nowMs,
          capacity: peerCapacity,
          refillPerMs: peerRefillPerMs,
        })
      : undefined;
    const principalRejected = principalBucket.tokens < 1;
    const peerRejected = peerBucket !== undefined && peerBucket.tokens < 1;

    if (principalRejected || peerRejected) {
      if (principalRejected) principal.commit(principalBucket);
      if (peerRejected && peer && peerBucket) peer.commit(peerBucket);
      const principalRetryAfter = principalRejected
        ? admissionRetryAfterMs(principalBucket.tokens, principalRefillPerMs)
        : 0;
      const peerRetryAfter =
        peerRejected && peerBucket ? admissionRetryAfterMs(peerBucket.tokens, peerRefillPerMs) : 0;
      return {
        admitted: false,
        reason: principalRejected ? "principal-rate" : "peer-rate",
        retryAfterMs: Math.max(principalRetryAfter, peerRetryAfter),
      };
    }

    principal.commit({ ...principalBucket, tokens: principalBucket.tokens - 1 });
    if (peer && peerBucket) peer.commit({ ...peerBucket, tokens: peerBucket.tokens - 1 });
    return { admitted: true };
  };

  const snapshot = () => ({
    trackedPrincipals: principalBuckets.size,
    trackedPeers: peerBuckets.size,
    usingOverflowPrincipalBucket: overflowPrincipalBucket !== undefined,
    usingOverflowPeerBucket: overflowPeerBucket !== undefined,
  });

  return { admit, snapshot } as const;
}

export type UploadAdmission = ReturnType<typeof makeUploadAdmission>;
