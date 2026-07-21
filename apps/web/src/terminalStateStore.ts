/**
 * Single Zustand store for terminal UI state keyed by threadId.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createDeferredPersistStorage, flushStorageBeforePageHide } from "./lib/storage";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadPrimarySurface,
  type ThreadTerminalGroup,
  type TerminalExitState,
  type TerminalGroupRole,
  type TerminalLaunchMetadata,
  type ThreadTerminalSplitPosition,
  type ThreadTerminalPresentationMode,
  type ThreadTerminalWorkspaceLayout,
  type ThreadTerminalWorkspaceTab,
} from "./types";
import {
  addTerminalTabToGroupLayout,
  collectTerminalIdsFromLayout,
  createTerminalGroup,
  normalizeTerminalPaneGroup,
  removeTerminalFromGroupLayout,
  resizeTerminalGroupLayout,
  setActiveTerminalInGroupLayout,
  splitTerminalGroupLayout,
} from "./terminalPaneLayout";
import {
  activeTerminalGroups,
  archiveTerminalGroupInList,
  inferTerminalGroupRole,
  normalizeTerminalGroupMetadata,
  reorderActiveTerminalGroupInList,
  restoreTerminalGroupInList,
  terminalGroupPresentation,
} from "./lib/terminalGroups";
import {
  createWorkspaceTerminalGroupFromPreset,
  type WorkspaceLayoutPresetId,
} from "./workspaceTerminalLayoutPresets";

export interface ThreadTerminalState {
  entryPoint: ThreadPrimarySurface;
  terminalOpen: boolean;
  presentationMode: ThreadTerminalPresentationMode;
  workspaceLayout: ThreadTerminalWorkspaceLayout;
  workspaceActiveTab: ThreadTerminalWorkspaceTab;
  terminalHeight: number;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  terminalExitStatesById: Record<string, TerminalExitState>;
  terminalLaunchMetadataById: Record<string, TerminalLaunchMetadata>;
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  showArchivedTerminalGroups: boolean;
}

export type TerminalMoveTarget =
  | { kind: "group"; groupId: string; targetTerminalId?: string | undefined }
  | { kind: "new-group"; toIndex?: number | undefined };

const TERMINAL_STATE_STORAGE_KEY = "synara:terminal-state:v1";

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[] | null | undefined,
  terminalIds: string[],
): string[] {
  if (!runningTerminalIds || runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function normalizeTerminalExitStates(
  states: Record<string, TerminalExitState> | null | undefined,
  terminalIds: string[],
): Record<string, TerminalExitState> {
  const validIds = new Set(terminalIds);
  return Object.fromEntries(
    Object.entries(states ?? {})
      .filter(
        ([terminalId, state]) =>
          validIds.has(terminalId) && (state?.kind === "stopped" || state?.kind === "failed"),
      )
      .map(([terminalId, state]) => [
        terminalId,
        {
          kind: state.kind,
          exitCode:
            typeof state.exitCode === "number" && Number.isFinite(state.exitCode)
              ? state.exitCode
              : null,
          exitSignal: typeof state.exitSignal === "string" ? state.exitSignal.trim() || null : null,
        } satisfies TerminalExitState,
      ]),
  );
}

function normalizeTerminalLaunchMetadata(
  metadataById: Record<string, TerminalLaunchMetadata> | null | undefined,
  terminalIds: string[],
): Record<string, TerminalLaunchMetadata> {
  const validIds = new Set(terminalIds);
  return Object.fromEntries(
    Object.entries(metadataById ?? {})
      .filter(([terminalId]) => validIds.has(terminalId))
      .map(([terminalId, metadata]) => [
        terminalId,
        {
          cwd: typeof metadata?.cwd === "string" ? metadata.cwd.trim() || null : null,
          ...(metadata?.reattachOnly === true ? { reattachOnly: true as const } : {}),
        } satisfies TerminalLaunchMetadata,
      ]),
  );
}

function normalizeTerminalLabels(
  terminalLabelsById: Record<string, string> | null | undefined,
  terminalIds: string[],
): Record<string, string> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalLabelsById ?? {})
    .map(([terminalId, label]) => [terminalId.trim(), label.trim()] as const)
    .filter(([terminalId, label]) => terminalId.length > 0 && label.length > 0)
    .filter(([terminalId]) => validTerminalIdSet.has(terminalId))
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalTitleOverrides(
  terminalTitleOverridesById: Record<string, string> | null | undefined,
  terminalIds: string[],
): Record<string, string> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalTitleOverridesById ?? {})
    .map(([terminalId, titleOverride]) => [terminalId.trim(), titleOverride.trim()] as const)
    .filter(
      ([terminalId, titleOverride]) =>
        terminalId.length > 0 && titleOverride.length > 0 && validTerminalIdSet.has(terminalId),
    )
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalCliKinds(
  terminalCliKindsById: Record<string, TerminalCliKind> | null | undefined,
  terminalIds: string[],
): Record<string, TerminalCliKind> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalCliKindsById ?? {})
    .map(([terminalId, cliKind]) => [terminalId.trim(), cliKind] as const)
    .filter(
      ([terminalId, cliKind]) =>
        terminalId.length > 0 &&
        (cliKind === "codex" || cliKind === "claude" || cliKind === "antigravity"),
    )
    .filter(([terminalId]) => validTerminalIdSet.has(terminalId))
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalAttentionStates(
  terminalAttentionStatesById: Record<string, "attention" | "review"> | null | undefined,
  terminalIds: string[],
): Record<string, "attention" | "review"> {
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries = Object.entries(terminalAttentionStatesById ?? {})
    .map(([terminalId, state]) => [terminalId.trim(), state] as const)
    .filter(
      ([terminalId, state]) =>
        terminalId.length > 0 && (state === "attention" || state === "review"),
    )
    .filter(([terminalId]) => validTerminalIdSet.has(terminalId))
    .toSorted(([leftId], [rightId]) => leftId.localeCompare(rightId));
  return Object.fromEntries(normalizedEntries);
}

function clearTerminalReviewState(
  terminalAttentionStatesById: Record<string, "attention" | "review">,
  terminalId: string,
): Record<string, "attention" | "review"> {
  if (terminalAttentionStatesById[terminalId] !== "review") {
    return terminalAttentionStatesById;
  }
  const nextAttentionStatesById = { ...terminalAttentionStatesById };
  delete nextAttentionStatesById[terminalId];
  return nextAttentionStatesById;
}

function generatedTerminalTitleBase(cliKind: TerminalCliKind | null): string {
  if (cliKind === "codex") return "Codex";
  if (cliKind === "claude") return "Claude";
  if (cliKind === "antigravity") return "Antigravity";
  return "Terminal";
}

function resolveTerminalDisplayTitle(options: {
  terminalId: string;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): string {
  return (
    options.terminalTitleOverridesById[options.terminalId]?.trim() ||
    options.terminalLabelsById[options.terminalId]?.trim() ||
    ""
  );
}

function createUniqueTerminalTitle(options: {
  cliKind: TerminalCliKind | null;
  excludeTerminalId?: string | undefined;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById?: Record<string, string> | undefined;
}): string {
  const baseTitle = generatedTerminalTitleBase(options.cliKind);
  const takenTitles = new Set(
    Object.keys(options.terminalLabelsById)
      .filter((terminalId) => terminalId !== options.excludeTerminalId)
      .map((terminalId) =>
        resolveTerminalDisplayTitle({
          terminalId,
          terminalLabelsById: options.terminalLabelsById,
          terminalTitleOverridesById: options.terminalTitleOverridesById ?? {},
        }),
      )
      .filter((title) => title.length > 0),
  );
  let index = 1;
  while (true) {
    const candidate = `${baseTitle} ${index}`;
    if (!takenTitles.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function ensureTerminalLabels(options: {
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): Record<string, string> {
  const nextLabelsById = { ...options.terminalLabelsById };
  for (const terminalId of options.terminalIds) {
    const existingLabel = nextLabelsById[terminalId]?.trim();
    if (existingLabel && existingLabel.length > 0) {
      continue;
    }
    nextLabelsById[terminalId] = createUniqueTerminalTitle({
      cliKind: options.terminalCliKindsById[terminalId] ?? null,
      excludeTerminalId: terminalId,
      terminalLabelsById: nextLabelsById,
      terminalTitleOverridesById: options.terminalTitleOverridesById,
    });
  }
  return nextLabelsById;
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) =>
    collectTerminalIdsFromLayout(group.layout).includes(terminalId),
  );
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[] | null | undefined,
  terminalIds: string[],
  terminalLabelsById: Record<string, string>,
  terminalCliKindsById: Record<string, TerminalCliKind>,
): ThreadTerminalGroup[] {
  if (terminalIds.length === 0) return [];
  const nextGroups: ThreadTerminalGroup[] = [];
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups ?? []) {
    const normalizedGroup = normalizeTerminalPaneGroup(group, terminalIds);
    if (!normalizedGroup) continue;
    const unassignedTerminalIds = collectTerminalIdsFromLayout(normalizedGroup.layout).filter(
      (terminalId) => {
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      },
    );
    if (unassignedTerminalIds.length === 0) continue;
    const normalizedUnassignedGroup = normalizeTerminalPaneGroup(
      {
        ...normalizedGroup,
        layout: normalizedGroup.layout,
      },
      unassignedTerminalIds,
    );
    if (!normalizedUnassignedGroup) continue;
    collectTerminalIdsFromLayout(normalizedUnassignedGroup.layout).forEach((terminalId) => {
      assignedTerminalIds.add(terminalId);
    });
    const groupTerminalIds = collectTerminalIdsFromLayout(normalizedUnassignedGroup.layout);
    const fallbackTerminalId = groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID;
    nextGroups.push({
      ...normalizedUnassignedGroup,
      ...normalizeTerminalGroupMetadata(group, {
        fallbackIndex: nextGroups.length,
        fallbackName: terminalLabelsById[fallbackTerminalId] ?? null,
        cliKinds: groupTerminalIds.map((terminalId) => terminalCliKindsById[terminalId]),
      }),
      id: assignUniqueGroupId(
        normalizedUnassignedGroup.id.trim() ||
          fallbackGroupId(unassignedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID),
        usedGroupIds,
      ),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push(
      createTerminalGroup(
        assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
        terminalId,
        normalizeTerminalGroupMetadata(
          {},
          {
            fallbackIndex: nextGroups.length,
            fallbackName: terminalLabelsById[terminalId] ?? null,
            cliKinds: [terminalCliKindsById[terminalId]],
          },
        ),
      ),
    );
  }

  if (nextGroups.length === 0) {
    return [
      createTerminalGroup(fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID), DEFAULT_THREAD_TERMINAL_ID, {
        name: terminalLabelsById[DEFAULT_THREAD_TERMINAL_ID] ?? "Terminal 1",
      }),
    ];
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (leftGroup.activeTerminalId !== rightGroup.activeTerminalId) return false;
    if (leftGroup.name !== rightGroup.name) return false;
    if (leftGroup.role !== rightGroup.role) return false;
    if (leftGroup.icon !== rightGroup.icon) return false;
    if (leftGroup.accent !== rightGroup.accent) return false;
    if (leftGroup.archivedAt !== rightGroup.archivedAt) return false;
    if (leftGroup.originalIndex !== rightGroup.originalIndex) return false;
    if (leftGroup.createdAt !== rightGroup.createdAt) return false;
    if (leftGroup.updatedAt !== rightGroup.updatedAt) return false;
    if (leftGroup.userNamed !== rightGroup.userNamed) return false;
    if (JSON.stringify(leftGroup.layout) !== JSON.stringify(rightGroup.layout)) return false;
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.entryPoint === right.entryPoint &&
    left.terminalOpen === right.terminalOpen &&
    left.presentationMode === right.presentationMode &&
    left.workspaceLayout === right.workspaceLayout &&
    left.workspaceActiveTab === right.workspaceActiveTab &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    JSON.stringify(left.terminalLabelsById) === JSON.stringify(right.terminalLabelsById) &&
    JSON.stringify(left.terminalTitleOverridesById) ===
      JSON.stringify(right.terminalTitleOverridesById) &&
    JSON.stringify(left.terminalCliKindsById) === JSON.stringify(right.terminalCliKindsById) &&
    JSON.stringify(left.terminalAttentionStatesById) ===
      JSON.stringify(right.terminalAttentionStatesById) &&
    JSON.stringify(left.terminalExitStatesById) === JSON.stringify(right.terminalExitStatesById) &&
    JSON.stringify(left.terminalLaunchMetadataById) ===
      JSON.stringify(right.terminalLaunchMetadataById) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    left.showArchivedTerminalGroups === right.showArchivedTerminalGroups &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  entryPoint: "chat",
  terminalOpen: false,
  presentationMode: "drawer",
  workspaceLayout: "both",
  workspaceActiveTab: "terminal",
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  terminalLabelsById: { [DEFAULT_THREAD_TERMINAL_ID]: "Terminal 1" },
  terminalTitleOverridesById: {},
  terminalCliKindsById: {},
  terminalAttentionStatesById: {},
  terminalExitStatesById: {},
  terminalLaunchMetadataById: {},
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    createTerminalGroup(fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID), DEFAULT_THREAD_TERMINAL_ID),
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  showArchivedTerminalGroups: false,
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    terminalLabelsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalLabelsById },
    terminalTitleOverridesById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalTitleOverridesById },
    terminalCliKindsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalCliKindsById },
    terminalAttentionStatesById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalAttentionStatesById },
    terminalExitStatesById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalExitStatesById },
    terminalLaunchMetadataById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalLaunchMetadataById },
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

export function normalizeThreadTerminalState(
  state: Partial<ThreadTerminalState>,
): ThreadTerminalState {
  const explicitlyEmpty = state.terminalIds?.length === 0 && state.terminalGroups?.length === 0;
  const terminalIds = normalizeTerminalIds(state.terminalIds ?? [DEFAULT_THREAD_TERMINAL_ID]);
  const nextTerminalIds = explicitlyEmpty
    ? []
    : terminalIds.length > 0
      ? terminalIds
      : [DEFAULT_THREAD_TERMINAL_ID];
  const terminalLabelsById = normalizeTerminalLabels(
    (state as Partial<ThreadTerminalState>).terminalLabelsById,
    nextTerminalIds,
  );
  const terminalTitleOverridesById = normalizeTerminalTitleOverrides(
    (state as Partial<ThreadTerminalState>).terminalTitleOverridesById,
    nextTerminalIds,
  );
  const terminalCliKindsById = normalizeTerminalCliKinds(
    (state as Partial<ThreadTerminalState>).terminalCliKindsById,
    nextTerminalIds,
  );
  const terminalAttentionStatesById = normalizeTerminalAttentionStates(
    (state as Partial<ThreadTerminalState>).terminalAttentionStatesById,
    nextTerminalIds,
  );
  const ensuredTerminalLabelsById = ensureTerminalLabels({
    terminalCliKindsById,
    terminalIds: nextTerminalIds,
    terminalLabelsById,
    terminalTitleOverridesById,
  });
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const terminalExitStatesById = normalizeTerminalExitStates(
    state.terminalExitStatesById,
    nextTerminalIds,
  );
  const terminalLaunchMetadataById = normalizeTerminalLaunchMetadata(
    state.terminalLaunchMetadataById,
    nextTerminalIds,
  );
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId ?? "")
    ? (state.activeTerminalId ?? DEFAULT_THREAD_TERMINAL_ID)
    : (nextTerminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(
    state.terminalGroups,
    nextTerminalIds,
    ensuredTerminalLabelsById,
    terminalCliKindsById,
  );
  const visibleTerminalGroups = activeTerminalGroups(terminalGroups);
  const activeGroupIdFromState = visibleTerminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? (state.activeTerminalGroupId ?? null)
    : null;
  const activeGroupIdFromTerminal =
    visibleTerminalGroups.find((group) =>
      collectTerminalIdsFromLayout(group.layout).includes(activeTerminalId),
    )?.id ?? null;
  const resolvedActiveTerminalGroupId =
    activeGroupIdFromState ??
    activeGroupIdFromTerminal ??
    visibleTerminalGroups[0]?.id ??
    terminalGroups.find((group) => group.id === state.activeTerminalGroupId)?.id ??
    terminalGroups[0]?.id ??
    "";
  const resolvedActiveGroup = terminalGroups.find(
    (group) => group.id === resolvedActiveTerminalGroupId,
  );
  const resolvedActiveTerminalId =
    resolvedActiveGroup &&
    !collectTerminalIdsFromLayout(resolvedActiveGroup.layout).includes(activeTerminalId)
      ? resolvedActiveGroup.activeTerminalId
      : activeTerminalId;
  const syncedTerminalGroups = terminalGroups.map((group) =>
    group.id === resolvedActiveTerminalGroupId &&
    collectTerminalIdsFromLayout(group.layout).includes(resolvedActiveTerminalId) &&
    group.activeTerminalId !== resolvedActiveTerminalId
      ? setActiveTerminalInGroupLayout(group, resolvedActiveTerminalId)
      : group,
  );

  const terminalHeight = state.terminalHeight;
  const normalized: ThreadTerminalState = {
    entryPoint: state.entryPoint === "terminal" ? "terminal" : "chat",
    terminalOpen: state.terminalOpen === true,
    presentationMode: state.presentationMode === "workspace" ? "workspace" : "drawer",
    workspaceLayout: state.workspaceLayout === "terminal-only" ? "terminal-only" : "both",
    workspaceActiveTab: state.workspaceActiveTab === "chat" ? "chat" : "terminal",
    terminalHeight:
      typeof terminalHeight === "number" && Number.isFinite(terminalHeight) && terminalHeight > 0
        ? terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    terminalLabelsById: ensuredTerminalLabelsById,
    terminalTitleOverridesById,
    terminalCliKindsById,
    terminalAttentionStatesById,
    terminalExitStatesById,
    terminalLaunchMetadataById,
    runningTerminalIds,
    activeTerminalId: resolvedActiveTerminalId,
    terminalGroups: syncedTerminalGroups,
    activeTerminalGroupId: resolvedActiveTerminalGroupId,
    showArchivedTerminalGroups: state.showArchivedTerminalGroups === true,
  };
  return state.terminalExitStatesById !== undefined &&
    state.terminalLaunchMetadataById !== undefined &&
    state.showArchivedTerminalGroups !== undefined &&
    threadTerminalStateEqual(state as ThreadTerminalState, normalized)
    ? (state as ThreadTerminalState)
    : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function stripVolatileTerminalRuntimeState(state: ThreadTerminalState): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (
    normalized.runningTerminalIds.length === 0 &&
    Object.keys(normalized.terminalAttentionStatesById).length === 0
  ) {
    return normalized;
  }
  // Runtime activity is replayed by live terminal events after startup; persisting
  // it would make old attention states look like fresh notifications.
  return {
    ...normalized,
    terminalAttentionStatesById: {},
    runningTerminalIds: [],
  };
}

export function sanitizePersistedTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState> | null | undefined,
): Record<ThreadId, ThreadTerminalState> {
  const next: Record<ThreadId, ThreadTerminalState> = {};
  for (const [threadId, state] of Object.entries(terminalStateByThreadId ?? {})) {
    const sanitized = stripVolatileTerminalRuntimeState(state);
    if (!isDefaultThreadTerminalState(sanitized)) {
      next[threadId as ThreadId] = {
        ...sanitized,
        terminalLaunchMetadataById: Object.fromEntries(
          sanitized.terminalIds.map((terminalId) => [
            terminalId,
            {
              cwd: sanitized.terminalLaunchMetadataById[terminalId]?.cwd ?? null,
              reattachOnly: true as const,
            },
          ]),
        ),
      };
    }
  }
  return next;
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    ...group,
    layout: JSON.parse(JSON.stringify(group.layout)),
  }));
}

function createNamedTerminalGroup(
  state: ThreadTerminalState,
  groupId: string,
  terminalId: string,
): ThreadTerminalGroup {
  const createdAt = Date.now();
  return createTerminalGroup(groupId, terminalId, {
    name: createUniqueTerminalTitle({
      cliKind: state.terminalCliKindsById[terminalId] ?? null,
      terminalLabelsById: state.terminalLabelsById,
      terminalTitleOverridesById: state.terminalTitleOverridesById,
    }),
    createdAt,
    updatedAt: createdAt,
    userNamed: false,
  });
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalState,
  terminalId: string,
  mode: "split" | "new",
  position: ThreadTerminalSplitPosition = "right",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    const existingGroup = terminalGroups[existingGroupIndex];
    if (existingGroup) {
      const nextExistingGroup = removeTerminalFromGroupLayout(existingGroup, terminalId);
      if (nextExistingGroup) {
        terminalGroups[existingGroupIndex] = nextExistingGroup;
      } else {
        terminalGroups.splice(existingGroupIndex, 1);
      }
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push(createNamedTerminalGroup(normalized, nextGroupId, terminalId));
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId && group.archivedAt === null,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = terminalGroups.findIndex(
      (group) =>
        group.archivedAt === null &&
        collectTerminalIdsFromLayout(group.layout).includes(normalized.activeTerminalId),
    );
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push(createNamedTerminalGroup(normalized, nextGroupId, terminalId));
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }
  const destinationTerminalIds = collectTerminalIdsFromLayout(destinationGroup.layout);

  if (
    isNewTerminal &&
    !destinationTerminalIds.includes(terminalId) &&
    destinationTerminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationTerminalIds.includes(terminalId)) {
    terminalGroups[activeGroupIndex] = splitTerminalGroupLayout({
      group: destinationGroup,
      targetTerminalId: destinationGroup.activeTerminalId,
      newTerminalId: terminalId,
      position,
      splitId: `split-${terminalId}`,
    });
  }

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: terminalGroups[activeGroupIndex]?.id ?? destinationGroup.id,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function openThreadChatPage(state: ThreadTerminalState): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextWorkspaceState =
    normalized.terminalOpen && normalized.presentationMode === "workspace"
      ? {
          workspaceLayout: "both" as const,
          workspaceActiveTab: "chat" as const,
        }
      : null;
  if (normalized.entryPoint === "chat" && nextWorkspaceState === null) {
    return normalized;
  }
  if (nextWorkspaceState === null) {
    return {
      ...normalized,
      entryPoint: "chat",
    };
  }
  return {
    ...normalized,
    entryPoint: "chat",
    ...nextWorkspaceState,
  };
}

function openThreadTerminalPage(
  state: ThreadTerminalState,
  options?: { terminalOnly?: boolean },
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const shouldUseTerminalOnlyLayout =
    options?.terminalOnly ??
    (normalized.entryPoint === "terminal" ? normalized.workspaceLayout === "terminal-only" : true);
  const nextWorkspaceLayout = shouldUseTerminalOnlyLayout
    ? "terminal-only"
    : normalized.workspaceLayout;
  if (
    normalized.entryPoint === "terminal" &&
    normalized.terminalOpen &&
    normalized.presentationMode === "workspace" &&
    normalized.workspaceActiveTab === "terminal" &&
    normalized.workspaceLayout === nextWorkspaceLayout
  ) {
    return normalized;
  }
  return {
    ...normalized,
    entryPoint: "terminal",
    terminalOpen: true,
    presentationMode: "workspace",
    workspaceLayout: nextWorkspaceLayout,
    workspaceActiveTab: "terminal",
    terminalAttentionStatesById: clearTerminalReviewState(
      normalized.terminalAttentionStatesById,
      normalized.activeTerminalId,
    ),
  };
}

function setThreadTerminalPresentationMode(
  state: ThreadTerminalState,
  mode: ThreadTerminalPresentationMode,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.presentationMode === mode) {
    return normalized;
  }
  return {
    ...normalized,
    terminalOpen: true,
    presentationMode: mode,
    workspaceLayout: normalized.workspaceLayout,
    workspaceActiveTab: mode === "workspace" ? "terminal" : normalized.workspaceActiveTab,
  };
}

function setThreadTerminalWorkspaceTab(
  state: ThreadTerminalState,
  tab: ThreadTerminalWorkspaceTab,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextWorkspaceLayout = tab === "chat" ? "both" : normalized.workspaceLayout;
  if (normalized.workspaceActiveTab === tab && normalized.workspaceLayout === nextWorkspaceLayout) {
    return normalized;
  }
  return {
    ...normalized,
    workspaceLayout: nextWorkspaceLayout,
    workspaceActiveTab: tab,
    terminalAttentionStatesById:
      tab === "terminal"
        ? clearTerminalReviewState(
            normalized.terminalAttentionStatesById,
            normalized.activeTerminalId,
          )
        : normalized.terminalAttentionStatesById,
  };
}

function setThreadTerminalWorkspaceLayout(
  state: ThreadTerminalState,
  layout: ThreadTerminalWorkspaceLayout,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextActiveTab =
    layout === "terminal-only"
      ? "terminal"
      : normalized.workspaceActiveTab === "chat"
        ? "chat"
        : "terminal";
  if (normalized.workspaceLayout === layout && normalized.workspaceActiveTab === nextActiveTab) {
    return normalized;
  }
  return {
    ...normalized,
    workspaceLayout: layout,
    workspaceActiveTab: nextActiveTab,
  };
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

// Persist terminal identity and keep system-inferred group presentation aligned
// until the user explicitly names the group.
function setThreadTerminalMetadata(
  state: ThreadTerminalState,
  terminalId: string,
  metadata: {
    cliKind: TerminalCliKind | null;
    label: string;
  },
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const currentLabel = normalized.terminalLabelsById[terminalId] ?? "";
  const currentTitleOverride = normalized.terminalTitleOverridesById[terminalId]?.trim() ?? "";
  const currentCliKind = normalized.terminalCliKindsById[terminalId] ?? null;
  const nextCliKind = metadata.cliKind;
  const nextLabel =
    currentTitleOverride.length > 0
      ? currentLabel
      : nextCliKind !== null
        ? createUniqueTerminalTitle({
            cliKind: nextCliKind,
            excludeTerminalId: terminalId,
            terminalLabelsById: normalized.terminalLabelsById,
            terminalTitleOverridesById: normalized.terminalTitleOverridesById,
          })
        : metadata.label.trim().length > 0
          ? metadata.label.trim()
          : currentLabel;
  const nextCliKindsById = { ...normalized.terminalCliKindsById };
  if (nextCliKind === null) {
    delete nextCliKindsById[terminalId];
  } else {
    nextCliKindsById[terminalId] = nextCliKind;
  }
  const nextTerminalLabelsById =
    currentLabel === nextLabel
      ? normalized.terminalLabelsById
      : { ...normalized.terminalLabelsById, [terminalId]: nextLabel };
  const identityChanged = currentLabel !== nextLabel || currentCliKind !== nextCliKind;
  const changedAt = Date.now();
  let groupMetadataChanged = false;
  const terminalGroups = normalized.terminalGroups.map((group, groupIndex) => {
    if (group.userNamed) return group;
    const groupTerminalIds = collectTerminalIdsFromLayout(group.layout);
    if (!groupTerminalIds.includes(terminalId)) return group;
    const representativeTerminalId = groupTerminalIds.includes(group.activeTerminalId)
      ? group.activeTerminalId
      : groupTerminalIds[0];
    if (!representativeTerminalId) return group;
    const inferredName =
      normalized.terminalTitleOverridesById[representativeTerminalId]?.trim() ||
      nextTerminalLabelsById[representativeTerminalId]?.trim() ||
      `Terminal ${groupIndex + 1}`;
    const inferredRole = inferTerminalGroupRole({
      cliKinds: groupTerminalIds.map((id) => nextCliKindsById[id] ?? null),
      token: inferredName,
    });
    const presentation = terminalGroupPresentation(inferredRole);
    if (
      group.name === inferredName &&
      group.role === inferredRole &&
      group.icon === presentation.icon &&
      group.accent === presentation.accent
    ) {
      return group;
    }
    groupMetadataChanged = true;
    return {
      ...group,
      name: inferredName,
      role: inferredRole,
      icon: presentation.icon,
      accent: presentation.accent,
      updatedAt: changedAt,
    };
  });
  if (!identityChanged && !groupMetadataChanged) return normalized;
  return {
    ...normalized,
    terminalLabelsById: nextTerminalLabelsById,
    terminalCliKindsById: nextCliKindsById,
    terminalGroups,
  };
}

function setThreadTerminalCliKind(
  state: ThreadTerminalState,
  terminalId: string,
  cliKind: TerminalCliKind | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const currentCliKind = normalized.terminalCliKindsById[terminalId] ?? null;
  if (currentCliKind === cliKind) {
    return normalized;
  }

  const nextCliKindsById = { ...normalized.terminalCliKindsById };
  if (cliKind === null) {
    delete nextCliKindsById[terminalId];
  } else {
    nextCliKindsById[terminalId] = cliKind;
  }

  const currentTitleOverride = normalized.terminalTitleOverridesById[terminalId]?.trim() ?? "";
  const terminalLabelsById =
    cliKind !== null && currentTitleOverride.length === 0
      ? {
          ...normalized.terminalLabelsById,
          [terminalId]: createUniqueTerminalTitle({
            cliKind,
            excludeTerminalId: terminalId,
            terminalLabelsById: normalized.terminalLabelsById,
            terminalTitleOverridesById: normalized.terminalTitleOverridesById,
          }),
        }
      : normalized.terminalLabelsById;

  return {
    ...normalized,
    terminalLabelsById,
    terminalCliKindsById: nextCliKindsById,
  };
}

function setThreadTerminalTitleOverride(
  state: ThreadTerminalState,
  terminalId: string,
  titleOverride: string | null | undefined,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedTitleOverride = titleOverride?.trim() ?? "";
  const currentTitleOverride = normalized.terminalTitleOverridesById[terminalId] ?? "";
  if (currentTitleOverride === normalizedTitleOverride) {
    return normalized;
  }
  const nextTitleOverridesById = { ...normalized.terminalTitleOverridesById };
  if (normalizedTitleOverride.length === 0) {
    delete nextTitleOverridesById[terminalId];
  } else {
    nextTitleOverridesById[terminalId] = normalizedTitleOverride;
  }
  return {
    ...normalized,
    terminalTitleOverridesById: nextTitleOverridesById,
  };
}

function splitThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split", "right");
}

function splitThreadTerminalLeft(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split", "left");
}

function splitThreadTerminalDown(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split", "bottom");
}

function splitThreadTerminalUp(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split", "top");
}

function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function newThreadTerminalTab(
  state: ThreadTerminalState,
  targetTerminalId: string,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId) || normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  let activeGroupIndex = terminalGroups.findIndex(
    (group) =>
      group.archivedAt === null &&
      collectTerminalIdsFromLayout(group.layout).includes(targetTerminalId),
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = terminalGroups.findIndex(
      (group) =>
        group.archivedAt === null &&
        collectTerminalIdsFromLayout(group.layout).includes(normalized.activeTerminalId),
    );
  }
  if (activeGroupIndex < 0) {
    return newThreadTerminal(normalized, terminalId);
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }
  const destinationTerminalIds = collectTerminalIdsFromLayout(destinationGroup.layout);
  if (destinationTerminalIds.length >= MAX_TERMINALS_PER_GROUP) {
    return normalized;
  }

  terminalGroups[activeGroupIndex] = addTerminalTabToGroupLayout(
    destinationGroup,
    targetTerminalId,
    terminalId,
  );

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds: [...normalized.terminalIds, terminalId],
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: terminalGroups[activeGroupIndex]?.id ?? destinationGroup.id,
  });
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find(
      (group) =>
        group.archivedAt === null &&
        collectTerminalIdsFromLayout(group.layout).includes(terminalId),
    )?.id ?? normalized.activeTerminalGroupId;
  if (
    !normalized.terminalGroups.some(
      (group) => group.id === activeTerminalGroupId && group.archivedAt === null,
    )
  ) {
    return normalized;
  }
  const terminalGroups = normalized.terminalGroups.map((group) =>
    group.id === activeTerminalGroupId ? setActiveTerminalInGroupLayout(group, terminalId) : group,
  );
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId &&
    terminalGroupsEqual(terminalGroups, normalized.terminalGroups) &&
    normalized.terminalAttentionStatesById[terminalId] !== "review"
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId,
    terminalAttentionStatesById: clearTerminalReviewState(
      normalized.terminalAttentionStatesById,
      terminalId,
    ),
  };
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    if (normalized.entryPoint === "terminal") {
      return normalizeThreadTerminalState({
        ...createDefaultThreadTerminalState(),
        entryPoint: "terminal",
        terminalOpen: false,
        presentationMode: normalized.presentationMode,
        workspaceLayout: normalized.workspaceLayout,
        workspaceActiveTab: "terminal",
        terminalHeight: normalized.terminalHeight,
      });
    }
    return createDefaultThreadTerminalState();
  }

  const sourceGroupId =
    normalized.terminalGroups.find((group) =>
      collectTerminalIdsFromLayout(group.layout).includes(terminalId),
    )?.id ?? normalized.activeTerminalGroupId;

  const terminalGroups = normalized.terminalGroups
    .map((group) => removeTerminalFromGroupLayout(group, terminalId))
    .filter((group): group is ThreadTerminalGroup => group !== null);

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (terminalGroups.find((group) => group.id === sourceGroupId)?.activeTerminalId ??
        remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : normalized.activeTerminalId;

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) =>
      collectTerminalIdsFromLayout(group.layout).includes(nextActiveTerminalId),
    )?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalState({
    entryPoint: normalized.entryPoint,
    terminalOpen: normalized.terminalOpen,
    presentationMode: normalized.presentationMode,
    workspaceLayout: normalized.workspaceLayout,
    workspaceActiveTab: normalized.workspaceActiveTab,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    terminalLabelsById: Object.fromEntries(
      Object.entries(normalized.terminalLabelsById).filter(([id]) => id !== terminalId),
    ),
    terminalTitleOverridesById: Object.fromEntries(
      Object.entries(normalized.terminalTitleOverridesById).filter(([id]) => id !== terminalId),
    ),
    terminalCliKindsById: Object.fromEntries(
      Object.entries(normalized.terminalCliKindsById).filter(([id]) => id !== terminalId),
    ),
    terminalAttentionStatesById: Object.fromEntries(
      Object.entries(normalized.terminalAttentionStatesById).filter(([id]) => id !== terminalId),
    ),
    terminalExitStatesById: Object.fromEntries(
      Object.entries(normalized.terminalExitStatesById).filter(([id]) => id !== terminalId),
    ),
    terminalLaunchMetadataById: Object.fromEntries(
      Object.entries(normalized.terminalLaunchMetadataById).filter(([id]) => id !== terminalId),
    ),
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
    showArchivedTerminalGroups: normalized.showArchivedTerminalGroups,
  });
}

function closeThreadTerminalGroup(
  state: ThreadTerminalState,
  groupId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const group = normalized.terminalGroups.find((entry) => entry.id === groupId);
  if (!group) {
    return normalized;
  }
  const terminalIds = collectTerminalIdsFromLayout(group.layout);
  if (terminalIds.length === normalized.terminalIds.length) {
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds: [],
      terminalLabelsById: {},
      terminalTitleOverridesById: {},
      terminalCliKindsById: {},
      terminalAttentionStatesById: {},
      terminalExitStatesById: {},
      terminalLaunchMetadataById: {},
      runningTerminalIds: [],
      activeTerminalId: "",
      terminalGroups: [],
      activeTerminalGroupId: "",
      showArchivedTerminalGroups: false,
    });
  }
  return terminalIds.reduce(
    (nextState, terminalId) => closeThreadTerminal(nextState, terminalId),
    normalized,
  );
}

function renameThreadTerminalGroup(
  state: ThreadTerminalState,
  groupId: string,
  name: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextName = name.trim();
  if (nextName.length === 0) return normalized;
  const changedAt = Date.now();
  let changed = false;
  const terminalGroups = normalized.terminalGroups.map((group) => {
    if (group.id !== groupId || (group.name === nextName && group.userNamed)) return group;
    changed = true;
    return { ...group, name: nextName, userNamed: true, updatedAt: changedAt };
  });
  return changed ? { ...normalized, terminalGroups } : normalized;
}

function setThreadTerminalGroupRole(
  state: ThreadTerminalState,
  groupId: string,
  role: TerminalGroupRole,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const presentation = terminalGroupPresentation(role);
  let changed = false;
  const terminalGroups = normalized.terminalGroups.map((group) => {
    if (group.id !== groupId || group.role === role) return group;
    changed = true;
    return {
      ...group,
      role,
      icon: presentation.icon,
      accent: presentation.accent,
      updatedAt: Date.now(),
    };
  });
  return changed ? { ...normalized, terminalGroups } : normalized;
}

function archiveThreadTerminalGroup(
  state: ThreadTerminalState,
  groupId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const visibleBefore = activeTerminalGroups(normalized.terminalGroups);
  const archivedIndex = visibleBefore.findIndex((group) => group.id === groupId);
  if (archivedIndex < 0) return normalized;
  const terminalGroups = archiveTerminalGroupInList({
    groups: normalized.terminalGroups,
    groupId,
    archivedAt: Date.now(),
  });
  if (normalized.activeTerminalGroupId !== groupId) {
    return { ...normalized, terminalGroups };
  }
  const visibleAfter = activeTerminalGroups(terminalGroups);
  const nextGroup = visibleAfter[Math.min(archivedIndex, Math.max(0, visibleAfter.length - 1))];
  return {
    ...normalized,
    terminalGroups,
    activeTerminalGroupId: nextGroup?.id ?? groupId,
    activeTerminalId: nextGroup?.activeTerminalId ?? normalized.activeTerminalId,
  };
}

function restoreThreadTerminalGroup(
  state: ThreadTerminalState,
  groupId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const terminalGroups = restoreTerminalGroupInList({
    groups: normalized.terminalGroups,
    groupId,
    restoredAt: Date.now(),
  });
  const restored = terminalGroups.find(
    (group) => group.id === groupId && group.archivedAt === null,
  );
  if (!restored || terminalGroupsEqual(terminalGroups, normalized.terminalGroups))
    return normalized;
  return normalizeThreadTerminalState({
    ...normalized,
    terminalGroups,
    activeTerminalGroupId: restored.id,
    activeTerminalId: restored.activeTerminalId,
  });
}

function reorderThreadTerminalGroup(
  state: ThreadTerminalState,
  groupId: string,
  toIndex: number,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const terminalGroups = reorderActiveTerminalGroupInList({
    groups: normalized.terminalGroups,
    groupId,
    toIndex,
    changedAt: Date.now(),
  });
  return terminalGroupsEqual(terminalGroups, normalized.terminalGroups)
    ? normalized
    : { ...normalized, terminalGroups };
}

function moveThreadTerminals(
  state: ThreadTerminalState,
  terminalIds: readonly string[],
  target: TerminalMoveTarget,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const requestedTerminalIds = [...new Set(terminalIds.map((id) => id.trim()))].filter(
    (id) => id.length > 0,
  );
  if (requestedTerminalIds.length === 0) return normalized;

  const sourceGroupByTerminalId = new Map<string, ThreadTerminalGroup>();
  for (const terminalId of requestedTerminalIds) {
    if (!normalized.terminalIds.includes(terminalId)) return normalized;
    const sourceGroup = normalized.terminalGroups.find((group) =>
      collectTerminalIdsFromLayout(group.layout).includes(terminalId),
    );
    if (!sourceGroup || sourceGroup.archivedAt !== null) return normalized;
    sourceGroupByTerminalId.set(terminalId, sourceGroup);
  }

  const targetGroup =
    target.kind === "group"
      ? normalized.terminalGroups.find((group) => group.id === target.groupId)
      : null;
  if (target.kind === "group" && (!targetGroup || targetGroup.archivedAt !== null)) {
    return normalized;
  }
  const targetTerminalId = target.kind === "group" ? target.targetTerminalId?.trim() || null : null;

  if (targetGroup) {
    const targetTerminalIds = collectTerminalIdsFromLayout(targetGroup.layout);
    if (
      targetTerminalId &&
      (!targetTerminalIds.includes(targetTerminalId) ||
        requestedTerminalIds.includes(targetTerminalId))
    ) {
      return normalized;
    }
    const additions = requestedTerminalIds.filter(
      (terminalId) => !targetTerminalIds.includes(terminalId),
    );
    if (additions.length === 0 && !targetTerminalId) return normalized;
    if (targetTerminalIds.length + additions.length > MAX_TERMINALS_PER_GROUP) {
      return normalized;
    }
  } else if (requestedTerminalIds.length > MAX_TERMINALS_PER_GROUP) {
    return normalized;
  }

  const requestedTerminalIdSet = new Set(requestedTerminalIds);
  const copiedGroups = copyTerminalGroups(normalized.terminalGroups);
  const groupsAfterRemoval: ThreadTerminalGroup[] = [];
  for (const group of copiedGroups) {
    let nextGroup: ThreadTerminalGroup | null = group;
    for (const terminalId of requestedTerminalIds) {
      if (targetGroup?.id === group.id && !targetTerminalId) continue;
      if (!requestedTerminalIdSet.has(terminalId)) continue;
      if (sourceGroupByTerminalId.get(terminalId)?.id !== group.id) continue;
      nextGroup = nextGroup ? removeTerminalFromGroupLayout(nextGroup, terminalId) : null;
    }
    if (nextGroup) groupsAfterRemoval.push(nextGroup);
  }

  const lastMovedTerminalId = requestedTerminalIds.at(-1);
  if (!lastMovedTerminalId) return normalized;

  let nextTargetGroupId: string;
  if (targetGroup) {
    const destinationIndex = groupsAfterRemoval.findIndex((group) => group.id === targetGroup.id);
    const destination = groupsAfterRemoval[destinationIndex];
    if (destinationIndex < 0 || !destination) return normalized;
    let nextDestination = destination;
    const existingTargetIds = new Set(collectTerminalIdsFromLayout(destination.layout));
    for (const terminalId of requestedTerminalIds) {
      if (!targetTerminalId && existingTargetIds.has(terminalId)) continue;
      nextDestination = addTerminalTabToGroupLayout(
        nextDestination,
        targetTerminalId ?? nextDestination.activeTerminalId,
        terminalId,
      );
    }
    groupsAfterRemoval[destinationIndex] = setActiveTerminalInGroupLayout(
      nextDestination,
      lastMovedTerminalId,
    );
    nextTargetGroupId = targetGroup.id;
  } else {
    if (target.kind !== "new-group") return normalized;
    const firstMovedTerminalId = requestedTerminalIds[0];
    if (!firstMovedTerminalId) return normalized;
    const usedGroupIds = new Set(groupsAfterRemoval.map((group) => group.id));
    nextTargetGroupId = assignUniqueGroupId(fallbackGroupId(firstMovedTerminalId), usedGroupIds);
    let nextGroup = createNamedTerminalGroup(normalized, nextTargetGroupId, firstMovedTerminalId);
    for (const terminalId of requestedTerminalIds.slice(1)) {
      nextGroup = addTerminalTabToGroupLayout(nextGroup, nextGroup.activeTerminalId, terminalId);
    }
    groupsAfterRemoval.push(nextGroup);
    if (target.toIndex !== undefined) {
      const reorderedGroups = reorderActiveTerminalGroupInList({
        groups: groupsAfterRemoval,
        groupId: nextTargetGroupId,
        toIndex: target.toIndex,
        changedAt: Date.now(),
      });
      groupsAfterRemoval.splice(0, groupsAfterRemoval.length, ...reorderedGroups);
    }
  }

  return normalizeThreadTerminalState({
    ...normalized,
    terminalGroups: groupsAfterRemoval,
    activeTerminalGroupId: nextTargetGroupId,
    activeTerminalId: lastMovedTerminalId,
  });
}

function setThreadTerminalExitState(
  state: ThreadTerminalState,
  terminalId: string,
  exitState: TerminalExitState | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) return normalized;
  const terminalExitStatesById = { ...normalized.terminalExitStatesById };
  if (exitState === null) delete terminalExitStatesById[terminalId];
  else terminalExitStatesById[terminalId] = exitState;
  const terminalAttentionStatesById = { ...normalized.terminalAttentionStatesById };
  if (exitState !== null) delete terminalAttentionStatesById[terminalId];
  return {
    ...normalized,
    terminalExitStatesById,
    terminalAttentionStatesById,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
  };
}

function setThreadTerminalLaunchMetadata(
  state: ThreadTerminalState,
  terminalId: string,
  metadata: TerminalLaunchMetadata | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) return normalized;
  const terminalLaunchMetadataById = { ...normalized.terminalLaunchMetadataById };
  if (metadata === null) delete terminalLaunchMetadataById[terminalId];
  else terminalLaunchMetadataById[terminalId] = metadata;
  return normalizeThreadTerminalState({ ...normalized, terminalLaunchMetadataById });
}

function resizeThreadTerminalSplit(
  state: ThreadTerminalState,
  groupId: string,
  splitId: string,
  weights: number[],
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const groupIndex = normalized.terminalGroups.findIndex((group) => group.id === groupId);
  if (groupIndex < 0) {
    return normalized;
  }
  const group = normalized.terminalGroups[groupIndex];
  if (!group) {
    return normalized;
  }
  const nextGroup = resizeTerminalGroupLayout(group, splitId, weights);
  if (nextGroup === group) {
    return normalized;
  }
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  terminalGroups[groupIndex] = nextGroup;
  return normalizeThreadTerminalState({
    ...normalized,
    terminalGroups,
  });
}

function openThreadTerminalFullWidth(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const nextState = newThreadTerminal(state, terminalId);
  return normalizeThreadTerminalState({
    ...nextState,
    terminalOpen: true,
    presentationMode: "workspace",
    workspaceLayout: "terminal-only",
    workspaceActiveTab: "terminal",
    activeTerminalId: terminalId,
  });
}

function closeThreadWorkspaceChat(state: ThreadTerminalState): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.workspaceLayout === "terminal-only") {
    return normalized;
  }
  return {
    ...normalized,
    workspaceLayout: "terminal-only",
    workspaceActiveTab: "terminal",
  };
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  activity: { agentState: TerminalActivityState | null; hasRunningSubprocess: boolean },
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  const nextTerminalAttentionState =
    activity.agentState === "attention" || activity.agentState === "review"
      ? activity.agentState
      : null;
  const currentTerminalAttentionState = normalized.terminalAttentionStatesById[terminalId] ?? null;
  if (
    activity.hasRunningSubprocess === alreadyRunning &&
    nextTerminalAttentionState === currentTerminalAttentionState
  ) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (activity.hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  const terminalAttentionStatesById = { ...normalized.terminalAttentionStatesById };
  if (nextTerminalAttentionState === null) {
    delete terminalAttentionStatesById[terminalId];
  } else {
    terminalAttentionStatesById[terminalId] = nextTerminalAttentionState;
  }
  return {
    ...normalized,
    terminalAttentionStatesById,
    terminalExitStatesById: activity.hasRunningSubprocess
      ? Object.fromEntries(
          Object.entries(normalized.terminalExitStatesById).filter(([id]) => id !== terminalId),
        )
      : normalized.terminalExitStatesById,
    runningTerminalIds: [...runningTerminalIds],
  };
}

function applyThreadWorkspaceLayoutPreset(
  state: ThreadTerminalState,
  presetId: WorkspaceLayoutPresetId,
  terminalIds: readonly string[],
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextTerminalIds = normalizeTerminalIds([...terminalIds]);
  const activeTerminalId = nextTerminalIds.includes(normalized.activeTerminalId)
    ? normalized.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalLabelsById = ensureTerminalLabels({
    terminalCliKindsById: normalizeTerminalCliKinds(
      normalized.terminalCliKindsById,
      nextTerminalIds,
    ),
    terminalIds: nextTerminalIds,
    terminalLabelsById: normalizeTerminalLabels(normalized.terminalLabelsById, nextTerminalIds),
    terminalTitleOverridesById: normalizeTerminalTitleOverrides(
      normalized.terminalTitleOverridesById,
      nextTerminalIds,
    ),
  });
  const terminalTitleOverridesById = normalizeTerminalTitleOverrides(
    normalized.terminalTitleOverridesById,
    nextTerminalIds,
  );
  const terminalCliKindsById = normalizeTerminalCliKinds(
    normalized.terminalCliKindsById,
    nextTerminalIds,
  );
  const terminalGroup = createWorkspaceTerminalGroupFromPreset({
    presetId,
    terminalIds: nextTerminalIds,
    activeTerminalId,
  });

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    presentationMode: "workspace",
    workspaceLayout: "terminal-only",
    workspaceActiveTab: "terminal",
    terminalIds: nextTerminalIds,
    terminalLabelsById,
    terminalTitleOverridesById,
    terminalCliKindsById,
    terminalAttentionStatesById: normalizeTerminalAttentionStates(
      normalized.terminalAttentionStatesById,
      nextTerminalIds,
    ),
    runningTerminalIds: normalizeRunningTerminalIds(normalized.runningTerminalIds, nextTerminalIds),
    activeTerminalId,
    terminalGroups: [terminalGroup],
    activeTerminalGroupId: terminalGroup.id,
  });
}

export function selectThreadTerminalState(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
): ThreadTerminalState {
  if (threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByThreadId[threadId] ?? getDefaultThreadTerminalState();
}

function updateTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<ThreadId, ThreadTerminalState> {
  if (threadId.length === 0) {
    return terminalStateByThreadId;
  }

  const current = selectThreadTerminalState(terminalStateByThreadId, threadId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadId;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadId[threadId] === undefined) {
      return terminalStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = terminalStateByThreadId;
    return rest as Record<ThreadId, ThreadTerminalState>;
  }

  return {
    ...terminalStateByThreadId,
    [threadId]: next,
  };
}

interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  openChatThreadPage: (threadId: ThreadId) => void;
  openTerminalThreadPage: (threadId: ThreadId, options?: { terminalOnly?: boolean }) => void;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalPresentationMode: (threadId: ThreadId, mode: ThreadTerminalPresentationMode) => void;
  setTerminalWorkspaceLayout: (threadId: ThreadId, layout: ThreadTerminalWorkspaceLayout) => void;
  setTerminalWorkspaceTab: (threadId: ThreadId, tab: ThreadTerminalWorkspaceTab) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  setTerminalMetadata: (
    threadId: ThreadId,
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  setTerminalCliKind: (
    threadId: ThreadId,
    terminalId: string,
    cliKind: TerminalCliKind | null,
  ) => void;
  setTerminalTitleOverride: (
    threadId: ThreadId,
    terminalId: string,
    titleOverride: string | null | undefined,
  ) => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalLeft: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalRight: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalDown: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalUp: (threadId: ThreadId, terminalId: string) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  newTerminalTab: (threadId: ThreadId, targetTerminalId: string, terminalId: string) => void;
  openNewFullWidthTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeWorkspaceChat: (threadId: ThreadId) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminalGroup: (threadId: ThreadId, groupId: string) => void;
  renameTerminalGroup: (threadId: ThreadId, groupId: string, name: string) => void;
  setTerminalGroupRole: (threadId: ThreadId, groupId: string, role: TerminalGroupRole) => void;
  archiveTerminalGroup: (threadId: ThreadId, groupId: string) => void;
  restoreTerminalGroup: (threadId: ThreadId, groupId: string) => void;
  reorderTerminalGroup: (threadId: ThreadId, groupId: string, toIndex: number) => void;
  moveTerminals: (
    threadId: ThreadId,
    terminalIds: readonly string[],
    target: TerminalMoveTarget,
  ) => void;
  setShowArchivedTerminalGroups: (threadId: ThreadId, show: boolean) => void;
  setTerminalExitState: (
    threadId: ThreadId,
    terminalId: string,
    exitState: TerminalExitState | null,
  ) => void;
  setTerminalLaunchMetadata: (
    threadId: ThreadId,
    terminalId: string,
    metadata: TerminalLaunchMetadata | null,
  ) => void;
  resizeTerminalSplit: (
    threadId: ThreadId,
    groupId: string,
    splitId: string,
    weights: number[],
  ) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    activity: { agentState: TerminalActivityState | null; hasRunningSubprocess: boolean },
  ) => void;
  applyWorkspaceLayoutPreset: (
    threadId: ThreadId,
    presetId: WorkspaceLayoutPresetId,
    terminalIds: readonly string[],
  ) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}

// Defers partialize + JSON.stringify off the hot set() path (terminal layout
// changes, resizes, activity updates fire rapidly). Serialization now runs once
// per debounce window at flush time instead of synchronously on every set().
const terminalPersistStorage = createDeferredPersistStorage<
  TerminalStateStoreState,
  Pick<TerminalStateStoreState, "terminalStateByThreadId">
>({
  getStorage: () => localStorage,
  partialize: (state) => ({
    terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
      state.terminalStateByThreadId,
    ),
  }),
});

// Flush pending terminal-state writes before the page goes away so at most one
// debounce window of changes can be lost.
flushStorageBeforePageHide(() => terminalPersistStorage.flush());

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadId: ThreadId,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
            state.terminalStateByThreadId,
            threadId,
            updater,
          );
          if (nextTerminalStateByThreadId === state.terminalStateByThreadId) {
            return state;
          }
          return {
            terminalStateByThreadId: nextTerminalStateByThreadId,
          };
        });
      };

      return {
        terminalStateByThreadId: {},
        openChatThreadPage: (threadId) =>
          updateTerminal(threadId, (state) => openThreadChatPage(state)),
        openTerminalThreadPage: (threadId, options) =>
          updateTerminal(threadId, (state) => openThreadTerminalPage(state, options)),
        setTerminalOpen: (threadId, open) =>
          updateTerminal(threadId, (state) => setThreadTerminalOpen(state, open)),
        setTerminalPresentationMode: (threadId, mode) =>
          updateTerminal(threadId, (state) => setThreadTerminalPresentationMode(state, mode)),
        setTerminalWorkspaceLayout: (threadId, layout) =>
          updateTerminal(threadId, (state) => setThreadTerminalWorkspaceLayout(state, layout)),
        setTerminalWorkspaceTab: (threadId, tab) =>
          updateTerminal(threadId, (state) => setThreadTerminalWorkspaceTab(state, tab)),
        setTerminalHeight: (threadId, height) =>
          updateTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
        setTerminalMetadata: (threadId, terminalId, metadata) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalMetadata(state, terminalId, metadata),
          ),
        setTerminalCliKind: (threadId, terminalId, cliKind) =>
          updateTerminal(threadId, (state) => setThreadTerminalCliKind(state, terminalId, cliKind)),
        setTerminalTitleOverride: (threadId, terminalId, titleOverride) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalTitleOverride(state, terminalId, titleOverride),
          ),
        splitTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        splitTerminalLeft: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminalLeft(state, terminalId)),
        splitTerminalRight: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        splitTerminalDown: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminalDown(state, terminalId)),
        splitTerminalUp: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminalUp(state, terminalId)),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
        newTerminalTab: (threadId, targetTerminalId, terminalId) =>
          updateTerminal(threadId, (state) =>
            newThreadTerminalTab(state, targetTerminalId, terminalId),
          ),
        openNewFullWidthTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => openThreadTerminalFullWidth(state, terminalId)),
        closeWorkspaceChat: (threadId) =>
          updateTerminal(threadId, (state) => closeThreadWorkspaceChat(state)),
        setActiveTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
        closeTerminalGroup: (threadId, groupId) =>
          updateTerminal(threadId, (state) => closeThreadTerminalGroup(state, groupId)),
        renameTerminalGroup: (threadId, groupId, name) =>
          updateTerminal(threadId, (state) => renameThreadTerminalGroup(state, groupId, name)),
        setTerminalGroupRole: (threadId, groupId, role) =>
          updateTerminal(threadId, (state) => setThreadTerminalGroupRole(state, groupId, role)),
        archiveTerminalGroup: (threadId, groupId) =>
          updateTerminal(threadId, (state) => archiveThreadTerminalGroup(state, groupId)),
        restoreTerminalGroup: (threadId, groupId) =>
          updateTerminal(threadId, (state) => restoreThreadTerminalGroup(state, groupId)),
        reorderTerminalGroup: (threadId, groupId, toIndex) =>
          updateTerminal(threadId, (state) => reorderThreadTerminalGroup(state, groupId, toIndex)),
        moveTerminals: (threadId, terminalIds, target) =>
          updateTerminal(threadId, (state) => moveThreadTerminals(state, terminalIds, target)),
        setShowArchivedTerminalGroups: (threadId, show) =>
          updateTerminal(threadId, (state) => {
            const normalized = normalizeThreadTerminalState(state);
            return normalized.showArchivedTerminalGroups === show
              ? normalized
              : { ...normalized, showArchivedTerminalGroups: show };
          }),
        setTerminalExitState: (threadId, terminalId, exitState) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalExitState(state, terminalId, exitState),
          ),
        setTerminalLaunchMetadata: (threadId, terminalId, metadata) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalLaunchMetadata(state, terminalId, metadata),
          ),
        resizeTerminalSplit: (threadId, groupId, splitId, weights) =>
          updateTerminal(threadId, (state) =>
            resizeThreadTerminalSplit(state, groupId, splitId, weights),
          ),
        setTerminalActivity: (threadId, terminalId, activity) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalActivity(state, terminalId, activity),
          ),
        applyWorkspaceLayoutPreset: (threadId, presetId, terminalIds) =>
          updateTerminal(threadId, (state) =>
            applyThreadWorkspaceLayoutPreset(state, presetId, terminalIds),
          ),
        clearTerminalState: (threadId) =>
          updateTerminal(threadId, () => createDefaultThreadTerminalState()),
        removeOrphanedTerminalStates: (activeThreadIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            if (orphanedIds.length === 0) return state;
            const next = { ...state.terminalStateByThreadId };
            for (const id of orphanedIds) {
              delete next[id as ThreadId];
            }
            return { terminalStateByThreadId: next };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 3,
      migrate: (persistedState) => {
        const persisted = persistedState as Partial<TerminalStateStoreState> | undefined;
        return {
          terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
            persisted?.terminalStateByThreadId,
          ),
        };
      },
      // partialize is owned by the deferred storage (runs at flush time, not
      // eagerly on every set()).
      storage: terminalPersistStorage,
      merge: (persistedState, currentState) => ({
        ...currentState,
        terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
          (persistedState as Partial<TerminalStateStoreState> | undefined)?.terminalStateByThreadId,
        ),
      }),
    },
  ),
);
