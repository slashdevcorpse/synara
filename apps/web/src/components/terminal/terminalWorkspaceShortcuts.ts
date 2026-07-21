export type TerminalWorkspaceShortcutCommand =
  | "archive-active-group"
  | "restore-recent-group"
  | "toggle-archived-groups"
  | "previous-group"
  | "next-group"
  | "move-group-left"
  | "move-group-right";

export function resolveTerminalWorkspaceShortcut(input: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): TerminalWorkspaceShortcutCommand | null {
  if (!input.altKey || input.ctrlKey || input.metaKey) return null;
  if (input.shiftKey) {
    if (input.key.toLowerCase() === "a") return "archive-active-group";
    if (input.key.toLowerCase() === "r") return "restore-recent-group";
    if (input.key.toLowerCase() === "h") return "toggle-archived-groups";
    if (input.key === "ArrowLeft") return "move-group-left";
    if (input.key === "ArrowRight") return "move-group-right";
    return null;
  }
  if (input.key === "ArrowLeft") return "previous-group";
  if (input.key === "ArrowRight") return "next-group";
  return null;
}
