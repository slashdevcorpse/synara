export interface TerminalTabSelection {
  anchorId: string | null;
  selectedIds: Set<string>;
}

export function updateTerminalTabSelection(input: {
  orderedTerminalIds: readonly string[];
  selection: TerminalTabSelection;
  terminalId: string;
  shiftKey: boolean;
  toggleKey: boolean;
}): TerminalTabSelection {
  if (!input.orderedTerminalIds.includes(input.terminalId)) return input.selection;

  if (input.shiftKey && input.selection.anchorId) {
    const anchorIndex = input.orderedTerminalIds.indexOf(input.selection.anchorId);
    const terminalIndex = input.orderedTerminalIds.indexOf(input.terminalId);
    if (anchorIndex >= 0 && terminalIndex >= 0) {
      const range = input.orderedTerminalIds.slice(
        Math.min(anchorIndex, terminalIndex),
        Math.max(anchorIndex, terminalIndex) + 1,
      );
      return {
        anchorId: input.selection.anchorId,
        selectedIds: input.toggleKey
          ? new Set([...input.selection.selectedIds, ...range])
          : new Set(range),
      };
    }
  }

  if (input.toggleKey) {
    const selectedIds = new Set(input.selection.selectedIds);
    if (selectedIds.has(input.terminalId)) selectedIds.delete(input.terminalId);
    else selectedIds.add(input.terminalId);
    return { anchorId: input.terminalId, selectedIds };
  }

  return { anchorId: input.terminalId, selectedIds: new Set([input.terminalId]) };
}

export function pruneTerminalTabSelection(
  selection: TerminalTabSelection,
  validTerminalIds: readonly string[],
): TerminalTabSelection {
  const validIds = new Set(validTerminalIds);
  const selectedIds = new Set([...selection.selectedIds].filter((id) => validIds.has(id)));
  const anchorId = selection.anchorId && validIds.has(selection.anchorId) ? selection.anchorId : null;
  if (selectedIds.size === selection.selectedIds.size && anchorId === selection.anchorId) {
    return selection;
  }
  return { anchorId, selectedIds };
}
