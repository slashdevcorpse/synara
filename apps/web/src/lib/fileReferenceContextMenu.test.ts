import { beforeEach, describe, expect, it, vi } from "vitest";

const { showContextMenuMock } = vi.hoisted(() => ({
  showContextMenuMock: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    contextMenu: { show: showContextMenuMock },
  }),
}));

import { showFileReferenceContextMenu } from "./fileReferenceContextMenu";

describe("showFileReferenceContextMenu", () => {
  beforeEach(() => {
    showContextMenuMock.mockReset();
  });

  it("offers and invokes Open in browser only when an HTML action is supplied", async () => {
    const onOpenInBrowser = vi.fn();
    showContextMenuMock.mockResolvedValue("open-in-browser");

    await showFileReferenceContextMenu({
      path: "docs/demo.html",
      position: { x: 10, y: 20 },
      onReferenceInChat: undefined,
      onOpenInBrowser,
    });

    expect(showContextMenuMock.mock.calls[0]?.[0]).toContainEqual({
      id: "open-in-browser",
      label: "Open in browser",
    });
    expect(onOpenInBrowser).toHaveBeenCalledOnce();
  });

  it("omits Open in browser for non-HTML callers", async () => {
    showContextMenuMock.mockResolvedValue(undefined);

    await showFileReferenceContextMenu({
      path: "src/main.ts",
      position: { x: 10, y: 20 },
      onReferenceInChat: undefined,
    });

    expect(showContextMenuMock.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ id: "open-in-browser" }),
    );
  });
});
