// FILE: TerminalSearch.browser.tsx
// Purpose: Browser regressions for debounced terminal search behavior.
// Layer: Browser UI test

import "../index.css";

import type { SearchAddon } from "@xterm/addon-search";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TerminalSearch } from "./TerminalSearch";

describe("TerminalSearch", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tracks authoritative result updates after a debounced miss", async () => {
    type SearchResultsListener = (results: {
      resultIndex: number;
      resultCount: number;
    }) => void;
    let resultListener: SearchResultsListener = () => {
      throw new Error("Terminal search result listener was not registered.");
    };
    const disposeResultListener = vi.fn();
    const onDidChangeResults = vi.fn((listener: SearchResultsListener) => {
      resultListener = listener;
      return { dispose: disposeResultListener };
    });
    const findNext = vi.fn((_term: string) => false);
    const searchAddon = {
      clearDecorations: vi.fn(),
      findNext,
      findPrevious: vi.fn(() => false),
      onDidChangeResults,
    } as unknown as SearchAddon;

    const screen = await render(
      <TerminalSearch searchAddon={searchAddon} isOpen onClose={() => undefined} />,
    );
    const searchInput = page.getByRole("textbox", { name: "Find" });
    await expect.element(searchInput).toHaveAttribute("aria-label", "Find");
    await searchInput.fill("needle");

    await new Promise((resolve) => window.setTimeout(resolve, 180));

    expect(findNext).toHaveBeenCalledTimes(1);
    expect(findNext.mock.calls[0]?.[0]).toBe("needle");
    await expect.element(page.getByText("No results")).toBeVisible();

    expect(onDidChangeResults).toHaveBeenCalledTimes(1);
    resultListener({ resultIndex: 0, resultCount: 1 });

    await expect.element(page.getByText("No results")).not.toBeInTheDocument();
    await screen.unmount();
    expect(disposeResultListener).toHaveBeenCalledTimes(1);
  });
});
