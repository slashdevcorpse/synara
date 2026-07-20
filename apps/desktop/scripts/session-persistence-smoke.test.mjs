import { describe, expect, it } from "vitest";

import {
  DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS,
  appendDesktopPersistenceSmokeOutput,
  createDesktopPersistenceSmokeOutputState,
} from "./session-persistence-smoke.mjs";

describe("desktop persistence smoke output capture", () => {
  it("retains only the configured diagnostic tail across repeated chunks", () => {
    const state = createDesktopPersistenceSmokeOutputState();
    const discardedPrefix = "discarded-prefix\n";
    const retainedTail = "x".repeat(DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS);

    appendDesktopPersistenceSmokeOutput(state, discardedPrefix);
    appendDesktopPersistenceSmokeOutput(state, retainedTail);

    expect(state.output).toBe(retainedTail);
    expect(state.output).toHaveLength(DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS);
    expect(state.outputTruncated).toBe(true);
  });

  it("keeps split fatal and readiness evidence sticky after their text rolls out", () => {
    const state = createDesktopPersistenceSmokeOutputState();
    const patterns = ["Uncaught TypeError", "persistence-smoke userData=/isolated/profile"];

    appendDesktopPersistenceSmokeOutput(state, "Uncaught Type", patterns);
    appendDesktopPersistenceSmokeOutput(
      state,
      "Error\npersistence-smoke userData=/isolated/profile\n",
      patterns,
    );
    appendDesktopPersistenceSmokeOutput(
      state,
      "z".repeat(DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS),
      patterns,
    );

    expect(state.output).not.toContain("Uncaught TypeError");
    expect(state.output).not.toContain("persistence-smoke userData=/isolated/profile");
    expect(state.observedPatterns).toEqual(new Set(patterns));
    expect(state.outputTruncated).toBe(true);
  });
});
