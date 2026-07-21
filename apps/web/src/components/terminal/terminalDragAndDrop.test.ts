import { describe, expect, it } from "vitest";

import {
  readTerminalDragPayload,
  TERMINAL_DRAG_MIME,
  writeTerminalDragPayload,
} from "./terminalDragAndDrop";

describe("terminal drag payloads", () => {
  it("round-trips a deduplicated terminal selection", () => {
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    } as unknown as DataTransfer;

    writeTerminalDragPayload(dataTransfer, {
      kind: "terminals",
      terminalIds: ["one", "two", "one"],
    });

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(readTerminalDragPayload(dataTransfer)).toEqual({
      kind: "terminals",
      terminalIds: ["one", "two"],
    });
  });

  it("rejects malformed and empty payloads", () => {
    expect(readTerminalDragPayload({ getData: () => "not-json" })).toBeNull();
    expect(
      readTerminalDragPayload({
        getData: (type) =>
          type === TERMINAL_DRAG_MIME ? JSON.stringify({ kind: "terminals", terminalIds: [] }) : "",
      }),
    ).toBeNull();
  });
});
