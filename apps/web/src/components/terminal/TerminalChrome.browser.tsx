import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { addTerminalTabToGroupLayout, createTerminalGroup } from "../../terminalPaneLayout";
import { resolveTerminalVisualIdentityMap } from "../../terminalVisualIdentity";
import ThreadTerminalDrawer, { TerminalEmptyState } from "../ThreadTerminalDrawer";
import type { ResolvedTerminalGroupLayout } from "./TerminalLayout";
import { TerminalWorkspaceTabBar } from "./TerminalChrome";
import { writeTerminalDragPayload } from "./terminalDragAndDrop";
import TerminalViewportPane from "./TerminalViewportPane";

function resolvedGroup(
  id: string,
  terminalId: string,
  metadata: Parameters<typeof createTerminalGroup>[2],
): ResolvedTerminalGroupLayout {
  return { ...createTerminalGroup(id, terminalId, metadata), terminalIds: [terminalId] };
}

describe("TerminalWorkspaceTabBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("exposes semantic status, direct archive, and archived restore controls", async () => {
    await page.viewport(1_200, 800);
    const onArchiveGroup = vi.fn();
    const onRestoreGroup = vi.fn();
    await render(
      <TerminalWorkspaceTabBar
        terminalGroups={[
          resolvedGroup("development", "dev", { name: "Development", role: "app" }),
        ]}
        archivedTerminalGroups={[
          resolvedGroup("logs", "logs-terminal", {
            name: "Logs",
            role: "observe",
            archivedAt: 100,
            originalIndex: 1,
          }),
        ]}
        activeGroupId="development"
        showArchived
        runningTerminalIds={["dev"]}
        terminalAttentionStatesById={{}}
        terminalExitStatesById={{}}
        terminalVisualIdentityById={new Map()}
        actions={[]}
        onActiveGroupChange={vi.fn()}
        onArchiveGroup={onArchiveGroup}
        onRestoreGroup={onRestoreGroup}
        onCloseGroup={vi.fn()}
      />,
    );

    await expect.element(page.getByRole("tab", { name: /Development, 1 running/ })).toBeVisible();
    expect(
      document.querySelector('[data-terminal-group-id="development"]')?.getAttribute("aria-controls"),
    ).toBe("terminal-group-panel-development");
    await page.getByRole("button", { name: "Archive Development" }).click();
    expect(onArchiveGroup).toHaveBeenCalledWith("development");
    await page.getByRole("button", { name: "Restore" }).click();
    expect(onRestoreGroup).toHaveBeenCalledWith("logs");
    await expect.element(page.getByTitle(/Archived/)).toBeVisible();
  });

  it("keeps the lifecycle drawer module loadable in Chromium", () => {
    expect(ThreadTerminalDrawer).toBeTypeOf("function");
  });

  it("routes terminal and group drops plus the keyboard new-group action", async () => {
    await page.viewport(1_200, 800);
    const onMoveTerminalsToGroup = vi.fn();
    const onMoveTerminalsToNewGroup = vi.fn();
    const onReorderGroup = vi.fn();
    await render(
      <TerminalWorkspaceTabBar
        terminalGroups={[
          resolvedGroup("one", "terminal-one", { name: "One" }),
          resolvedGroup("two", "terminal-two", { name: "Two" }),
        ]}
        activeGroupId="one"
        terminalVisualIdentityById={new Map()}
        actions={[]}
        selectedTerminalIds={["terminal-one", "terminal-extra"]}
        onActiveGroupChange={vi.fn()}
        onMoveTerminalsToGroup={onMoveTerminalsToGroup}
        onMoveTerminalsToNewGroup={onMoveTerminalsToNewGroup}
        onReorderGroup={onReorderGroup}
        onCloseGroup={vi.fn()}
      />,
    );

    const terminalTransfer = new DataTransfer();
    writeTerminalDragPayload(terminalTransfer, {
      kind: "terminals",
      terminalIds: ["terminal-one", "terminal-extra"],
    });
    document
      .querySelector<HTMLElement>('[data-terminal-group-id="two"]')
      ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: terminalTransfer }));
    expect(onMoveTerminalsToGroup).toHaveBeenCalledWith(
      ["terminal-one", "terminal-extra"],
      "two",
    );

    const groupTransfer = new DataTransfer();
    writeTerminalDragPayload(groupTransfer, { kind: "group", groupId: "one" });
    document
      .querySelector<HTMLElement>('[data-terminal-group-id="two"]')
      ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: groupTransfer }));
    expect(onReorderGroup).toHaveBeenCalledWith("one", 1);

    expect(document.querySelectorAll("[data-terminal-new-group-drop-target]")).toHaveLength(3);
    document
      .querySelector<HTMLElement>('[data-terminal-new-group-index="1"]')
      ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: terminalTransfer }));
    expect(onMoveTerminalsToNewGroup).toHaveBeenCalledWith(
      ["terminal-one", "terminal-extra"],
      1,
    );

    await page
      .getByRole("button", { name: "Move selected terminals to new group", exact: true })
      .click();
    expect(onMoveTerminalsToNewGroup).toHaveBeenLastCalledWith(
      ["terminal-one", "terminal-extra"],
      2,
    );
  });

  it("drops selected terminals onto an exact target tab", async () => {
    const onTerminalDrop = vi.fn();
    const group = addTerminalTabToGroupLayout(
      createTerminalGroup("group", "target"),
      "target",
      "source",
    );
    await render(
      <TerminalViewportPane
        groupId="group"
        layout={group.layout}
        resolvedActiveTerminalId="target"
        terminalVisualIdentityById={new Map()}
        selectedTerminalIds={new Set(["source"])}
        onTerminalDrop={onTerminalDrop}
        onActiveTerminalChange={vi.fn()}
        onResizeSplit={vi.fn()}
        presentationMode="drawer"
        renderViewport={() => <div />}
      />,
    );

    const transfer = new DataTransfer();
    writeTerminalDragPayload(transfer, { kind: "terminals", terminalIds: ["source"] });
    document
      .querySelector<HTMLElement>('[data-terminal-tab-id="target"]')
      ?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    expect(onTerminalDrop).toHaveBeenCalledWith(["source"], "target");
  });

  it("renders stopped and failed terminal tabs visibly and accessibly", async () => {
    const group = addTerminalTabToGroupLayout(
      createTerminalGroup("group", "stopped"),
      "stopped",
      "failed",
    );
    const identities = resolveTerminalVisualIdentityMap({
      terminalIds: ["stopped", "failed"],
      runningTerminalIds: [],
      terminalAttentionStatesById: {},
      terminalExitStatesById: {
        stopped: { kind: "stopped", exitCode: 0, exitSignal: null },
        failed: { kind: "failed", exitCode: null, exitSignal: "9" },
      },
      terminalCliKindsById: {},
      terminalLabelsById: { stopped: "Stopped shell", failed: "Failed build" },
      terminalTitleOverridesById: {},
    });
    await render(
      <TerminalViewportPane
        groupId="group"
        layout={group.layout}
        resolvedActiveTerminalId="stopped"
        terminalVisualIdentityById={identities}
        onActiveTerminalChange={vi.fn()}
        onResizeSplit={vi.fn()}
        presentationMode="drawer"
        renderViewport={() => <div />}
      />,
    );

    await expect.element(
      page.getByRole("button", { name: "Stopped shell, Stopped", exact: true }),
    ).toBeVisible();
    await expect.element(
      page.getByRole("button", { name: "Failed build, Failed", exact: true }),
    ).toBeVisible();
    expect(
      document.querySelector('[data-terminal-tab-id="stopped"]')?.getAttribute("data-terminal-state"),
    ).toBe("stopped");
    expect(
      document.querySelector('[data-terminal-tab-id="failed"]')?.getAttribute("data-terminal-state"),
    ).toBe("failed");
    expect(document.querySelector('[data-terminal-visual-state="stopped"]')).not.toBeNull();
    expect(document.querySelector('[data-terminal-visual-state="failed"]')).not.toBeNull();
  });

  it("offers narrow keyboard-operable moves to another or new group with status labels", async () => {
    await page.viewport(390, 800);
    const onMoveTerminalsToGroup = vi.fn();
    const onMoveTerminalsToNewGroup = vi.fn();
    await render(
      <TerminalWorkspaceTabBar
        terminalGroups={[
          resolvedGroup("one", "terminal-one", { name: "One" }),
          resolvedGroup("two", "terminal-two", { name: "Two" }),
        ]}
        activeGroupId="one"
        terminalVisualIdentityById={new Map()}
        terminalExitStatesById={{
          "terminal-two": { kind: "stopped", exitCode: 0, exitSignal: null },
        }}
        actions={[]}
        selectedTerminalIds={["terminal-one"]}
        onActiveGroupChange={vi.fn()}
        onMoveTerminalsToGroup={onMoveTerminalsToGroup}
        onMoveTerminalsToNewGroup={onMoveTerminalsToNewGroup}
        onCloseGroup={vi.fn()}
      />,
    );

    expect(document.querySelector('option[value="two"]')?.textContent).toBe("Two — 1 stopped");
    await page.getByRole("button", { name: "Manage One" }).click();
    await page
      .getByRole("menuitem", { name: "Move 1 selected to Two — 1 stopped", exact: true })
      .click();
    expect(onMoveTerminalsToGroup).toHaveBeenCalledWith(["terminal-one"], "two");

    await page.getByRole("button", { name: "Manage One" }).click();
    await page
      .getByRole("menuitem", { name: "Move 1 selected to new group", exact: true })
      .click();
    expect(onMoveTerminalsToNewGroup).toHaveBeenCalledWith(["terminal-one"]);
  });

  it("renders the true no-groups CTA without a replacement terminal tab", async () => {
    const onNewGroup = vi.fn();
    await render(<TerminalEmptyState onRestoreGroup={vi.fn()} onNewGroup={onNewGroup} />);

    await expect.element(page.getByText("No terminal groups", { exact: true })).toBeVisible();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
    await page.getByRole("button", { name: "New group" }).click();
    expect(onNewGroup).toHaveBeenCalledOnce();
  });
});
