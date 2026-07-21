// FILE: terminalGroups.ts
// Purpose: Pure semantic terminal-group normalization, lifecycle, ordering, and status helpers.
// Layer: Terminal domain helpers

import type { TerminalCliKind } from "@synara/shared/terminalThreads";
import type {
  NormalizedThreadTerminalGroup,
  TerminalExitState,
  TerminalGroupAccent,
  TerminalGroupIcon,
  TerminalGroupRole,
  ThreadTerminalGroup,
} from "../types";

export const LEGACY_TERMINAL_GROUP_TIMESTAMP = 0;

const ROLE_PRESENTATION: Record<
  TerminalGroupRole,
  { accent: TerminalGroupAccent; icon: TerminalGroupIcon; label: string }
> = {
  app: { accent: "blue", icon: "app-window", label: "App" },
  verify: { accent: "green", icon: "check-circle", label: "Verify" },
  observe: { accent: "amber", icon: "activity", label: "Observe" },
  agent: { accent: "violet", icon: "bot", label: "Agent" },
  data: { accent: "cyan", icon: "database", label: "Data" },
  infrastructure: { accent: "orange", icon: "server", label: "Infrastructure" },
  custom: { accent: "neutral", icon: "terminal", label: "Terminal" },
};

export type TerminalGroupRuntimeStatus =
  | "failed"
  | "attention"
  | "running"
  | "stopped"
  | "idle"
  | "archived";

export interface TerminalGroupStatusSummary {
  status: TerminalGroupRuntimeStatus;
  runningCount: number;
  failedCount: number;
  attentionCount: number;
  stoppedCount: number;
  label: string;
}

function isRole(value: unknown): value is TerminalGroupRole {
  return (
    value === "app" ||
    value === "verify" ||
    value === "observe" ||
    value === "agent" ||
    value === "data" ||
    value === "infrastructure" ||
    value === "custom"
  );
}

function isIcon(value: unknown): value is TerminalGroupIcon {
  return (
    value === "app-window" ||
    value === "check-circle" ||
    value === "activity" ||
    value === "bot" ||
    value === "database" ||
    value === "server" ||
    value === "terminal"
  );
}

function isAccent(value: unknown): value is TerminalGroupAccent {
  return (
    value === "blue" ||
    value === "green" ||
    value === "amber" ||
    value === "violet" ||
    value === "cyan" ||
    value === "orange" ||
    value === "neutral"
  );
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function terminalGroupPresentation(role: TerminalGroupRole): {
  accent: TerminalGroupAccent;
  icon: TerminalGroupIcon;
  label: string;
} {
  return ROLE_PRESENTATION[role];
}

export function inferTerminalGroupRole(input: {
  cliKinds?: readonly (TerminalCliKind | null | undefined)[];
  token?: string | null | undefined;
}): TerminalGroupRole {
  if (input.cliKinds?.some((kind) => kind === "codex" || kind === "claude")) return "agent";
  const token = input.token?.trim().toLowerCase() ?? "";
  if (/\b(test|tests|lint|typecheck|verify|validation|review|build|checks?)\b/.test(token)) {
    return "verify";
  }
  if (/\b(logs?|watch|monitor|observe|metrics?|tail)\b/.test(token)) return "observe";
  if (/\b(python|data|jupyter|notebook|ml|model|database|db)\b/.test(token)) return "data";
  if (/\b(infra|deploy|docker|compose|kubernetes|k8s|terraform|release)\b/.test(token)) {
    return "infrastructure";
  }
  if (/\b(app|web|frontend|server|api|dev)\b/.test(token)) return "app";
  return "custom";
}

export function normalizeTerminalGroupMetadata(
  group: Partial<ThreadTerminalGroup>,
  options: {
    fallbackIndex?: number;
    fallbackName?: string | null;
    cliKinds?: readonly (TerminalCliKind | null | undefined)[];
  } = {},
): Omit<NormalizedThreadTerminalGroup, "id" | "activeTerminalId" | "layout"> {
  const fallbackIndex = options.fallbackIndex ?? 0;
  const token =
    group.name?.trim() || options.fallbackName?.trim() || `Terminal ${fallbackIndex + 1}`;
  const role = isRole(group.role)
    ? group.role
    : inferTerminalGroupRole({ cliKinds: options.cliKinds, token });
  const presentation = terminalGroupPresentation(role);
  const createdAt = finiteTimestamp(group.createdAt, LEGACY_TERMINAL_GROUP_TIMESTAMP);
  const updatedAt = finiteTimestamp(group.updatedAt, createdAt);
  return {
    name: token,
    role,
    icon: isIcon(group.icon) ? group.icon : presentation.icon,
    accent: isAccent(group.accent) ? group.accent : presentation.accent,
    archivedAt:
      group.archivedAt === null
        ? null
        : typeof group.archivedAt === "number" && Number.isFinite(group.archivedAt)
          ? Math.max(0, group.archivedAt)
          : null,
    originalIndex: optionalIndex(group.originalIndex),
    createdAt,
    updatedAt,
    userNamed: group.userNamed === true,
  };
}

export function activeTerminalGroups(
  groups: readonly ThreadTerminalGroup[],
): ThreadTerminalGroup[] {
  return groups.filter((group) => group.archivedAt == null);
}

export function archivedTerminalGroups(
  groups: readonly ThreadTerminalGroup[],
): ThreadTerminalGroup[] {
  return groups.filter((group) => group.archivedAt != null);
}

export function archiveTerminalGroupInList(input: {
  groups: readonly ThreadTerminalGroup[];
  groupId: string;
  archivedAt: number;
}): ThreadTerminalGroup[] {
  const active = activeTerminalGroups(input.groups);
  const activeIndex = active.findIndex((group) => group.id === input.groupId);
  if (activeIndex < 0) return [...input.groups];
  return input.groups.map((group) =>
    group.id === input.groupId
      ? {
          ...group,
          archivedAt: Math.max(0, input.archivedAt),
          originalIndex: activeIndex,
          updatedAt: Math.max(group.updatedAt ?? LEGACY_TERMINAL_GROUP_TIMESTAMP, input.archivedAt),
        }
      : group,
  );
}

export function restoreTerminalGroupInList(input: {
  groups: readonly ThreadTerminalGroup[];
  groupId: string;
  restoredAt: number;
}): ThreadTerminalGroup[] {
  const target = input.groups.find(
    (group) => group.id === input.groupId && group.archivedAt != null,
  );
  if (!target) return [...input.groups];
  const active = activeTerminalGroups(input.groups);
  const targetIndex = Math.min(target.originalIndex ?? active.length, active.length);
  const restored = {
    ...target,
    archivedAt: null,
    originalIndex: null,
    updatedAt: Math.max(target.updatedAt ?? LEGACY_TERMINAL_GROUP_TIMESTAMP, input.restoredAt),
  };
  active.splice(targetIndex, 0, restored);
  const activeQueue = [...active];
  const merged = input.groups
    .filter((group) => group.id !== target.id)
    .map((group) => (group.archivedAt == null ? (activeQueue.shift() ?? group) : group));
  const remainingActive = activeQueue;
  if (remainingActive.length > 0) merged.push(...remainingActive);
  return merged;
}

export function reorderActiveTerminalGroupInList(input: {
  groups: readonly ThreadTerminalGroup[];
  groupId: string;
  toIndex: number;
  changedAt: number;
}): ThreadTerminalGroup[] {
  const active = activeTerminalGroups(input.groups);
  const fromIndex = active.findIndex((group) => group.id === input.groupId);
  if (fromIndex < 0) return [...input.groups];
  const [moving] = active.splice(fromIndex, 1);
  if (!moving) return [...input.groups];
  const toIndex = Math.max(0, Math.min(Math.trunc(input.toIndex), active.length));
  active.splice(toIndex, 0, {
    ...moving,
    updatedAt: Math.max(moving.updatedAt ?? LEGACY_TERMINAL_GROUP_TIMESTAMP, input.changedAt),
  });
  const activeQueue = [...active];
  return input.groups.map((group) =>
    group.archivedAt == null ? (activeQueue.shift() ?? group) : group,
  );
}

export function resolveTerminalGroupStatus(input: {
  archived: boolean;
  terminalIds: readonly string[];
  runningTerminalIds: ReadonlySet<string>;
  attentionStatesById: Readonly<Record<string, "attention" | "review">>;
  exitStatesById: Readonly<Record<string, TerminalExitState>>;
}): TerminalGroupStatusSummary {
  const failedCount = input.terminalIds.filter(
    (terminalId) => input.exitStatesById[terminalId]?.kind === "failed",
  ).length;
  const attentionCount = input.terminalIds.filter(
    (terminalId) => input.attentionStatesById[terminalId] !== undefined,
  ).length;
  const runningCount = input.terminalIds.filter((terminalId) =>
    input.runningTerminalIds.has(terminalId),
  ).length;
  const stoppedCount = input.terminalIds.filter(
    (terminalId) => input.exitStatesById[terminalId]?.kind === "stopped",
  ).length;
  const status: TerminalGroupRuntimeStatus = input.archived
    ? "archived"
    : failedCount > 0
      ? "failed"
      : attentionCount > 0
        ? "attention"
        : runningCount > 0
          ? "running"
          : stoppedCount > 0
            ? "stopped"
            : "idle";
  const label =
    status === "archived"
      ? "Archived"
      : status === "failed"
        ? `${failedCount} failed`
        : status === "attention"
          ? `${attentionCount} need attention`
          : status === "running"
            ? `${runningCount} running`
            : status === "stopped"
              ? `${stoppedCount} stopped`
              : "Idle";
  return { status, runningCount, failedCount, attentionCount, stoppedCount, label };
}
