// FILE: contextMenuFallback.browser.ts
// Purpose: Browser regressions for disabled fallback context-menu pointer and keyboard behavior.
// Layer: Web DOM behavior tests

import "../index.css";

import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";

import {
  archiveSelectedThreadEntriesAndReconcileSelection,
  shouldClearThreadSelectionOnMouseDown,
} from "../components/Sidebar.logic";
import { showContextMenuFallback } from "../contextMenuFallback";
import { useThreadSelectionStore } from "../threadSelectionStore";

function menuButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) {
    throw new Error(`Missing context-menu button: ${label}`);
  }
  return button;
}

describe("showContextMenuFallback", () => {
  afterEach(() => {
    useThreadSelectionStore.getState().clearSelection();
    document.body.replaceChildren();
  });

  it("renders disabled rows semantically and ignores their clicks", async () => {
    let settledValue: string | null | undefined;
    const result = showContextMenuFallback([
      { id: "archive", label: "Archive (2)", disabled: true },
      { id: "delete", label: "Delete (2)" },
    ]);
    void result.then((value) => {
      settledValue = value;
    });

    const archiveButton = menuButton("Archive (2)");
    expect(archiveButton.disabled).toBe(true);
    expect(shouldClearThreadSelectionOnMouseDown(archiveButton)).toBe(false);
    archiveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(settledValue).toBeUndefined();

    menuButton("Delete (2)").click();
    await expect(result).resolves.toBe("delete");
  });

  it("drives a bulk archive outcome without clearing a newer selection", async () => {
    const first = ThreadId.makeUnsafe("thread-first");
    const second = ThreadId.makeUnsafe("thread-second");
    const newlySelected = ThreadId.makeUnsafe("thread-newly-selected");
    const selectionStore = useThreadSelectionStore.getState();
    selectionStore.toggleThread(first);
    selectionStore.toggleThread(second);

    const clearUnsafeSelection = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (shouldClearThreadSelectionOnMouseDown(target)) {
        useThreadSelectionStore.getState().clearSelection();
      }
    };
    window.addEventListener("mousedown", clearUnsafeSelection);

    try {
      const result = showContextMenuFallback([
        { id: "archive", label: "Archive (2)" },
        { id: "delete", label: "Delete (2)" },
      ]);

      await page.getByRole("button", { name: "Archive (2)" }).click();
      await expect(result).resolves.toBe("archive");
      expect([...useThreadSelectionStore.getState().selectedThreadIds]).toEqual([first, second]);

      let releaseFirstArchive: (() => void) | undefined;
      const firstArchiveGate = new Promise<void>((resolve) => {
        releaseFirstArchive = resolve;
      });
      const pendingOutcome = archiveSelectedThreadEntriesAndReconcileSelection({
        entries: [first, second],
        archive: async (threadId, onArchived) => {
          if (threadId === first) {
            await firstArchiveGate;
          }
          onArchived();
          return true;
        },
        removeFromSelection: (threadIds) => {
          useThreadSelectionStore.getState().removeFromSelection(threadIds);
        },
      });

      // The menu snapshot remains in flight while the user selects a different row.
      useThreadSelectionStore.getState().toggleThread(newlySelected);
      releaseFirstArchive?.();
      const outcome = await pendingOutcome;

      expect(outcome.archivedThreadIds).toEqual([first, second]);
      expect([...useThreadSelectionStore.getState().selectedThreadIds]).toEqual([newlySelected]);
    } finally {
      window.removeEventListener("mousedown", clearUnsafeSelection);
    }
  });

  it("keeps outside-menu dismissal outside the selection-safe boundary", async () => {
    const selected = ThreadId.makeUnsafe("thread-selected");
    useThreadSelectionStore.getState().toggleThread(selected);

    const clearUnsafeSelection = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (shouldClearThreadSelectionOnMouseDown(target)) {
        useThreadSelectionStore.getState().clearSelection();
      }
    };
    window.addEventListener("mousedown", clearUnsafeSelection);

    try {
      const result = showContextMenuFallback([{ id: "archive", label: "Archive (1)" }]);
      const menu = menuButton("Archive (1)").closest<HTMLElement>("[data-thread-selection-safe]");
      const overlay = menu?.previousElementSibling;
      if (!(overlay instanceof HTMLElement)) {
        throw new Error("Missing context-menu dismissal overlay");
      }

      overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

      await expect(result).resolves.toBeNull();
      expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(0);
    } finally {
      window.removeEventListener("mousedown", clearUnsafeSelection);
    }
  });

  it("skips disabled rows during keyboard navigation and activation", async () => {
    const result = showContextMenuFallback([
      { id: "mark-unread", label: "Mark unread (3)" },
      { id: "archive", label: "Archive (3)", disabled: true },
      { id: "delete", label: "Delete (3)" },
    ]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement).toBe(menuButton("Mark unread (3)"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement).toBe(menuButton("Delete (3)"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await expect(result).resolves.toBe("delete");
  });
});
