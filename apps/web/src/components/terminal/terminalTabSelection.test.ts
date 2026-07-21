import { describe, expect, it } from "vitest";

import { pruneTerminalTabSelection, updateTerminalTabSelection } from "./terminalTabSelection";

const ORDER = ["one", "two", "three", "four"];

describe("terminal tab selection", () => {
  it("supports plain selection, modifier toggles, and stable shift ranges", () => {
    let selection = updateTerminalTabSelection({
      orderedTerminalIds: ORDER,
      selection: { anchorId: null, selectedIds: new Set() },
      terminalId: "two",
      shiftKey: false,
      toggleKey: false,
    });
    selection = updateTerminalTabSelection({
      orderedTerminalIds: ORDER,
      selection,
      terminalId: "four",
      shiftKey: true,
      toggleKey: false,
    });
    expect([...selection.selectedIds]).toEqual(["two", "three", "four"]);
    expect(selection.anchorId).toBe("two");

    selection = updateTerminalTabSelection({
      orderedTerminalIds: ORDER,
      selection,
      terminalId: "three",
      shiftKey: false,
      toggleKey: true,
    });
    expect([...selection.selectedIds]).toEqual(["two", "four"]);
  });

  it("prunes selections and anchors when drawer membership changes", () => {
    expect(
      pruneTerminalTabSelection({ anchorId: "three", selectedIds: new Set(["one", "three"]) }, [
        "one",
        "two",
      ]),
    ).toEqual({ anchorId: null, selectedIds: new Set(["one"]) });
  });
});
