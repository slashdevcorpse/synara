// FILE: CursorAdapter.test.ts
// Purpose: Verifies Cursor model discovery preparation and private host-policy delivery.
// Layer: Provider adapter tests
// Depends on: CursorAdapter model-list process helper.

import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { describe, expect, it } from "vitest";

import {
  makeCursorModelListChildProcess,
  takeCursorSynaraHarnessPolicyTextPart,
} from "./CursorAdapter.ts";

describe("CursorAdapter model discovery", () => {
  it("forwards prepared Windows model-list spawn options", () => {
    const env = { SYNARA_TEST: "cursor-model-list" };
    const command = makeCursorModelListChildProcess(
      {
        command: "C:\\tools\\synara-windows-job-launcher.exe",
        args: ["--", "C:\\tools\\cursor-agent.exe", "models"],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
      env,
    );

    expect(command.options).toMatchObject({
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });
});

describe("Cursor Synara harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeCursorSynaraHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(SYNARA_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the synara_* tools");
      expect(takeCursorSynaraHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeCursorSynaraHarnessPolicyTextPart({}, false)?.text).toContain(
      "Synara MCP control is unavailable",
    );
  });
});
