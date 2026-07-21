// FILE: TerminalLayout.ts
// Purpose: Pure layout resolution for terminal pane tabs, pane trees, and visual identities.
// Layer: Terminal view-model helpers
// Depends on: shared terminal identity logic plus terminal pane-tree helpers.

import {
  type ResolvedTerminalVisualIdentity,
  type TerminalCliKind,
} from "@synara/shared/terminalThreads";

import { resolveTerminalVisualIdentityMap } from "../../terminalVisualIdentity";
import {
  collectTerminalIdsFromLayout,
  createTerminalGroup,
  findFirstTerminalIdInLayout,
  normalizeTerminalPaneGroup,
} from "../../terminalPaneLayout";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type TerminalExitState,
  type NormalizedThreadTerminalGroup,
  type ThreadTerminalGroup,
  type ThreadTerminalLayoutNode,
} from "../../types";

export interface ResolvedTerminalGroupLayout extends NormalizedThreadTerminalGroup {
  terminalIds: string[];
}

export interface ResolvedThreadTerminalLayout {
  normalizedTerminalIds: string[];
  resolvedActiveTerminalId: string;
  resolvedActiveGroupId: string | null;
  resolvedTerminalGroups: ResolvedTerminalGroupLayout[];
  resolvedArchivedTerminalGroups: ResolvedTerminalGroupLayout[];
  activeGroupLayout: ThreadTerminalLayoutNode | null;
  visibleTerminalIds: string[];
  hasTerminalSidebar: boolean;
  isSplitView: boolean;
  showGroupHeaders: boolean;
  hasReachedSplitLimit: boolean;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
}

function assignUniqueGroupId(groupId: string, usedGroupIds: Set<string>): string {
  if (!usedGroupIds.has(groupId)) {
    usedGroupIds.add(groupId);
    return groupId;
  }
  let suffix = 2;
  while (usedGroupIds.has(`${groupId}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueGroupId = `${groupId}-${suffix}`;
  usedGroupIds.add(uniqueGroupId);
  return uniqueGroupId;
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function resolveTerminalGroups(input: {
  normalizedTerminalIds: string[];
  terminalGroups: ThreadTerminalGroup[];
}): ResolvedTerminalGroupLayout[] {
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const nextGroups: ResolvedTerminalGroupLayout[] = [];

  for (const terminalGroup of input.terminalGroups) {
    const normalizedGroup = normalizeTerminalPaneGroup(terminalGroup, input.normalizedTerminalIds);
    if (!normalizedGroup) continue;
    const groupTerminalIds = collectTerminalIdsFromLayout(normalizedGroup.layout).filter(
      (terminalId) => {
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      },
    );
    if (groupTerminalIds.length === 0) continue;
    const filteredGroup = normalizeTerminalPaneGroup(normalizedGroup, groupTerminalIds);
    if (!filteredGroup) continue;
    const groupId = assignUniqueGroupId(filteredGroup.id, usedGroupIds);
    collectTerminalIdsFromLayout(filteredGroup.layout).forEach((terminalId) => {
      assignedTerminalIds.add(terminalId);
    });
    nextGroups.push({
      ...filteredGroup,
      id: groupId,
      terminalIds: collectTerminalIdsFromLayout(filteredGroup.layout),
    });
  }

  for (const terminalId of input.normalizedTerminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    const id = assignUniqueGroupId(`group-${terminalId}`, usedGroupIds);
    nextGroups.push({
      ...createTerminalGroup(id, terminalId),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length > 0) {
    return nextGroups;
  }

  if (input.normalizedTerminalIds.length === 0) return [];

  return [
    {
      ...createTerminalGroup(
        `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        DEFAULT_THREAD_TERMINAL_ID,
      ),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ];
}

function resolveActiveGroup(input: {
  activeTerminalGroupId: string;
  activeTerminalId: string;
  resolvedTerminalGroups: ResolvedTerminalGroupLayout[];
}): ResolvedTerminalGroupLayout | null {
  return (
    input.resolvedTerminalGroups.find(
      (terminalGroup) => terminalGroup.id === input.activeTerminalGroupId,
    ) ??
    input.resolvedTerminalGroups.find((terminalGroup) =>
      terminalGroup.terminalIds.includes(input.activeTerminalId),
    ) ??
    input.resolvedTerminalGroups[0] ??
    null
  );
}

export function resolveThreadTerminalLayout(input: {
  activeTerminalGroupId: string;
  activeTerminalId: string;
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  terminalExitStatesById?: Record<string, TerminalExitState> | undefined;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalGroups: ThreadTerminalGroup[];
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): ResolvedThreadTerminalLayout {
  const normalizedTerminalIds = normalizeTerminalIds(input.terminalIds);
  const resolvedGroups = resolveTerminalGroups({
    normalizedTerminalIds,
    terminalGroups: input.terminalGroups,
  });
  const resolvedTerminalGroups = resolvedGroups.filter((group) => group.archivedAt === null);
  const resolvedArchivedTerminalGroups = resolvedGroups.filter(
    (group) => group.archivedAt !== null,
  );
  const activeGroup = resolveActiveGroup({
    activeTerminalGroupId: input.activeTerminalGroupId,
    activeTerminalId: input.activeTerminalId,
    resolvedTerminalGroups,
  });
  const resolvedActiveTerminalId = activeGroup?.terminalIds.includes(input.activeTerminalId)
    ? input.activeTerminalId
    : activeGroup?.terminalIds.includes(activeGroup.activeTerminalId)
      ? activeGroup.activeTerminalId
      : activeGroup
        ? findFirstTerminalIdInLayout(activeGroup.layout)
        : input.activeTerminalId;
  const visibleTerminalIds = activeGroup?.terminalIds ?? [];
  const hasTerminalSidebar = false;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 0 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalVisualIdentityById = resolveTerminalVisualIdentityMap({
    terminalIds: normalizedTerminalIds,
    runningTerminalIds: input.runningTerminalIds,
    terminalAttentionStatesById: input.terminalAttentionStatesById,
    terminalCliKindsById: input.terminalCliKindsById,
    terminalLabelsById: input.terminalLabelsById,
    terminalTitleOverridesById: input.terminalTitleOverridesById,
    terminalExitStatesById: input.terminalExitStatesById,
  });

  return {
    normalizedTerminalIds,
    resolvedActiveTerminalId,
    resolvedActiveGroupId: activeGroup?.id ?? null,
    resolvedTerminalGroups,
    resolvedArchivedTerminalGroups,
    activeGroupLayout: activeGroup?.layout ?? null,
    visibleTerminalIds,
    hasTerminalSidebar,
    isSplitView,
    showGroupHeaders,
    hasReachedSplitLimit,
    terminalVisualIdentityById,
  };
}
