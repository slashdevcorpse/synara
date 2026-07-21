import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { ComposerSubagentStrip } from "./ComposerSubagentStrip";
import { ComposerColumnFrame } from "./ComposerColumnFrame";
import type { ComposerSubagentStripItem } from "./ComposerSubagentStrip.logic";

function item(key: string, statusKind: "completed" | "failed"): ComposerSubagentStripItem {
  return {
    kind: "subagent",
    key,
    threadId: ThreadId.makeUnsafe(key),
    providerThreadId: key,
    primaryLabel: key,
    fullLabel: key,
    role: null,
    modelLabel: "GPT-5.6",
    statusLabel: statusKind,
    statusKind,
    isActive: false,
    isViewed: false,
    isBackground: false,
    accentColor: "#fff",
  };
}

const SETTLED_ITEMS = [item("completed-child", "completed"), item("failed-child", "failed")];

function Harness({ items = SETTLED_ITEMS }: { items?: readonly ComposerSubagentStripItem[] }) {
  const [compact, setCompact] = useState(false);
  return (
    <ComposerColumnFrame>
      <ComposerSubagentStrip
        items={items}
        compact={compact}
        onCompactChange={setCompact}
        onOpenThread={vi.fn()}
      />
    </ComposerColumnFrame>
  );
}

describe("ComposerSubagentStrip settled details", () => {
  it("auto-compacts once and preserves a user's expansion through equivalent refreshes", async () => {
    const view = await render(<Harness />);

    await expect
      .element(page.getByText("2 subagents settled · 1 completed · 1 failed"))
      .toBeVisible();
    await page.getByRole("button", { name: "Expand subagent strip" }).click();
    await expect
      .element(page.getByRole("button", { name: "Collapse subagent strip" }))
      .toBeVisible();
    await expect.element(page.getByText("completed-child", { exact: true })).toBeVisible();
    await expect.element(page.getByText("failed-child", { exact: true })).toBeVisible();

    await view.rerender(<Harness items={[...SETTLED_ITEMS]} />);
    await expect
      .element(page.getByRole("button", { name: "Collapse subagent strip" }))
      .toBeVisible();
  });
});
