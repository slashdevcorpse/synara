// FILE: threadSidebarWidth.browser.tsx
// Purpose: Browser lifecycle regressions for persisted thread-sidebar width.
// Layer: Browser UI test

import "../index.css";

import * as Schema from "effect/Schema";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";
import { Sidebar, SidebarProvider, SidebarTrigger } from "./ui/sidebar";
import { THREAD_SIDEBAR_WIDTH_STORAGE_KEY } from "./threadSidebarWidth";
import { useThreadSidebarWidth } from "./useThreadSidebarWidth";

function ThreadSidebarWidthHarness() {
  const { providerStyle, resizable } = useThreadSidebarWidth();
  return (
    <SidebarProvider style={providerStyle}>
      <SidebarTrigger />
      <Sidebar side="left" collapsible="offcanvas" resizable={resizable}>
        <div>Thread sidebar</div>
      </Sidebar>
    </SidebarProvider>
  );
}

function getSidebarWrapper(): HTMLElement {
  const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
  if (!wrapper) {
    throw new Error("Thread sidebar wrapper was not rendered.");
  }
  return wrapper;
}

afterEach(async () => {
  removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  await page.viewport(1_200, 800);
});

describe("thread sidebar width lifecycle", () => {
  it("renders the stored width in the provider's initial inline style", async () => {
    await page.viewport(1_200, 800);
    setLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, 420, Schema.Finite);
    const screen = await render(<ThreadSidebarWidthHarness />);

    try {
      expect(getSidebarWrapper().style.getPropertyValue("--sidebar-width")).toBe("420px");
    } finally {
      await screen.unmount();
    }
  });

  it("clamps while narrow without overwriting the preference and reapplies it when widened", async () => {
    await page.viewport(1_200, 800);
    setLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, 500, Schema.Finite);
    const screen = await render(<ThreadSidebarWidthHarness />);

    try {
      expect(getSidebarWrapper().style.getPropertyValue("--sidebar-width")).toBe("500px");

      await page.viewport(900, 800);
      await vi.waitFor(() => {
        expect(getSidebarWrapper().style.getPropertyValue("--sidebar-width")).toBe("260px");
      });
      expect(getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite)).toBe(500);

      await page.viewport(1_200, 800);
      await vi.waitFor(() => {
        expect(getSidebarWrapper().style.getPropertyValue("--sidebar-width")).toBe("500px");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("removes its viewport listener when the provider lifecycle unmounts", async () => {
    await page.viewport(1_200, 800);
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const screen = await render(<ThreadSidebarWidthHarness />);
    const resizeRegistration = addEventListener.mock.calls.find(([type]) => type === "resize");

    try {
      expect(resizeRegistration).toBeDefined();
    } finally {
      await screen.unmount();
    }
    expect(removeEventListener).toHaveBeenCalledWith("resize", resizeRegistration?.[1]);
  });

  it("keeps the mobile sheet width override instead of the desktop persisted width", async () => {
    await page.viewport(600, 800);
    setLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, 500, Schema.Finite);
    const screen = await render(<ThreadSidebarWidthHarness />);

    try {
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await expect
        .poll(() => document.querySelector<HTMLElement>("[data-mobile='true']"))
        .not.toBeNull();
      const mobileSidebar = document.querySelector<HTMLElement>("[data-mobile='true']");
      expect(mobileSidebar?.style.getPropertyValue("--sidebar-width")).toBe(
        "calc(100vw - var(--spacing) * 3)",
      );
    } finally {
      await screen.unmount();
    }
  });
});
