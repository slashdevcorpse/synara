export const TERMINAL_DRAG_MIME = "application/x-synara-terminal-drag+json";

export type TerminalDragPayload =
  | { kind: "terminals"; terminalIds: string[] }
  | { kind: "group"; groupId: string };

function normalizeTerminalIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const terminalIds = [...new Set(value)]
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return terminalIds.length > 0 ? terminalIds : null;
}

export function writeTerminalDragPayload(
  dataTransfer: DataTransfer,
  payload: TerminalDragPayload,
): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(TERMINAL_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.setData("text/plain", payload.kind === "group" ? payload.groupId : payload.terminalIds.join(","));
}

export function readTerminalDragPayload(
  dataTransfer: Pick<DataTransfer, "getData">,
): TerminalDragPayload | null {
  const serialized = dataTransfer.getData(TERMINAL_DRAG_MIME);
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (value.kind === "group" && typeof value.groupId === "string" && value.groupId.trim()) {
      return { kind: "group", groupId: value.groupId.trim() };
    }
    if (value.kind === "terminals") {
      const terminalIds = normalizeTerminalIds(value.terminalIds);
      return terminalIds ? { kind: "terminals", terminalIds } : null;
    }
  } catch {
    return null;
  }
  return null;
}
