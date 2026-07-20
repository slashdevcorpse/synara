// FILE: RenameDialog.browser.tsx
// Purpose: Browser regressions for rename form identity and async saving state.

import "../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RenameDialog } from "./RenameDialog";

function ControlledRenameDialog({
  initialValue,
  onOpenChange,
  onSave,
}: {
  initialValue: string;
  onOpenChange: (open: boolean) => void;
  onSave: (value: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <RenameDialog
      open={open}
      title="Rename chat"
      initialValue={initialValue}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        setOpen(nextOpen);
      }}
      onSave={onSave}
    />
  );
}

describe("RenameDialog", () => {
  it("keeps the replacement form open when the previous save resolves", async () => {
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onOpenChange = vi.fn();
    const onSave = vi.fn(() => pendingSave);
    const screen = await render(
      <ControlledRenameDialog
        initialValue="First title"
        onOpenChange={onOpenChange}
        onSave={onSave}
      />,
    );

    await page.getByRole("textbox").fill("Unsaved draft");
    await page.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Saving..."));

    await screen.rerender(
      <ControlledRenameDialog
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
    await pendingSave;

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Second title");
    expect(document.body.textContent).toContain("Rename chat");
  });

  it("closes after the active form save resolves", async () => {
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onOpenChange = vi.fn();
    const onSave = vi.fn(() => pendingSave);
    await render(
      <RenameDialog
        open
        title="Rename chat"
        initialValue="Current title"
        onOpenChange={onOpenChange}
        onSave={onSave}
      />,
    );

    await page.getByRole("textbox").fill("Updated title");
    await page.getByRole("button", { name: "Save" }).click();
    resolveSave();

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false));
  });
});
