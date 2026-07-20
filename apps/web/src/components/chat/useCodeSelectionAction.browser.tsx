// FILE: useCodeSelectionAction.browser.tsx
// Purpose: Browser lifecycle regressions for read-only code selection actions.

import "../../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCodeSelectionAction } from "./useCodeSelectionAction";

describe("useCodeSelectionAction", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not revive a pending action after disable and re-enable", async () => {
    function Harness() {
      const [enabled, setEnabled] = useState(true);
      const action = useCodeSelectionAction({
        enabled,
        readSelection: () => "selected payload",
        onCommit: vi.fn(),
      });
      return (
        <>
          <button type="button" onClick={() => setEnabled(false)}>
            Disable
          </button>
          <button type="button" onClick={() => setEnabled(true)}>
            Enable
          </button>
          <div data-testid="selection-surface" onMouseUp={action.onContainerMouseUp}>
            selectable text
          </div>
          <output data-testid="pending-action">{action.pendingAction?.payload ?? "none"}</output>
        </>
      );
    }

    await render(<Harness />);
    document
      .querySelector<HTMLElement>('[data-testid="selection-surface"]')
      ?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 100 }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="pending-action"]')?.textContent).toBe(
        "selected payload",
      ),
    );

    await page.getByRole("button", { name: "Disable" }).click();
    await page.getByRole("button", { name: "Enable" }).click();

    expect(document.querySelector('[data-testid="pending-action"]')?.textContent).toBe("none");
  });
});
