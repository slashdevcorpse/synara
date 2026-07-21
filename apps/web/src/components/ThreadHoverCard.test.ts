// FILE: ThreadHoverCard.test.ts
// Purpose: Focused integration-logic coverage for connected thread hover cards.
// Layer: Sidebar UI tests

import { describe, expect, it } from "vitest";

import { resolveThreadHoverCardModelLabel } from "./ThreadHoverCard";

describe("resolveThreadHoverCardModelLabel", () => {
  it("uses provider-aware names for OpenCode model identifiers", () => {
    expect(
      resolveThreadHoverCardModelLabel({
        provider: "opencode",
        model: "openrouter/gpt-5.4",
      }),
    ).toBe("GPT-5.4");
  });

  it("preserves unknown non-OpenCode model identifiers", () => {
    expect(
      resolveThreadHoverCardModelLabel({
        provider: "codex",
        model: "custom/internal-model",
      }),
    ).toBe("custom/internal-model");
  });
});
