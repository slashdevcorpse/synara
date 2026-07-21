// Policy-neutral token-bucket arithmetic shared by transport and upload admission.
// Callers own clock normalization, bucket storage, capacities, and rejection reasons.

export interface AdmissionTokenBucket {
  readonly tokens: number;
  readonly refilledAtMs: number;
  readonly lastSeenAtMs: number;
}

export function normalizeAdmissionPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

export function refillAdmissionTokenBucket(input: {
  readonly bucket: AdmissionTokenBucket | undefined;
  readonly nowMs: number;
  readonly capacity: number;
  readonly refillPerMs: number;
}): AdmissionTokenBucket {
  if (!input.bucket) {
    return {
      tokens: input.capacity,
      refilledAtMs: input.nowMs,
      lastSeenAtMs: input.nowMs,
    };
  }
  const elapsedMs = Math.max(0, input.nowMs - input.bucket.refilledAtMs);
  return {
    tokens: Math.min(input.capacity, input.bucket.tokens + elapsedMs * input.refillPerMs),
    refilledAtMs: input.nowMs,
    lastSeenAtMs: input.nowMs,
  };
}

export function admissionRetryAfterMs(tokens: number, refillPerMs: number): number {
  return Math.max(1, Math.ceil((1 - tokens) / refillPerMs));
}
