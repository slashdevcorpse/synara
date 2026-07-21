import { describe, expect, it } from "vitest";

import {
  DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS,
  appendDesktopPersistenceSmokeOutput,
  createDesktopPersistenceSmokeOutputState,
  endDesktopPersistenceSmokeOutputStream,
} from "./session-persistence-smoke.mjs";

describe("desktop persistence smoke output capture", () => {
  it("retains only the configured diagnostic tail across repeated chunks", () => {
    const state = createDesktopPersistenceSmokeOutputState();
    const discardedPrefix = "discarded-prefix\n";
    const retainedTail = "x".repeat(DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS);

    appendDesktopPersistenceSmokeOutput(state, "stdout", discardedPrefix);
    appendDesktopPersistenceSmokeOutput(state, "stdout", retainedTail);

    expect(state.output).toBe(retainedTail);
    expect(state.output).toHaveLength(DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS);
    expect(state.outputTruncated).toBe(true);
  });

  it("keeps split fatal and readiness evidence sticky after their text rolls out", () => {
    const patterns = ["Uncaught TypeError", "persistence-smoke userData=/isolated/profile"];
    const state = createDesktopPersistenceSmokeOutputState(patterns);

    appendDesktopPersistenceSmokeOutput(state, "stdout", "Uncaught Type");
    appendDesktopPersistenceSmokeOutput(
      state,
      "stdout",
      "Error\npersistence-smoke userData=/isolated/profile\n",
    );
    appendDesktopPersistenceSmokeOutput(
      state,
      "stdout",
      "z".repeat(DESKTOP_PERSISTENCE_SMOKE_DIAGNOSTIC_TAIL_CHARS),
    );

    expect(state.output).not.toContain("Uncaught TypeError");
    expect(state.output).not.toContain("persistence-smoke userData=/isolated/profile");
    expect(state.observedPatterns).toEqual(new Set(patterns));
    expect(state.outputTruncated).toBe(true);
  });

  it("decodes profile evidence when a UTF-8 character is split across chunks", () => {
    const profileEvidence = "persistence-smoke userData=C:/用户/profile";
    const encodedEvidence = Buffer.from(profileEvidence);
    const multibyteCharacter = Buffer.from("用");
    const splitIndex = encodedEvidence.indexOf(multibyteCharacter) + 1;
    const state = createDesktopPersistenceSmokeOutputState([profileEvidence]);

    expect(splitIndex).toBeGreaterThan(0);
    appendDesktopPersistenceSmokeOutput(state, "stdout", encodedEvidence.subarray(0, splitIndex));
    appendDesktopPersistenceSmokeOutput(state, "stdout", encodedEvidence.subarray(splitIndex));
    endDesktopPersistenceSmokeOutputStream(state, "stdout");

    expect(state.output).toBe(profileEvidence);
    expect(state.output).not.toContain("�");
    expect(state.observedPatterns).toEqual(new Set([profileEvidence]));
  });

  it("keeps UTF-8 decoder and pattern tails independent between stdout and stderr", () => {
    const stdoutPattern = "stdout=€/profile";
    const stderrPattern = "stderr=✓";
    const encodedStdout = Buffer.from(stdoutPattern);
    const multibyteCharacter = Buffer.from("€");
    const splitIndex = encodedStdout.indexOf(multibyteCharacter) + 1;
    const state = createDesktopPersistenceSmokeOutputState([stdoutPattern, stderrPattern]);

    expect(splitIndex).toBeGreaterThan(0);
    appendDesktopPersistenceSmokeOutput(state, "stdout", encodedStdout.subarray(0, splitIndex));
    appendDesktopPersistenceSmokeOutput(state, "stderr", Buffer.from(stderrPattern));
    endDesktopPersistenceSmokeOutputStream(state, "stderr");
    appendDesktopPersistenceSmokeOutput(state, "stdout", encodedStdout.subarray(splitIndex));
    endDesktopPersistenceSmokeOutputStream(state, "stdout");

    expect(state.output).not.toContain("�");
    expect(state.observedPatterns).toEqual(new Set([stdoutPattern, stderrPattern]));
  });
});
