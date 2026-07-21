// FILE: TerminalChrome.tsx
// Purpose: Reusable terminal chrome primitives for tab bars, sidebars, and toolbar actions.
// Layer: Terminal presentation components
// Depends on: terminal visual identities plus shared popover/button styling.
//
// Note: raw <button> usage in this file is intentional. These are tab-strip and
// list-row affordances (activate tab, close tab, terminal row, group header)
// rather than generic action buttons, so they live outside the shadcn Button
// taxonomy. When/if we introduce a shared Tabs primitive, these can migrate.

import { Fragment, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import type { ResolvedTerminalVisualIdentity } from "@synara/shared/terminalThreads";

import { IconButton } from "~/components/ui/icon-button";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { RenameDialog } from "~/components/RenameDialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  EllipsisIcon,
  EyeIcon,
  FolderIcon,
  GlobeIcon,
  PencilIcon,
  RefreshCwIcon,
  TerminalIcon,
  Trash2,
  WindowIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { resolveTerminalGroupStatus } from "~/lib/terminalGroups";
import { terminalVisualStateLabel } from "~/terminalVisualIdentity";
import type { TerminalExitState, TerminalGroupAccent, TerminalGroupRole } from "~/types";

import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../chat/chatHeaderControls";
import type { ResolvedTerminalGroupLayout } from "./TerminalLayout";
import TerminalActivityIndicator from "./TerminalActivityIndicator";
import TerminalIdentityIcon from "./TerminalIdentityIcon";
import {
  readTerminalDragPayload,
  TERMINAL_DRAG_MIME,
  writeTerminalDragPayload,
} from "./terminalDragAndDrop";

export interface TerminalChromeActionItem {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalChromeActions(props: {
  actions: ReadonlyArray<TerminalChromeActionItem>;
  variant: "compact" | "workspace" | "sidebar";
}) {
  const buttonClassName =
    props.variant === "sidebar"
      ? "!size-6 shrink-0 rounded-md [&_svg,&_[data-slot=central-icon]]:mx-0"
      : DOCK_HEADER_ICON_BUTTON_CLASS;

  return (
    <div className="inline-flex items-center gap-0.5">
      {props.actions.map((action) => (
        <IconButton
          key={action.label}
          className={cn(buttonClassName, action.disabled ? "pointer-events-none opacity-45" : "")}
          label={action.label}
          tooltip={action.label}
          tooltipSide="bottom"
          size="icon-xs"
          variant="chrome"
          disabled={action.disabled}
          onClick={() => {
            if (action.disabled) return;
            action.onClick();
          }}
        >
          {action.children}
        </IconButton>
      ))}
    </div>
  );
}

export function TerminalWorkspaceTabBar(props: {
  terminalGroups: ResolvedTerminalGroupLayout[];
  archivedTerminalGroups?: ResolvedTerminalGroupLayout[] | undefined;
  activeGroupId: string | null;
  showArchived?: boolean | undefined;
  runningTerminalIds?: readonly string[] | undefined;
  terminalAttentionStatesById?: Record<string, "attention" | "review"> | undefined;
  terminalExitStatesById?: Record<string, TerminalExitState> | undefined;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
  actions: ReadonlyArray<TerminalChromeActionItem>;
  createMenu?: ReactNode | undefined;
  onActiveGroupChange: (groupId: string) => void;
  onArchiveGroup?: ((groupId: string) => void) | undefined;
  onRenameGroup?: ((groupId: string, name: string) => void) | undefined;
  onRoleChange?: ((groupId: string, role: TerminalGroupRole) => void) | undefined;
  onStopGroup?: ((groupId: string) => void) | undefined;
  onRestoreGroup?: ((groupId: string) => void) | undefined;
  onReorderGroup?: ((groupId: string, toIndex: number) => void) | undefined;
  selectedTerminalIds?: readonly string[] | undefined;
  onMoveTerminalsToGroup?: ((terminalIds: readonly string[], groupId: string) => void) | undefined;
  onMoveTerminalsToNewGroup?:
    | ((terminalIds: readonly string[], toIndex?: number) => void)
    | undefined;
  onShowArchivedChange?: ((show: boolean) => void) | undefined;
  onCloseGroup: (groupId: string) => void;
}) {
  const [renameTarget, setRenameTarget] = useState<{
    groupId: string;
    name: string;
  } | null>(null);
  const archivedGroups = props.archivedTerminalGroups ?? [];
  const selectedTerminalIds = props.selectedTerminalIds ?? [];
  const runningTerminalIdSet = new Set(props.runningTerminalIds ?? []);
  const statusForGroup = (group: ResolvedTerminalGroupLayout) =>
    resolveTerminalGroupStatus({
      archived: group.archivedAt !== null,
      terminalIds: group.terminalIds,
      runningTerminalIds: runningTerminalIdSet,
      attentionStatesById: props.terminalAttentionStatesById ?? {},
      exitStatesById: props.terminalExitStatesById ?? {},
    });
  const focusGroupAt = (index: number) => {
    const clampedIndex = Math.max(0, Math.min(index, props.terminalGroups.length - 1));
    const group = props.terminalGroups[clampedIndex];
    if (!group) return;
    props.onActiveGroupChange(group.id);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-terminal-group-id="${CSS.escape(group.id)}"]`)
        ?.focus();
    });
  };
  const onGroupKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusGroupAt(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusGroupAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusGroupAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusGroupAt(props.terminalGroups.length - 1);
    }
  };
  const allowTerminalDragOver = (event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(TERMINAL_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const dropOnGroup = (
    event: DragEvent<HTMLElement>,
    targetGroupId: string,
    targetIndex: number,
  ) => {
    const payload = readTerminalDragPayload(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    if (payload.kind === "terminals") {
      props.onMoveTerminalsToGroup?.(payload.terminalIds, targetGroupId);
    } else if (payload.groupId !== targetGroupId) {
      props.onReorderGroup?.(payload.groupId, targetIndex);
    }
  };
  const newGroupGap = (toIndex: number, end: boolean) =>
    props.onMoveTerminalsToNewGroup ? (
      <button
        type="button"
        data-terminal-new-group-drop-target
        data-terminal-new-group-index={toIndex}
        aria-label={
          end
            ? "Move selected terminals to new group"
            : `Move selected terminals to new group at position ${toIndex + 1}`
        }
        aria-disabled={selectedTerminalIds.length === 0}
        className="group/gap flex h-7 w-3 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-secondary/70 focus-visible:w-7 focus-visible:ring-1 focus-visible:ring-ring/60 aria-disabled:opacity-60"
        title={`Create a new group at position ${toIndex + 1}`}
        onClick={() => {
          if (selectedTerminalIds.length > 0) {
            props.onMoveTerminalsToNewGroup?.(selectedTerminalIds, toIndex);
          }
        }}
        onDragOver={allowTerminalDragOver}
        onDrop={(event) => {
          const payload = readTerminalDragPayload(event.dataTransfer);
          if (payload?.kind !== "terminals") return;
          event.preventDefault();
          props.onMoveTerminalsToNewGroup?.(payload.terminalIds, toIndex);
        }}
      >
        <span className="h-4 w-px border-l border-dashed border-border group-hover/gap:border-foreground/60" />
      </button>
    ) : null;
  const narrowActiveGroup = props.terminalGroups.find((group) => group.id === props.activeGroupId);
  const narrowActiveGroupIndex = narrowActiveGroup
    ? props.terminalGroups.indexOf(narrowActiveGroup)
    : -1;
  return (
    <div className="border-b border-border/60 bg-[var(--color-background-surface)]">
      <div className="flex min-h-9 min-w-0 items-center gap-1 px-1.5 py-1">
        <label className="min-w-0 flex-1 sm:hidden">
          <span className="sr-only">Active terminal group</span>
          <select
            className="h-7 w-full rounded-md border border-border/70 bg-transparent px-2 text-xs"
            value={props.activeGroupId ?? ""}
            onChange={(event) => props.onActiveGroupChange(event.currentTarget.value)}
          >
            {props.terminalGroups.map((group) => {
              const status = statusForGroup(group);
              return (
                <option key={group.id} value={group.id}>
                  {group.name} — {status.label}
                </option>
              );
            })}
            {props.terminalGroups.length === 0 ? (
              <option value="">All groups archived</option>
            ) : null}
          </select>
        </label>
        {narrowActiveGroup ? (
          <Menu>
            <MenuTrigger
              aria-label={`Manage ${narrowActiveGroup.name}`}
              className="sm:hidden"
              render={<Button size="icon-xs" variant="chrome" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-48">
              <MenuItem
                disabled={narrowActiveGroupIndex <= 0}
                onClick={() =>
                  props.onReorderGroup?.(narrowActiveGroup.id, narrowActiveGroupIndex - 1)
                }
              >
                <ArrowLeftIcon />
                Move left
              </MenuItem>
              <MenuItem
                disabled={narrowActiveGroupIndex >= props.terminalGroups.length - 1}
                onClick={() =>
                  props.onReorderGroup?.(narrowActiveGroup.id, narrowActiveGroupIndex + 1)
                }
              >
                <ArrowRightIcon />
                Move right
              </MenuItem>
              {selectedTerminalIds.length > 0
                ? props.terminalGroups
                    .filter((group) => group.id !== narrowActiveGroup.id)
                    .map((group) => (
                      <MenuItem
                        key={group.id}
                        onClick={() =>
                          props.onMoveTerminalsToGroup?.(selectedTerminalIds, group.id)
                        }
                      >
                        Move {selectedTerminalIds.length} selected to {group.name} —{" "}
                        {statusForGroup(group).label}
                      </MenuItem>
                    ))
                : null}
              {selectedTerminalIds.length > 0 ? (
                <MenuItem onClick={() => props.onMoveTerminalsToNewGroup?.(selectedTerminalIds)}>
                  Move {selectedTerminalIds.length} selected to new group
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  setRenameTarget({
                    groupId: narrowActiveGroup.id,
                    name: narrowActiveGroup.name,
                  });
                }}
              >
                <PencilIcon />
                Rename…
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger>Change role</MenuSubTrigger>
                <MenuSubPopup surface="composer">
                  {TERMINAL_GROUP_ROLES.map((role) => (
                    <MenuItem
                      key={role}
                      onClick={() => props.onRoleChange?.(narrowActiveGroup.id, role)}
                    >
                      {role === narrowActiveGroup.role ? "✓ " : ""}
                      {role[0]?.toUpperCase()}
                      {role.slice(1)}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
              {narrowActiveGroup.terminalIds.some((terminalId) =>
                runningTerminalIdSet.has(terminalId),
              ) ? (
                <MenuItem onClick={() => props.onStopGroup?.(narrowActiveGroup.id)}>
                  Stop all running terminals
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => props.onArchiveGroup?.(narrowActiveGroup.id)}>
                <ArchiveIcon />
                Archive group
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() => props.onCloseGroup(narrowActiveGroup.id)}
              >
                <Trash2 />
                Close and remove
              </MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        ) : null}
        <div
          className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] sm:flex [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Terminal groups"
        >
          {props.terminalGroups.map((terminalGroup, index) => {
            const RoleIcon = ROLE_ICON[terminalGroup.role];
            const isActive = terminalGroup.id === props.activeGroupId;
            const status = statusForGroup(terminalGroup);
            const activityState =
              status.status === "attention"
                ? "attention"
                : status.status === "running"
                  ? "running"
                  : status.status === "failed" || status.status === "stopped"
                    ? status.status
                    : null;
            return (
              <Fragment key={terminalGroup.id}>
                {newGroupGap(index, false)}
                <div
                  className="group flex shrink-0 items-center rounded-md border border-transparent data-[active=true]:border-border/70 data-[active=true]:bg-secondary/60"
                  data-active={isActive}
                  onDragOver={allowTerminalDragOver}
                  onDrop={(event) => dropOnGroup(event, terminalGroup.id, index)}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`terminal-group-tab-${terminalGroup.id}`}
                    aria-controls={`terminal-group-panel-${terminalGroup.id}`}
                    aria-selected={isActive}
                    aria-label={`${terminalGroup.name}, ${status.label}, ${terminalGroup.terminalIds.length} terminal${terminalGroup.terminalIds.length === 1 ? "" : "s"}`}
                    tabIndex={isActive || props.activeGroupId === null ? 0 : -1}
                    data-terminal-group-id={terminalGroup.id}
                    className="flex h-7 max-w-48 items-center gap-1.5 rounded-l-md px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 data-[active=true]:text-foreground"
                    data-active={isActive}
                    draggable
                    onClick={() => props.onActiveGroupChange(terminalGroup.id)}
                    onKeyDown={(event) => onGroupKeyDown(event, index)}
                    onDragStart={(event) =>
                      writeTerminalDragPayload(event.dataTransfer, {
                        kind: "group",
                        groupId: terminalGroup.id,
                      })
                    }
                  >
                    <RoleIcon className={cn("size-3.5", ACCENT_CLASS[terminalGroup.accent])} />
                    {activityState ? (
                      <TerminalActivityIndicator
                        className="text-foreground/70"
                        state={activityState}
                      />
                    ) : null}
                    <span className="truncate">{terminalGroup.name}</span>
                    {status.runningCount > 0 ? (
                      <span className="text-[10px] text-current/60">{status.runningCount}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="flex size-7 items-center justify-center text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 group-hover:opacity-100"
                    aria-label={`Archive ${terminalGroup.name}`}
                    onClick={() => props.onArchiveGroup?.(terminalGroup.id)}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                  <Menu>
                    <MenuTrigger
                      aria-label={`Manage ${terminalGroup.name}`}
                      render={
                        <button
                          type="button"
                          className="flex size-7 items-center justify-center rounded-r-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
                        />
                      }
                    >
                      <EllipsisIcon className="size-3.5" />
                    </MenuTrigger>
                    <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-48">
                      <MenuItem
                        disabled={index === 0}
                        onClick={() => props.onReorderGroup?.(terminalGroup.id, index - 1)}
                      >
                        <ArrowLeftIcon />
                        Move left
                      </MenuItem>
                      <MenuItem
                        disabled={index === props.terminalGroups.length - 1}
                        onClick={() => props.onReorderGroup?.(terminalGroup.id, index + 1)}
                      >
                        <ArrowRightIcon />
                        Move right
                      </MenuItem>
                      {selectedTerminalIds.length > 0 ? (
                        <MenuItem
                          onClick={() =>
                            props.onMoveTerminalsToGroup?.(selectedTerminalIds, terminalGroup.id)
                          }
                        >
                          Move {selectedTerminalIds.length} selected here
                        </MenuItem>
                      ) : null}
                      <MenuSeparator />
                      <MenuItem
                        onClick={() => {
                          setRenameTarget({
                            groupId: terminalGroup.id,
                            name: terminalGroup.name,
                          });
                        }}
                      >
                        <PencilIcon />
                        Rename…
                      </MenuItem>
                      <MenuSub>
                        <MenuSubTrigger>Change role</MenuSubTrigger>
                        <MenuSubPopup surface="composer">
                          {TERMINAL_GROUP_ROLES.map((role) => (
                            <MenuItem
                              key={role}
                              onClick={() => props.onRoleChange?.(terminalGroup.id, role)}
                            >
                              {role === terminalGroup.role ? "✓ " : ""}
                              {role[0]?.toUpperCase()}
                              {role.slice(1)}
                            </MenuItem>
                          ))}
                        </MenuSubPopup>
                      </MenuSub>
                      {status.runningCount > 0 ? (
                        <MenuItem onClick={() => props.onStopGroup?.(terminalGroup.id)}>
                          Stop all running terminals
                        </MenuItem>
                      ) : null}
                      <MenuItem onClick={() => props.onArchiveGroup?.(terminalGroup.id)}>
                        <ArchiveIcon />
                        Archive group
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        onClick={() => props.onCloseGroup(terminalGroup.id)}
                      >
                        <Trash2 />
                        Close and remove
                      </MenuItem>
                    </ComposerPickerMenuPopup>
                  </Menu>
                </div>
              </Fragment>
            );
          })}
          {newGroupGap(props.terminalGroups.length, true)}
        </div>
        <div className="flex shrink-0 items-center">
          {archivedGroups.length > 0 ? (
            <Button
              data-terminal-archived-toggle
              size="xs"
              variant="ghost"
              aria-expanded={props.showArchived === true}
              aria-pressed={props.showArchived === true}
              onClick={() => props.onShowArchivedChange?.(!(props.showArchived === true))}
            >
              Archived {archivedGroups.length}
            </Button>
          ) : null}
          {props.createMenu}
          <TerminalChromeActions actions={props.actions} variant="workspace" />
        </div>
      </div>
      <RenameDialog
        open={renameTarget !== null}
        title="Rename terminal group"
        description="Choose a short, recognizable group name."
        initialValue={renameTarget?.name ?? ""}
        saveLabel="Rename"
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onSave={(nextName) => {
          if (!renameTarget) return;
          props.onRenameGroup?.(renameTarget.groupId, nextName);
        }}
      />
      <DisclosureRegion open={props.showArchived === true && archivedGroups.length > 0}>
        <div
          className="flex flex-wrap gap-1 border-t border-border/50 px-2 py-1.5"
          aria-label="Archived terminal groups"
        >
          {archivedGroups.map((group) => (
            <div
              key={group.id}
              className="flex items-center gap-1 rounded-md border border-dashed border-border/70 px-2 py-1 text-xs text-muted-foreground"
              title={
                group.archivedAt === null
                  ? "Archived"
                  : `Archived ${new Date(group.archivedAt).toLocaleString()}`
              }
            >
              <ArchiveIcon className="size-3" />
              <span>{group.name}</span>
              <button
                type="button"
                className="rounded px-1 text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
                onClick={() => props.onRestoreGroup?.(group.id)}
              >
                <RefreshCwIcon className="mr-1 inline size-3" />
                Restore
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
                aria-label={`Close and remove archived ${group.name}`}
                onClick={() => props.onCloseGroup(group.id)}
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </DisclosureRegion>
    </div>
  );
}

const TERMINAL_GROUP_ROLES: readonly TerminalGroupRole[] = [
  "app",
  "verify",
  "observe",
  "agent",
  "data",
  "infrastructure",
  "custom",
];

const ROLE_ICON = {
  app: WindowIcon,
  verify: CheckCircle2Icon,
  observe: EyeIcon,
  agent: BotIcon,
  data: FolderIcon,
  infrastructure: GlobeIcon,
  custom: TerminalIcon,
} satisfies Record<TerminalGroupRole, typeof TerminalIcon>;

const ACCENT_CLASS = {
  blue: "text-blue-500",
  green: "text-green-500",
  amber: "text-amber-500",
  violet: "text-violet-500",
  cyan: "text-cyan-500",
  orange: "text-orange-500",
  neutral: "text-muted-foreground",
} satisfies Record<TerminalGroupAccent, string>;

export function TerminalSidebar(props: {
  terminalIds: string[];
  terminalGroups: ResolvedTerminalGroupLayout[];
  activeTerminalId: string;
  activeGroupId: string;
  showGroupHeaders: boolean;
  closeShortcutLabel?: string | undefined;
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
  actions: ReadonlyArray<TerminalChromeActionItem>;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}) {
  return (
    <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-[var(--color-background-surface)]">
      <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
        <TerminalChromeActions actions={props.actions} variant="sidebar" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {props.terminalGroups.map((terminalGroup, groupIndex) => {
          const isGroupActive = terminalGroup.id === props.activeGroupId;
          const groupActiveTerminalId = isGroupActive
            ? props.activeTerminalId
            : terminalGroup.activeTerminalId;
          const groupVisualIdentity = props.terminalVisualIdentityById.get(groupActiveTerminalId);

          return (
            <div key={terminalGroup.id} className="pb-0.5">
              {props.showGroupHeaders && (
                <button
                  type="button"
                  className={`flex w-full items-center px-1 py-0.5 text-[10px] ${
                    isGroupActive
                      ? "bg-[var(--sidebar-accent-active)] text-foreground"
                      : "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground"
                  }`}
                  onClick={() => props.onActiveTerminalChange(groupActiveTerminalId)}
                >
                  {groupVisualIdentity?.title ?? `Terminal ${groupIndex + 1}`}
                  {terminalGroup.terminalIds.length > 1
                    ? ` (${terminalGroup.terminalIds.length})`
                    : ""}
                </button>
              )}

              <div
                className={props.showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
              >
                {terminalGroup.terminalIds.map((terminalId) => {
                  const isActive = terminalId === props.activeTerminalId;
                  const visualIdentity = props.terminalVisualIdentityById.get(terminalId);
                  const visualState = visualIdentity?.state ?? "idle";
                  const statusLabel = terminalVisualStateLabel(visualState);
                  const closeTerminalLabel = `Close ${
                    visualIdentity?.title ?? "terminal"
                  }${isActive && props.closeShortcutLabel ? ` (${props.closeShortcutLabel})` : ""}`;
                  return (
                    <div
                      key={terminalId}
                      className={`group flex items-center gap-1 px-1 py-0.5 text-[11px] ${
                        isActive
                          ? "bg-[var(--sidebar-accent-active)] text-foreground"
                          : "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground"
                      }`}
                    >
                      {props.showGroupHeaders && (
                        <span className="text-[10px] text-muted-foreground/80">└</span>
                      )}
                      <button
                        type="button"
                        data-terminal-state={visualState}
                        aria-label={`${visualIdentity?.title ?? "Terminal"}, ${statusLabel}`}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        onClick={() => props.onActiveTerminalChange(terminalId)}
                      >
                        <TerminalIdentityIcon
                          className="size-3 shrink-0"
                          iconKey={visualIdentity?.iconKey ?? "terminal"}
                        />
                        {visualState !== "idle" ? (
                          <TerminalActivityIndicator
                            className="text-foreground/70"
                            state={visualState}
                          />
                        ) : null}
                        <span className="truncate">{visualIdentity?.title ?? "Terminal"}</span>
                      </button>
                      {props.terminalIds.length > 1 && (
                        <Popover>
                          <PopoverTrigger
                            openOnHover
                            render={
                              <button
                                type="button"
                                className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-[var(--sidebar-accent)] hover:text-foreground group-hover:opacity-100"
                                onClick={() => props.onCloseTerminal(terminalId)}
                                aria-label={closeTerminalLabel}
                              />
                            }
                          >
                            <XIcon className="size-2.5" />
                          </PopoverTrigger>
                          <PopoverPopup
                            tooltipStyle
                            side="bottom"
                            sideOffset={6}
                            align="center"
                            className="pointer-events-none select-none"
                          >
                            {closeTerminalLabel}
                          </PopoverPopup>
                        </Popover>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
