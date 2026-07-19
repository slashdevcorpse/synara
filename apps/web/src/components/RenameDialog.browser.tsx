// FILE: RenameDialog.browser.tsx
// Purpose: Browser regressions for rename form identity and async saving state.

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RenameDialog } from "./RenameDialog";

describe("RenameDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("resets draft and saving state when initialValue changes while open", async () => {
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onOpenChange = vi.fn();
    const onSave = vi.fn(() => pendingSave);
    const screen = await render(
      <RenameDialog
        open
        title="Rename chat"
        initialValue="First title"
        onOpenChange={onOpenChange}
        onSave={onSave}
      />,
    );

    await page.getByRole("textbox").fill("Unsaved draft");
    await page.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Saving..."));

    await screen.rerender(
      <RenameDialog
        open
        title="Rename chat"
        initialValue="Second title"
        onOpenChange={onOpenChange}
        onSave={onSave}
      />,
    );

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Second title"),
    );
    const saveButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(saveButton?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Saving...");

    resolveSave();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
