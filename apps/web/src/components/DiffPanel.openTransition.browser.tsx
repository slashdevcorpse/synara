// FILE: DiffPanel.openTransition.browser.tsx
// Purpose: Browser regression for deferred diff-panel open initialization.
// Layer: Browser lifecycle test

import { TurnId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { scheduleDiffOpenInitialization } from "./DiffPanel";

describe("diff panel open initialization", () => {
  it("reschedules with the latest inputs when the first timeout is cancelled", async () => {
    const previousDiffOpenRef = { current: false };
    const firstSetDiffWordWrap = vi.fn();
    const firstSetDiffViewKind = vi.fn();
    const cancelFirstInitialization = scheduleDiffOpenInitialization({
      diffOpen: true,
      selectedTurnId: null,
      diffWordWrap: false,
      previousDiffOpenRef,
      setDiffWordWrap: firstSetDiffWordWrap,
      setDiffViewKind: firstSetDiffViewKind,
    });

    expect(previousDiffOpenRef.current).toBe(false);
    cancelFirstInitialization?.();

    const latestSetDiffWordWrap = vi.fn();
    const latestSetDiffViewKind = vi.fn();
    scheduleDiffOpenInitialization({
      diffOpen: true,
      selectedTurnId: TurnId.makeUnsafe("turn-latest"),
      diffWordWrap: true,
      previousDiffOpenRef,
      setDiffWordWrap: latestSetDiffWordWrap,
      setDiffViewKind: latestSetDiffViewKind,
    });

    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(firstSetDiffWordWrap).not.toHaveBeenCalled();
    expect(firstSetDiffViewKind).not.toHaveBeenCalled();
    expect(latestSetDiffWordWrap).toHaveBeenCalledWith(true);
    expect(latestSetDiffViewKind).toHaveBeenCalledWith("turn");
    expect(previousDiffOpenRef.current).toBe(true);
  });
});
