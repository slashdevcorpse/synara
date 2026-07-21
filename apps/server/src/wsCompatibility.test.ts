import {
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeCurrentWsFeatureCompatibilitySearchParams,
  negotiateWsCompatibility,
  validateWsFeatureCompatibility,
} from "./wsCompatibility";

describe("WebSocket compatibility bootstrap", () => {
  it("negotiates the stable epoch/range and returns process/build capabilities", async () => {
    const result = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: WS_PROTOCOL_MIN_REVISION,
        maxRevision: WS_PROTOCOL_MAX_REVISION,
        clientBuild: "test-client",
        requiredCapabilities: ["orchestration.cursor-safe-streams"],
      }),
    );

    expect(result).toMatchObject({
      protocolEpoch: WS_PROTOCOL_EPOCH,
      negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
    });
    expect(result.serverBuild.length).toBeGreaterThan(0);
    expect(result.serverInstanceId.length).toBeGreaterThan(0);
    expect(result.capabilities).toContain("orchestration.cursor-safe-streams");
  });

  it("returns terminal update guidance and rejects feature calls without negotiated query data", async () => {
    const error = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH - 1,
        minRevision: 0,
        maxRevision: 0,
        clientBuild: "stale-client",
        requiredCapabilities: [],
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
    });
    expect(validateWsFeatureCompatibility(new URLSearchParams())).toMatchObject({
      code: "WS_NEGOTIATION_REQUIRED",
      retryable: false,
    });
    expect(
      validateWsFeatureCompatibility(makeCurrentWsFeatureCompatibilitySearchParams("test-client")),
    ).toBeNull();
  });

  it("rejects a missing required capability with terminal server-update guidance", async () => {
    const error = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: WS_PROTOCOL_MIN_REVISION,
        maxRevision: WS_PROTOCOL_MAX_REVISION,
        clientBuild: "future-client",
        requiredCapabilities: ["rpc.future-capability"],
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "WS_CAPABILITIES_INCOMPATIBLE",
      retryable: false,
      action: "update-server",
    });
  });

  it("rejects both mixed-version directions across the sequenced-terminal boundary", async () => {
    const oldClient = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: 1,
        maxRevision: 1,
        clientBuild: "revision-1-client",
        requiredCapabilities: [],
      }).pipe(Effect.flip),
    );
    expect(oldClient).toMatchObject({
      code: "WS_PROTOCOL_INCOMPATIBLE",
      action: "update-client",
    });

    const futureClient = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: WS_PROTOCOL_MAX_REVISION + 1,
        maxRevision: WS_PROTOCOL_MAX_REVISION + 1,
        clientBuild: "future-client",
        requiredCapabilities: [],
      }).pipe(Effect.flip),
    );
    expect(futureClient).toMatchObject({
      code: "WS_PROTOCOL_INCOMPATIBLE",
      action: "update-server",
    });
  });
});
