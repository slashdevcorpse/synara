import { describe, expect, it } from "vitest";

import {
  makeUploadAdmission,
  MAX_UPLOADS_PER_MINUTE_PER_PEER,
  MAX_UPLOADS_PER_MINUTE_PER_PRINCIPAL,
  normalizeUploadPeerAddress,
  UPLOAD_ADMISSION_IDLE_KEY_TTL_MS,
} from "./uploadAdmission";

describe("upload admission", () => {
  it("enforces the exact principal and direct-peer rates atomically", () => {
    const admission = makeUploadAdmission({ now: () => 0 });

    for (let index = 0; index < MAX_UPLOADS_PER_MINUTE_PER_PRINCIPAL; index += 1) {
      expect(admission.admit({ principalKey: "session:a", remoteAddress: "10.0.0.1" })).toEqual({
        admitted: true,
      });
    }
    expect(admission.admit({ principalKey: "session:a", remoteAddress: "10.0.0.1" })).toEqual({
      admitted: false,
      reason: "principal-rate",
      retryAfterMs: 3_000,
    });

    for (
      let index = MAX_UPLOADS_PER_MINUTE_PER_PRINCIPAL;
      index < MAX_UPLOADS_PER_MINUTE_PER_PEER;
      index += 1
    ) {
      expect(
        admission.admit({ principalKey: `session:${index}`, remoteAddress: "10.0.0.1" }),
      ).toEqual({ admitted: true });
    }
    expect(
      admission.admit({ principalKey: "session:peer-limit", remoteAddress: "10.0.0.1" }),
    ).toEqual({
      admitted: false,
      reason: "peer-rate",
      retryAfterMs: 1_200,
    });
    expect(
      admission.admit({ principalKey: "session:peer-limit", remoteAddress: "10.0.0.2" }),
    ).toEqual({
      admitted: true,
    });
  });

  it("refills capacity from an injected clock", () => {
    let nowMs = 0;
    const admission = makeUploadAdmission({
      now: () => nowMs,
      uploadsPerMinutePerPrincipal: 1,
      uploadsPerMinutePerPeer: 1,
    });

    expect(admission.admit({ principalKey: "session:a", remoteAddress: "10.0.0.1" })).toEqual({
      admitted: true,
    });
    nowMs = 30_000;
    expect(admission.admit({ principalKey: "session:a", remoteAddress: "10.0.0.1" })).toEqual({
      admitted: false,
      reason: "principal-rate",
      retryAfterMs: 30_000,
    });
    nowMs = 60_000;
    expect(admission.admit({ principalKey: "session:a", remoteAddress: "10.0.0.1" })).toEqual({
      admitted: true,
    });
  });

  it("normalizes IPv4-mapped peers and isolates different direct peers", () => {
    const admission = makeUploadAdmission({
      now: () => 0,
      uploadsPerMinutePerPrincipal: 10,
      uploadsPerMinutePerPeer: 1,
    });

    expect(normalizeUploadPeerAddress(" ::FFFF:127.0.0.1 ")).toBe("127.0.0.1");
    expect(normalizeUploadPeerAddress(undefined)).toBe("unknown");
    expect(
      admission.admit({ principalKey: "session:a", remoteAddress: "::ffff:127.0.0.1" }),
    ).toEqual({ admitted: true });
    expect(admission.admit({ principalKey: "session:b", remoteAddress: "127.0.0.1" })).toEqual({
      admitted: false,
      reason: "peer-rate",
      retryAfterMs: 60_000,
    });
    expect(admission.admit({ principalKey: "session:b", remoteAddress: "127.0.0.2" })).toEqual({
      admitted: true,
    });
  });

  it("isolates authenticated proxy uploads by principal without tracking the shared peer", () => {
    const admission = makeUploadAdmission({
      now: () => 0,
      uploadsPerMinutePerPrincipal: 2,
      uploadsPerMinutePerPeer: 1,
    });

    expect(
      admission.admit({
        principalKey: "session:a",
        remoteAddress: "127.0.0.1",
        rateLimitPeer: false,
      }),
    ).toEqual({ admitted: true });
    expect(
      admission.admit({
        principalKey: "session:b",
        remoteAddress: "127.0.0.1",
        rateLimitPeer: false,
      }),
    ).toEqual({ admitted: true });
    expect(
      admission.admit({
        principalKey: "session:a",
        remoteAddress: "127.0.0.1",
        rateLimitPeer: false,
      }),
    ).toEqual({ admitted: true });
    expect(
      admission.admit({
        principalKey: "session:a",
        remoteAddress: "127.0.0.1",
        rateLimitPeer: false,
      }),
    ).toEqual({ admitted: false, reason: "principal-rate", retryAfterMs: 30_000 });
    expect(admission.snapshot()).toMatchObject({ trackedPrincipals: 2, trackedPeers: 0 });
  });

  it("bounds high-cardinality keys with shared overflow buckets and prunes idle state", () => {
    let nowMs = 0;
    const admission = makeUploadAdmission({
      now: () => nowMs,
      uploadsPerMinutePerPrincipal: 1,
      uploadsPerMinutePerPeer: 10,
      maxTrackedPrincipals: 1,
      maxTrackedPeers: 1,
    });

    expect(admission.admit({ principalKey: "session:a", remoteAddress: "10.0.0.1" })).toEqual({
      admitted: true,
    });
    expect(admission.admit({ principalKey: "session:b", remoteAddress: "10.0.0.2" })).toEqual({
      admitted: true,
    });
    expect(admission.admit({ principalKey: "session:c", remoteAddress: "10.0.0.3" })).toEqual({
      admitted: false,
      reason: "principal-rate",
      retryAfterMs: 60_000,
    });
    expect(admission.snapshot()).toEqual({
      trackedPrincipals: 1,
      trackedPeers: 1,
      usingOverflowPrincipalBucket: true,
      usingOverflowPeerBucket: true,
    });

    nowMs = UPLOAD_ADMISSION_IDLE_KEY_TTL_MS;
    expect(admission.admit({ principalKey: "session:d", remoteAddress: "10.0.0.4" })).toEqual({
      admitted: true,
    });
    expect(admission.snapshot()).toEqual({
      trackedPrincipals: 1,
      trackedPeers: 1,
      usingOverflowPrincipalBucket: false,
      usingOverflowPeerBucket: false,
    });
  });
});
