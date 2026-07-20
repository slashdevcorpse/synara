// FILE: SidebarSegmentedPicker.browser.tsx
// Purpose: Browser regressions for optimistic sidebar segment selection.
// Layer: Browser UI test

import "../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { resolveSidebarWorkspaceRoute, SidebarSegmentedPicker } from "./Sidebar";
import type { SidebarView } from "./Sidebar.logic";

function selectedSegment(): string | null {
  return (
    document.querySelector<HTMLButtonElement>(
      '.sidebar-segmented-picker button[aria-pressed="true"]',
    )?.textContent ?? null
  );
}

describe("SidebarSegmentedPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not revive a landed optimistic view after browser back", async () => {
    function Harness() {
      const [activeView, setActiveView] = useState<SidebarView>("threads");
      return (
        <>
          <button type="button" onClick={() => setActiveView("studio")}>
            Land route
          </button>
          <button type="button" onClick={() => setActiveView("threads")}>
            Browser back
          </button>
          <SidebarSegmentedPicker
            views={["studio", "threads"]}
            activeView={activeView}
            onSelectView={() => undefined}
          />
        </>
      );
    }

    await render(<Harness />);
    expect(selectedSegment()).toBe("Projects");

    await page.getByRole("button", { name: "Studio" }).click();
    expect(selectedSegment()).toBe("Studio");

    await page.getByRole("button", { name: "Land route" }).click();
    expect(selectedSegment()).toBe("Studio");

    await page.getByRole("button", { name: "Browser back" }).click();
    expect(selectedSegment()).toBe("Projects");
  });

  it("keeps the dashboard on Projects when the terminal Workspace segment is hidden", async () => {
    const route = resolveSidebarWorkspaceRoute("/workspace");

    await render(
      <SidebarSegmentedPicker
        views={["studio", "threads"]}
        activeView={route.isTerminalWorkspace ? "workspace" : "threads"}
        onSelectView={() => undefined}
      />,
    );

    expect(selectedSegment()).toBe("Projects");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent === "Workspace",
      ),
    ).toBe(false);
  });
});
