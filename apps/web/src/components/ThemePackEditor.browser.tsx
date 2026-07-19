// FILE: ThemePackEditor.browser.tsx
// Purpose: Browser regressions for debounced theme color commits.
// Layer: Browser UI test

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ThemePackEditor } from "./ThemePackEditor";

const THEME_STORAGE_KEY = "synara:theme";

describe("ThemePackEditor", () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it("commits a valid color after the draft rerender", async () => {
    await render(<ThemePackEditor variant="dark" />);
    await page.getByRole("button", { name: "Dark theme accent color" }).click();
    await page.getByRole("textbox", { name: "Dark theme accent color hex value" }).fill("#123456");

    await new Promise((resolve) => window.setTimeout(resolve, 320));

    const storedTheme = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "null") as {
      chromeThemes?: { dark?: { accent?: string } };
    } | null;
    expect(storedTheme?.chromeThemes?.dark?.accent).toBe("#123456");
  });
});
