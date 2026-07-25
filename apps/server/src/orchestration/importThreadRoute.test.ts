// FILE: importThreadRoute.test.ts
// Purpose: Verifies imported provider sessions receive provider-native resume cursors.
// Layer: Orchestration command handler tests
// Depends on: importThreadRoute.

import { describe, expect, it } from "vitest";

import { providerResumeCursorForImport } from "./importThreadRoute.ts";

describe("providerResumeCursorForImport", () => {
  it("maps Command Code imports to the v1 resume cursor", () => {
    expect(providerResumeCursorForImport("commandCode", "session-command-code")).toEqual({
      sessionId: "session-command-code",
      totalProcessedTokens: 0,
    });
  });

  it.each([
    ["codex", { threadId: "external-session" }],
    ["claudeAgent", { resume: "external-session" }],
    ["cursor", { threadId: "external-session" }],
    ["antigravity", { threadId: "external-session" }],
    ["grok", { threadId: "external-session" }],
    ["droid", { schemaVersion: 1, sessionId: "external-session" }],
    ["kilo", { openCodeSessionId: "external-session" }],
    ["opencode", { openCodeSessionId: "external-session" }],
    ["pi", { threadId: "external-session" }],
  ] as const)("preserves the %s import cursor", (provider, expected) => {
    expect(providerResumeCursorForImport(provider, "external-session")).toEqual(expected);
  });
});
