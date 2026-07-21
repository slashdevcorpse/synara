// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor's private Synara host-policy delivery.
// Layer: Provider adapter tests

import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  stopCursorSessionsBestEffort,
  takeCursorSynaraHarnessPolicyTextPart,
} from "./CursorAdapter.ts";

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

describe("Cursor session cleanup", () => {
  it("attempts a snapshot of every session and re-raises the first stop failure", async () => {
    const firstFailure = new Error("first Cursor stop failed");
    const sessions = new Map([
      ["one", { id: "one" }],
      ["two", { id: "two" }],
      ["three", { id: "three" }],
    ]);
    const attempted: string[] = [];

    const exit = await Effect.runPromise(
      Effect.exit(
        stopCursorSessionsBestEffort(sessions.values(), (session) => {
          attempted.push(session.id);
          sessions.delete(session.id);
          if (session.id === "one") return Effect.fail(firstFailure);
          if (session.id === "two") return Effect.die(new Error("later Cursor stop defect"));
          return Effect.void;
        }),
      ),
    );

    expect(attempted).toEqual(["one", "two", "three"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBe(firstFailure);
    }
  });
});
