// FILE: contextMenu.test.ts
// Purpose: Verifies disabled context-menu items survive normalization and native template creation.

import type { ContextMenuItem } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildContextMenuTemplate, normalizeContextMenuItems } from "./contextMenu";

describe("normalizeContextMenuItems", () => {
  it("preserves disabled state and defaults omitted flags to false", () => {
    expect(
      normalizeContextMenuItems([
        { id: "archive", label: "Archive (2)", disabled: true },
        { id: "delete", label: "Delete (2)", destructive: true },
      ]),
    ).toEqual([
      {
        id: "archive",
        label: "Archive (2)",
        separatorBefore: false,
        destructive: false,
        disabled: true,
      },
      {
        id: "delete",
        label: "Delete (2)",
        separatorBefore: false,
        destructive: true,
        disabled: false,
      },
    ]);
  });

  it("drops malformed rows before building a native menu", () => {
    const malformedItems = [
      { id: 42, label: "Wrong id" },
      { id: "missing-label" },
      { id: "valid", label: "Valid" },
    ] as unknown as readonly ContextMenuItem[];

    expect(normalizeContextMenuItems(malformedItems)).toEqual([
      {
        id: "valid",
        label: "Valid",
        separatorBefore: false,
        destructive: false,
        disabled: false,
      },
    ]);
  });
});

describe("buildContextMenuTemplate", () => {
  it("disables unavailable rows and never resolves them", () => {
    const onSelect = vi.fn();
    const template = buildContextMenuTemplate({
      items: normalizeContextMenuItems([
        { id: "mark-unread", label: "Mark unread (2)" },
        { id: "archive", label: "Archive (2)", disabled: true },
        { id: "delete", label: "Delete (2)", destructive: true },
      ]),
      onSelect,
    });

    expect(template.map((item) => item.type ?? "normal")).toEqual([
      "normal",
      "normal",
      "separator",
      "normal",
    ]);
    expect(template[1]?.enabled).toBe(false);
    expect(template[3]?.enabled).toBe(true);

    template[1]?.click?.({} as never, {} as never, {} as never);
    expect(onSelect).not.toHaveBeenCalled();

    template[3]?.click?.({} as never, {} as never, {} as never);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("delete");
  });
});
