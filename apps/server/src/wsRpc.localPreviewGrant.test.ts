import { WsRpcError } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createLocalPreviewGrantRpcEffect } from "./wsRpc";

describe("local preview grant RPC errors", () => {
  it("keeps a rejected grant promise in the typed WsRpcError channel", async () => {
    const failure = await Effect.runPromise(
      createLocalPreviewGrantRpcEffect({ requestedPath: "relative-preview.png" }).pipe(
        Effect.flip,
      ),
    );

    expect(failure).toBeInstanceOf(WsRpcError);
    expect(failure).toMatchObject({
      _tag: "WsRpcError",
      message: "Only absolute local files can be granted.",
    });
    expect(failure.cause).toBeInstanceOf(Error);
  });
});
