import { describe, expect, it } from "vitest";

import { resolveTerminalWorkspaceShortcut } from "./terminalWorkspaceShortcuts";

function resolve(key: string, shiftKey = false, code = key) {
  return resolveTerminalWorkspaceShortcut({
    key,
    code,
    altKey: true,
    shiftKey,
    ctrlKey: false,
    metaKey: false,
  });
}

describe("terminal workspace shortcuts", () => {
  it("maps lifecycle and navigation commands", () => {
    expect(resolve("å", true, "KeyA")).toBe("archive-active-group");
    expect(resolve("®", true, "KeyR")).toBe("restore-recent-group");
    expect(resolve("˛", true, "KeyH")).toBe("toggle-archived-groups");
    expect(resolve("ArrowLeft")).toBe("previous-group");
    expect(resolve("ArrowRight")).toBe("next-group");
    expect(resolve("ArrowLeft", true)).toBe("move-group-left");
    expect(resolve("ArrowRight", true)).toBe("move-group-right");
  });

  it("does not claim unrelated or Ctrl/Meta-modified keys", () => {
    expect(resolve("Enter")).toBeNull();
    expect(
      resolveTerminalWorkspaceShortcut({
        key: "ArrowRight",
        code: "ArrowRight",
        altKey: true,
        shiftKey: false,
        ctrlKey: true,
        metaKey: false,
      }),
    ).toBeNull();
  });
});
