// FILE: Sidebar.import.test.ts
// Purpose: Smoke-test that the large Sidebar module still imports after project-run wiring.
// Layer: Web component module test
// Depends on: Vitest module mocking and Sidebar's transitive imports.

import { describe, expect, it, vi } from "vitest";

vi.mock("./terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: {
    disposeTerminal: vi.fn(),
  },
}));

// Keep this project-run smoke test scoped to Sidebar wiring. The workspace
// agent section has its own focused unit and browser coverage.
vi.mock("./workspace/WorkspaceAgentSection", () => ({
  WorkspaceAgentSection: () => null,
}));

describe("Sidebar module", () => {
  it("loads after project-run wiring", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./Sidebar");

    expect(module.default).toBeTypeOf("function");
    // Full-suite runs transform many web files concurrently; this import can cross Vitest's 5s default.
  }, 15_000);
});
