// FILE: rootRoute.import.test.ts
// Purpose: Smoke-test root shell subscription wiring after cursor-resnapshot changes.
// Layer: Web route module test

import { describe, expect, it, vi } from "vitest";

vi.mock("./components/terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: {
    disposeTerminal: vi.fn(),
  },
}));

describe("root route module", () => {
  it("loads the shell event router with visibility-resnapshot support", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./routes/__root");

    expect(module.Route).toBeDefined();
  }, 30_000);
});
