import { describe, expect, it } from "vitest";

import { collectTerminalIdsFromLayout, normalizeTerminalPaneGroup } from "./terminalPaneLayout";

describe("normalizeTerminalPaneGroup", () => {
  it("preserves semantic metadata and exact valid split weights", () => {
    const normalized = normalizeTerminalPaneGroup(
      {
        id: "group-app",
        activeTerminalId: "two",
        name: "Development",
        role: "app",
        icon: "app-window",
        accent: "blue",
        archivedAt: 25,
        originalIndex: 2,
        createdAt: 10,
        updatedAt: 25,
        userNamed: true,
        layout: {
          type: "split",
          id: "split-app",
          direction: "horizontal",
          children: [
            { type: "terminal", paneId: "one-pane", terminalIds: ["one"], activeTerminalId: "one" },
            { type: "terminal", paneId: "two-pane", terminalIds: ["two"], activeTerminalId: "two" },
          ],
          weights: [5, 3],
        },
      },
      ["one", "two"],
    );

    expect(normalized).toMatchObject({
      id: "group-app",
      activeTerminalId: "two",
      name: "Development",
      role: "app",
      icon: "app-window",
      accent: "blue",
      archivedAt: 25,
      originalIndex: 2,
      createdAt: 10,
      updatedAt: 25,
      userNamed: true,
    });
    expect(normalized?.layout).toMatchObject({ weights: [5, 3] });
    expect(normalized && collectTerminalIdsFromLayout(normalized.layout)).toEqual(["one", "two"]);
  });

  it("replaces invalid persisted icon and accent with role presentation defaults", () => {
    const rawGroup = {
      id: "group-verify",
      activeTerminalId: "one",
      name: "Checks",
      role: "verify",
      icon: "invalid-icon",
      accent: "invalid-accent",
      layout: {
        type: "terminal",
        paneId: "one-pane",
        terminalIds: ["one"],
        activeTerminalId: "one",
      },
    } as unknown as Parameters<typeof normalizeTerminalPaneGroup>[0];

    expect(normalizeTerminalPaneGroup(rawGroup, ["one"])).toMatchObject({
      role: "verify",
      icon: "check-circle",
      accent: "green",
    });
  });
});
