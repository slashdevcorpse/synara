import { describe, expect, it } from "vitest";

import {
  WS_RPC_ERROR_CODES,
  WsAutomationCreateRpc,
  WsProjectsDiscoverScriptsRpc,
  WsRpcError,
  WsRpcGroup,
} from "./rpc";

describe("WS RPC contracts", () => {
  it("exports the additive Effect RPC group", () => {
    expect(WsRpcGroup).toBeDefined();
  });

  it("uses a schema-backed transport error", () => {
    expect(new WsRpcError({ message: "failed" }).message).toBe("failed");
    expect(
      new WsRpcError({
        message: "rejected",
        code: WS_RPC_ERROR_CODES.orchestrationDispatchRejected,
      }).code,
    ).toBe(WS_RPC_ERROR_CODES.orchestrationDispatchRejected);
  });

  it("exports the project script discovery RPC", () => {
    expect(WsProjectsDiscoverScriptsRpc).toBeDefined();
  });

  it("exports the automation create RPC", () => {
    expect(WsAutomationCreateRpc).toBeDefined();
  });
});
