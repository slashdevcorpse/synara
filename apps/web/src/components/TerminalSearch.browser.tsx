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

  it("runs a debounced search after the query rerender", async () => {
    const findNext = vi.fn(() => false);
    const searchAddon = {
      clearDecorations: vi.fn(),
      findNext,
      findPrevious: vi.fn(() => false),
    } as unknown as SearchAddon;

    await render(<TerminalSearch searchAddon={searchAddon} isOpen onClose={() => undefined} />);
    await page.getByRole("textbox", { name: "Find" }).fill("needle");

    await new Promise((resolve) => window.setTimeout(resolve, 180));

    expect(findNext).toHaveBeenCalledTimes(1);
    expect(findNext.mock.calls[0]?.[0]).toBe("needle");
    await expect.element(page.getByText("No results")).toBeVisible();
  });
});
