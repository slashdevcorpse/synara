// FILE: ThreadTerminalDrawer.tsx
// Purpose: Hosts the terminal drawer/workspace chrome and each xterm viewport for a thread.
// Layer: Chat terminal workspace UI
// Depends on: xterm addons, native terminal APIs, and terminal workspace state from ChatView.

import "@xterm/xterm/css/xterm.css";
import { SearchAddon } from "@xterm/addon-search";
import {
  ChevronDownIcon,
  Plus,
  RefreshCwIcon,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TriangleAlertIcon,
} from "~/lib/icons";
import { type ThreadId } from "@synara/contracts";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import { Terminal } from "@xterm/xterm";
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppSettings } from "~/appSettings";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "~/nativeApi";
import {
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
  type ThreadTerminalPresentationMode,
  type TerminalExitState,
} from "../types";
import {
  selectThreadTerminalState,
  type TerminalMoveTarget,
  useTerminalStateStore,
} from "../terminalStateStore";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import {
  type TerminalChromeActionItem,
  TerminalSidebar,
  TerminalWorkspaceTabBar,
} from "./terminal/TerminalChrome";
import {
  findMostRecentlyArchivedTerminalGroup,
  resolveThreadTerminalLayout,
} from "./terminal/TerminalLayout";
import {
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./terminal/terminalSelectionActions";
import {
  buildTerminalRuntimeKey,
  terminalRuntimeRegistry,
} from "./terminal/terminalRuntimeRegistry";
import type {
  TerminalRecoveryResolution,
  TerminalRuntimeConfig,
  TerminalRuntimeStatus,
  TerminalRuntimeViewState,
} from "./terminal/terminalRuntimeTypes";
import TerminalViewportPane from "./terminal/TerminalViewportPane";
import { useTerminalDrawerHeight } from "./terminal/useTerminalDrawerHeight";
import { TerminalSearch } from "./TerminalSearch";
import { TerminalScrollToBottom } from "./TerminalScrollToBottom";
import {
  closeTerminalSessionsStrict,
  restartTerminalSession,
  shouldAttachTerminalRuntime,
  stopTerminalSessionPreservingHistory,
  terminalExitStateFromProcessExit,
  terminalExitStateFromRecovery,
} from "./terminal/terminalSession";
import {
  closeTerminalGroupTransaction,
  stopTerminalGroupForArchive,
} from "./terminal/terminalGroupLifecycle";
import { writeTerminalDragPayload } from "./terminal/terminalDragAndDrop";
import {
  pruneTerminalTabSelection,
  type TerminalTabSelection,
  updateTerminalTabSelection,
} from "./terminal/terminalTabSelection";
import { resolveTerminalWorkspaceShortcut } from "./terminal/terminalWorkspaceShortcuts";

function serializeRuntimeEnv(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  const entries = Object.entries(runtimeEnv);
  if (entries.length === 0) return "";
  entries.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function runtimeEnvFromSerialized(
  serializedRuntimeEnv: string,
): Record<string, string> | undefined {
  if (!serializedRuntimeEnv) return undefined;
  const entries = JSON.parse(serializedRuntimeEnv) as Array<[string, string]>;
  return Object.fromEntries(entries);
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

function TerminalRuntimeStatusOverlay({ status }: { status: TerminalRuntimeStatus }) {
  if (status !== "error") return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1 top-1 z-10 inline-flex h-6 max-w-[calc(100%-0.5rem)] items-center gap-1.5 rounded border px-2 text-[11px] leading-none shadow-sm backdrop-blur",
        "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <TriangleAlertIcon className="size-3" />
      <span className="truncate">Error</span>
    </div>
  );
}

export function TerminalEmptyState(props: {
  archivedGroupId?: string | undefined;
  onRestoreGroup: (groupId: string) => void;
  onNewGroup: () => void;
}) {
  const hasArchivedGroup = props.archivedGroupId !== undefined;
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {hasArchivedGroup ? "All terminal groups are archived" : "No terminal groups"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {hasArchivedGroup
            ? "Restore a group with its layout intact, or create a new group."
            : "Create a group to start a new terminal."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {props.archivedGroupId ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onRestoreGroup(props.archivedGroupId ?? "")}
          >
            <RefreshCwIcon />
            Restore last group
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={props.onNewGroup}>
          <Plus />
          New group
        </Button>
      </div>
    </div>
  );
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind?: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  terminalRightClickToPaste: boolean;
  exitState?: TerminalExitState | undefined;
  reattachOnly: boolean;
  onRecoveryResolved: (terminalId: string, recovery: TerminalRecoveryResolution) => void;
  onSessionExited: (exit: { exitCode: number | null; exitSignal: number | null }) => void;
  onRestart: () => Promise<void>;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  isVisible: boolean;
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  terminalCliKind = null,
  cwd,
  runtimeEnv,
  terminalRightClickToPaste,
  onSessionExited,
  exitState,
  reattachOnly,
  onRecoveryResolved,
  onRestart,
  onTerminalMetadataChange,
  onTerminalActivityChange,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  isVisible,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const terminalLabelRef = useRef(terminalLabel);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);
  const [searchAddonInstance, setSearchAddonInstance] = useState<SearchAddon | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<TerminalRuntimeStatus>("connecting");
  const [restarting, setRestarting] = useState(false);
  const runtimeStatusMountedRef = useRef(false);
  // Manual memoization kept: this file does not compile under React Compiler (see compile-report).
  const trimmedCwd = useMemo(() => cwd.trim(), [cwd]);
  const runtimeCwdReady = trimmedCwd.length > 0;
  const runtimeKey = useMemo(
    () => buildTerminalRuntimeKey(threadId, terminalId),
    [terminalId, threadId],
  );
  const runtimeEnvSerialized = useMemo(() => serializeRuntimeEnv(runtimeEnv), [runtimeEnv]);
  const runtimeEnvPayload = useMemo(
    () => runtimeEnvFromSerialized(runtimeEnvSerialized),
    [runtimeEnvSerialized],
  );
  const runtimeConfig = useMemo<TerminalRuntimeConfig>(
    () => ({
      runtimeKey,
      threadId,
      terminalId,
      terminalLabel,
      terminalCliKind,
      cwd,
      terminalRightClickToPaste,
      reattachOnly,
      ...(runtimeEnvPayload ? { runtimeEnv: runtimeEnvPayload } : {}),
      callbacks: {
        onSessionExited,
        onTerminalMetadataChange,
        onTerminalActivityChange,
        onTerminalRuntimeStatusChange: (changedTerminalId, status) => {
          if (changedTerminalId === terminalId && runtimeStatusMountedRef.current) {
            setRuntimeStatus(status);
          }
        },
        onTerminalRecoveryResolved: onRecoveryResolved,
      },
    }),
    [
      cwd,
      onRecoveryResolved,
      onSessionExited,
      onTerminalActivityChange,
      onTerminalMetadataChange,
      runtimeEnvPayload,
      runtimeKey,
      reattachOnly,
      terminalCliKind,
      terminalId,
      terminalLabel,
      terminalRightClickToPaste,
      threadId,
    ],
  );
  const runtimeViewState = useMemo<TerminalRuntimeViewState>(
    () => ({ autoFocus, isVisible }),
    [autoFocus, isVisible],
  );
  const runtimeAttachEnabled = shouldAttachTerminalRuntime({ runtimeCwdReady, exitState });
  const runtimeConfigRef = useRef(runtimeConfig);
  const runtimeViewStateRef = useRef(runtimeViewState);

  useEffect(() => {
    onAddTerminalContextRef.current = onAddTerminalContext;
  }, [onAddTerminalContext]);

  useEffect(() => {
    runtimeStatusMountedRef.current = true;
    return () => {
      runtimeStatusMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    runtimeConfigRef.current = runtimeConfig;
  }, [runtimeConfig]);

  useEffect(() => {
    runtimeViewStateRef.current = runtimeViewState;
  }, [runtimeViewState]);

  useEffect(() => {
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount || !runtimeAttachEnabled) {
      terminalRef.current = null;
      setTerminalInstance(null);
      setSearchAddonInstance(null);
      setRuntimeStatus("connecting");
      return;
    }
    const attachedRuntime = terminalRuntimeRegistry.attach(
      runtimeConfigRef.current,
      runtimeViewStateRef.current,
      mount,
    );

    terminalRef.current = attachedRuntime.terminal;
    setTerminalInstance(attachedRuntime.terminal);
    setSearchAddonInstance(attachedRuntime.searchAddon);
    setRuntimeStatus(attachedRuntime.runtimeStatus);

    return () => {
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
      selectionActionOpenRef.current = false;
      terminalRuntimeRegistry.detach(runtimeKey);
      terminalRef.current = null;
      setTerminalInstance(null);
      setSearchAddonInstance(null);
    };
  }, [runtimeAttachEnabled, runtimeKey]);

  useEffect(() => {
    if (!runtimeAttachEnabled) return;
    terminalRuntimeRegistry.syncConfig(runtimeKey, runtimeConfig);
  }, [runtimeAttachEnabled, runtimeConfig, runtimeKey]);

  useEffect(() => {
    if (!runtimeAttachEnabled) return;
    terminalRuntimeRegistry.setViewState(runtimeKey, runtimeViewState);
  }, [runtimeAttachEnabled, runtimeKey, runtimeViewState]);

  useEffect(() => {
    if (!autoFocus || !runtimeAttachEnabled) return;
    terminalRuntimeRegistry.focus(runtimeKey);
  }, [autoFocus, focusRequestId, runtimeAttachEnabled, runtimeKey]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
      }
    };

    mount.addEventListener("keydown", handleKeyDown, true);
    return () => {
      mount.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  const clearSelectionAction = useCallback(() => {
    selectionActionRequestIdRef.current += 1;
    if (selectionActionTimerRef.current !== null) {
      window.clearTimeout(selectionActionTimerRef.current);
      selectionActionTimerRef.current = null;
    }
  }, []);

  const readSelectionAction = useCallback((): {
    position: { x: number; y: number };
    selection: TerminalContextSelection;
  } | null => {
    const activeTerminal = terminalRef.current;
    const mountElement = containerRef.current;
    if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
      return null;
    }
    const selectionText = activeTerminal.getSelection();
    const selectionPosition = activeTerminal.getSelectionPosition();
    const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
    if (!selectionPosition || normalizedText.length === 0) {
      return null;
    }
    const lineStart = selectionPosition.start.y + 1;
    const lineCount = normalizedText.split("\n").length;
    const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
    const bounds = mountElement.getBoundingClientRect();
    const selectionRect = getTerminalSelectionRect(mountElement);
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect:
        selectionRect === null
          ? null
          : { right: selectionRect.right, bottom: selectionRect.bottom },
      pointer: selectionPointerRef.current,
    });
    return {
      position,
      selection: {
        terminalId,
        terminalLabel: terminalLabelRef.current,
        lineStart,
        lineEnd,
        text: normalizedText,
      },
    };
  }, [terminalId]);

  const showSelectionAction = useCallback(() => {
    if (selectionActionOpenRef.current) {
      return;
    }
    const nextAction = readSelectionAction();
    if (!nextAction) {
      clearSelectionAction();
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    const requestId = ++selectionActionRequestIdRef.current;
    selectionActionOpenRef.current = true;
    // Promise chain instead of async/try-finally: React Compiler does not yet
    // support try/finally, and it would skip optimizing this whole component.
    void api.contextMenu
      .show([{ id: "add-to-chat", label: "Add to chat" }], nextAction.position)
      .then((clicked) => {
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        onAddTerminalContextRef.current(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRuntimeRegistry.focus(runtimeKey);
      })
      .finally(() => {
        selectionActionOpenRef.current = false;
      });
  }, [clearSelectionAction, readSelectionAction, runtimeKey]);

  useEffect(() => {
    const terminal = terminalInstance;
    const mount = containerRef.current;
    if (!terminal || !mount) return;

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminal.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };

    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };

    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);
    return () => {
      selectionDisposable.dispose();
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      clearSelectionAction();
      selectionGestureActiveRef.current = false;
    };
  }, [clearSelectionAction, showSelectionAction, terminalInstance]);

  return (
    <div className="h-full min-h-0 w-full bg-[var(--color-background-surface)] p-3">
      <div className="relative h-full min-h-0 w-full overflow-hidden">
        <TerminalSearch
          searchAddon={searchAddonInstance}
          isOpen={searchOpen}
          onClose={() => {
            setSearchOpen(false);
            terminalRuntimeRegistry.focus(runtimeKey);
          }}
        />
        <TerminalRuntimeStatusOverlay status={runtimeStatus} />
        {exitState ? (
          <div className="absolute inset-x-0 top-1 z-20 flex justify-center">
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1 text-xs shadow-sm backdrop-blur",
                exitState.kind === "failed"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border/70 bg-background/90 text-muted-foreground",
              )}
            >
              <span>
                {exitState.kind === "failed"
                  ? `Exited with code ${exitState.exitCode ?? "unknown"}`
                  : "Terminal stopped"}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={restarting}
                onClick={() => {
                  setRestarting(true);
                  void onRestart()
                    .catch(() => undefined)
                    .finally(() => setRestarting(false));
                }}
              >
                <RefreshCwIcon className={cn("size-3", restarting && "animate-spin")} />
                Restart
              </Button>
            </div>
          </div>
        ) : null}
        <TerminalScrollToBottom terminal={terminalInstance} />
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  presentationMode: ThreadTerminalPresentationMode;
  isVisible?: boolean;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalDown: () => void;
  onNewTerminal: () => void;
  onNewTerminalTab: (terminalId: string) => void;
  onStartProjectScript?: (() => void) | undefined;
  onMoveTerminalToGroup: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitDownShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  workspaceCloseShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onCloseTerminalGroup: (groupId: string) => void;
  onHeightChange: (height: number) => void;
  onResizeTerminalSplit: (groupId: string, splitId: string, weights: number[]) => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onTogglePresentationMode?: (() => void) | undefined;
  onTogglePanel?: (() => void) | undefined;
  isPanelOpen?: boolean | undefined;
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  presentationMode,
  isVisible = true,
  terminalIds,
  terminalLabelsById,
  terminalTitleOverridesById,
  terminalCliKindsById,
  terminalAttentionStatesById,
  runningTerminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalDown,
  onNewTerminal,
  onNewTerminalTab,
  onStartProjectScript,
  onMoveTerminalToGroup,
  splitShortcutLabel,
  splitDownShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  workspaceCloseShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onCloseTerminalGroup,
  onHeightChange,
  onResizeTerminalSplit,
  onTerminalMetadataChange,
  onTerminalActivityChange,
  onAddTerminalContext,
  onTogglePresentationMode,
  onTogglePanel,
  isPanelOpen,
}: ThreadTerminalDrawerProps) {
  const { settings } = useAppSettings();
  const lifecycleState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const archiveTerminalGroup = useTerminalStateStore((state) => state.archiveTerminalGroup);
  const restoreTerminalGroup = useTerminalStateStore((state) => state.restoreTerminalGroup);
  const reorderTerminalGroup = useTerminalStateStore((state) => state.reorderTerminalGroup);
  const moveTerminals = useTerminalStateStore((state) => state.moveTerminals);
  const renameTerminalGroup = useTerminalStateStore((state) => state.renameTerminalGroup);
  const setTerminalGroupRole = useTerminalStateStore((state) => state.setTerminalGroupRole);
  const setShowArchivedTerminalGroups = useTerminalStateStore(
    (state) => state.setShowArchivedTerminalGroups,
  );
  const setTerminalExitState = useTerminalStateStore((state) => state.setTerminalExitState);
  const setTerminalLaunchMetadata = useTerminalStateStore(
    (state) => state.setTerminalLaunchMetadata,
  );
  const [pendingArchiveGroupId, setPendingArchiveGroupId] = useState<string | null>(null);
  const [pendingCloseGroupId, setPendingCloseGroupId] = useState<string | null>(null);
  const [terminalTabSelection, setTerminalTabSelection] = useState<TerminalTabSelection>({
    anchorId: null,
    selectedIds: new Set(),
  });
  const isWorkspaceMode = presentationMode === "workspace";
  const previousRuntimeKeysRef = useRef<Set<string>>(new Set());
  const { drawerHeight, handleResizePointerDown, handleResizePointerMove, handleResizePointerEnd } =
    useTerminalDrawerHeight({
      height,
      onHeightChange,
      resetKey: threadId,
    });

  const {
    normalizedTerminalIds,
    resolvedActiveTerminalId,
    resolvedActiveGroupId,
    resolvedTerminalGroups,
    resolvedArchivedTerminalGroups,
    activeGroupLayout,
    hasTerminalSidebar,
    showGroupHeaders,
    hasReachedSplitLimit,
    terminalVisualIdentityById,
  } = useMemo(
    () =>
      resolveThreadTerminalLayout({
        activeTerminalGroupId,
        activeTerminalId,
        runningTerminalIds,
        terminalAttentionStatesById,
        terminalExitStatesById: lifecycleState.terminalExitStatesById,
        terminalCliKindsById,
        terminalGroups,
        terminalIds,
        terminalLabelsById,
        terminalTitleOverridesById,
      }),
    [
      activeTerminalGroupId,
      activeTerminalId,
      runningTerminalIds,
      terminalAttentionStatesById,
      lifecycleState.terminalExitStatesById,
      terminalCliKindsById,
      terminalGroups,
      terminalIds,
      terminalLabelsById,
      terminalTitleOverridesById,
    ],
  );
  const mostRecentlyArchivedGroup = useMemo(
    () => findMostRecentlyArchivedTerminalGroup(resolvedArchivedTerminalGroups),
    [resolvedArchivedTerminalGroups],
  );

  useEffect(() => {
    const nextRuntimeKeySet = new Set(
      normalizedTerminalIds.map((terminalId) => buildTerminalRuntimeKey(threadId, terminalId)),
    );
    for (const previousRuntimeKey of previousRuntimeKeysRef.current) {
      if (nextRuntimeKeySet.has(previousRuntimeKey)) {
        continue;
      }
      terminalRuntimeRegistry.dispose(previousRuntimeKey);
    }
    previousRuntimeKeysRef.current = nextRuntimeKeySet;
  }, [normalizedTerminalIds, threadId]);

  useEffect(() => {
    for (const terminalId of normalizedTerminalIds) {
      const current = lifecycleState.terminalLaunchMetadataById[terminalId];
      if (current?.cwd === cwd) continue;
      setTerminalLaunchMetadata(threadId, terminalId, {
        cwd,
        ...(current?.reattachOnly === true ? { reattachOnly: true } : {}),
      });
    }
  }, [
    cwd,
    lifecycleState.terminalLaunchMetadataById,
    normalizedTerminalIds,
    setTerminalLaunchMetadata,
    threadId,
  ]);

  const addArchiveUndoToast = useCallback(
    (groupId: string, groupName: string) => {
      toastManager.add({
        type: "info",
        title: `${groupName} archived`,
        description: "Its terminals and layout are preserved.",
        data: { threadId },
        actionProps: {
          children: "Undo",
          onClick: () => {
            restoreTerminalGroup(threadId, groupId);
            window.requestAnimationFrame(() => {
              document
                .querySelector<HTMLElement>(`[data-terminal-group-id="${CSS.escape(groupId)}"]`)
                ?.focus();
            });
          },
        },
      });
    },
    [restoreTerminalGroup, threadId],
  );

  const activeGroupTerminalIds = useMemo(
    () =>
      resolvedTerminalGroups.find((group) => group.id === resolvedActiveGroupId)?.terminalIds ?? [],
    [resolvedActiveGroupId, resolvedTerminalGroups],
  );

  // Selection is intentionally scoped to one visible drawer group. Switching
  // threads/groups resets it; membership changes only prune removed terminals.
  useEffect(() => {
    setTerminalTabSelection({ anchorId: null, selectedIds: new Set() });
  }, [resolvedActiveGroupId, threadId]);

  useEffect(() => {
    setTerminalTabSelection((selection) =>
      pruneTerminalTabSelection(selection, activeGroupTerminalIds),
    );
  }, [activeGroupTerminalIds]);

  const selectTerminalTab = useCallback(
    (terminalId: string, modifiers: { shiftKey: boolean; toggleKey: boolean }) => {
      setTerminalTabSelection((selection) =>
        updateTerminalTabSelection({
          orderedTerminalIds: activeGroupTerminalIds,
          selection,
          terminalId,
          ...modifiers,
        }),
      );
    },
    [activeGroupTerminalIds],
  );

  const moveTerminalSelection = useCallback(
    (terminalIdsToMove: readonly string[], target: TerminalMoveTarget) => {
      moveTerminals(threadId, terminalIdsToMove, target);
      setTerminalTabSelection({ anchorId: null, selectedIds: new Set() });
    },
    [moveTerminals, threadId],
  );

  const startTerminalTabDrag = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, terminalId: string) => {
      const terminalIdsToMove = terminalTabSelection.selectedIds.has(terminalId)
        ? activeGroupTerminalIds.filter((id) => terminalTabSelection.selectedIds.has(id))
        : [terminalId];
      if (!terminalTabSelection.selectedIds.has(terminalId)) {
        setTerminalTabSelection({ anchorId: terminalId, selectedIds: new Set([terminalId]) });
      }
      writeTerminalDragPayload(event.dataTransfer, {
        kind: "terminals",
        terminalIds: terminalIdsToMove,
      });
    },
    [activeGroupTerminalIds, terminalTabSelection],
  );

  const requestArchiveGroup = useCallback(
    (groupId: string) => {
      const group = resolvedTerminalGroups.find((entry) => entry.id === groupId);
      if (!group) return;
      const hasRunningTerminal = group.terminalIds.some((terminalId) =>
        runningTerminalIds.includes(terminalId),
      );
      if (hasRunningTerminal) {
        setPendingArchiveGroupId(groupId);
        return;
      }
      const groupIndex = resolvedTerminalGroups.findIndex((entry) => entry.id === groupId);
      const nextFocusGroup =
        resolvedTerminalGroups[groupIndex + 1] ?? resolvedTerminalGroups[groupIndex - 1] ?? null;
      archiveTerminalGroup(threadId, groupId);
      addArchiveUndoToast(groupId, group.name);
      window.requestAnimationFrame(() => {
        if (nextFocusGroup) {
          document
            .querySelector<HTMLElement>(
              `[data-terminal-group-id="${CSS.escape(nextFocusGroup.id)}"]`,
            )
            ?.focus();
        } else {
          document.querySelector<HTMLElement>("[data-terminal-archived-toggle]")?.focus();
        }
      });
    },
    [
      addArchiveUndoToast,
      archiveTerminalGroup,
      resolvedTerminalGroups,
      runningTerminalIds,
      threadId,
    ],
  );

  const stopAndArchivePendingGroup = useCallback(async () => {
    const group = resolvedTerminalGroups.find((entry) => entry.id === pendingArchiveGroupId);
    if (!group) {
      setPendingArchiveGroupId(null);
      return;
    }
    const api = readNativeApi();
    const runningIds = group.terminalIds.filter((terminalId) =>
      runningTerminalIds.includes(terminalId),
    );
    const result = await stopTerminalGroupForArchive({
      terminalIds: runningIds,
      stopTerminal: (terminalId) =>
        stopTerminalSessionPreservingHistory({ api, threadId, terminalId }),
      markTerminalStopped: (terminalId) =>
        setTerminalExitState(threadId, terminalId, {
          kind: "stopped",
          exitCode: null,
          exitSignal: null,
        }),
      archiveGroup: () => archiveTerminalGroup(threadId, group.id),
    });
    if (!result.archived) {
      toastManager.add({
        type: "error",
        title: "Could not stop every terminal",
        description: `${result.failedTerminalIds.length} terminal${result.failedTerminalIds.length === 1 ? "" : "s"} remain visible and were not marked as stopped.`,
        data: { threadId },
      });
      setPendingArchiveGroupId(null);
      return;
    }
    addArchiveUndoToast(group.id, group.name);
    const groupIndex = resolvedTerminalGroups.findIndex((entry) => entry.id === group.id);
    const nextFocusGroup =
      resolvedTerminalGroups[groupIndex + 1] ?? resolvedTerminalGroups[groupIndex - 1] ?? null;
    window.requestAnimationFrame(() => {
      if (nextFocusGroup) {
        document
          .querySelector<HTMLElement>(`[data-terminal-group-id="${CSS.escape(nextFocusGroup.id)}"]`)
          ?.focus();
      } else {
        document.querySelector<HTMLElement>("[data-terminal-archived-toggle]")?.focus();
      }
    });
    setPendingArchiveGroupId(null);
  }, [
    addArchiveUndoToast,
    archiveTerminalGroup,
    pendingArchiveGroupId,
    resolvedTerminalGroups,
    runningTerminalIds,
    setTerminalExitState,
    threadId,
  ]);

  const closeTerminalGroupDestructively = useCallback(
    async (groupId: string): Promise<boolean> => {
      const group = [...resolvedTerminalGroups, ...resolvedArchivedTerminalGroups].find(
        (entry) => entry.id === groupId,
      );
      if (!group) return false;
      const api = readNativeApi();
      const result = await closeTerminalGroupTransaction({
        terminalIds: group.terminalIds,
        closeTerminals: (terminalIds) =>
          closeTerminalSessionsStrict({ api, threadId, terminalIds }),
        disposeTerminal: (terminalId) =>
          terminalRuntimeRegistry.disposeTerminal(threadId, terminalId),
        removeGroup: () => onCloseTerminalGroup(groupId),
      });
      if (!result.closed) {
        toastManager.add({
          type: "error",
          title: "Could not close terminal group",
          description: `The group remains visible. Failed terminal IDs: ${result.failedTerminalIds.join(", ")}`,
          data: { threadId },
        });
      }
      return result.closed;
    },
    [onCloseTerminalGroup, resolvedArchivedTerminalGroups, resolvedTerminalGroups, threadId],
  );

  const restoreGroupAndFocus = useCallback(
    (groupId: string) => {
      restoreTerminalGroup(threadId, groupId);
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-terminal-group-id="${CSS.escape(groupId)}"]`)
          ?.focus();
      });
    },
    [restoreTerminalGroup, threadId],
  );

  const stopAllInGroup = useCallback(
    async (groupId: string) => {
      const group = resolvedTerminalGroups.find((entry) => entry.id === groupId);
      if (!group) return;
      const terminalIds = group.terminalIds.filter((terminalId) =>
        runningTerminalIds.includes(terminalId),
      );
      const api = readNativeApi();
      const results = await Promise.allSettled(
        terminalIds.map((terminalId) =>
          stopTerminalSessionPreservingHistory({ api, threadId, terminalId }),
        ),
      );
      const failed: string[] = [];
      results.forEach((result, index) => {
        const terminalId = terminalIds[index];
        if (!terminalId) return;
        if (result.status === "fulfilled") {
          setTerminalExitState(threadId, terminalId, {
            kind: "stopped",
            exitCode: null,
            exitSignal: null,
          });
        } else {
          failed.push(terminalId);
        }
      });
      toastManager.add({
        type: failed.length > 0 ? "error" : "success",
        title:
          failed.length > 0
            ? `Could not stop ${failed.length} terminal${failed.length === 1 ? "" : "s"}`
            : `Stopped ${terminalIds.length} terminal${terminalIds.length === 1 ? "" : "s"}`,
        data: { threadId },
      });
    },
    [resolvedTerminalGroups, runningTerminalIds, setTerminalExitState, threadId],
  );

  const restartTerminal = useCallback(
    async (terminalId: string) => {
      try {
        const restarted = await restartTerminalSession({
          api: readNativeApi(),
          threadId,
          terminalId,
          cwd: lifecycleState.terminalLaunchMetadataById[terminalId]?.cwd ?? cwd,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (restarted) {
          setTerminalExitState(threadId, terminalId, null);
          return;
        }
        toastManager.add({
          type: "error",
          title: "Could not restart terminal",
          description: "The terminal restart API is unavailable. The stopped state was preserved.",
          data: { threadId },
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not restart terminal",
          description:
            error instanceof Error
              ? `${error.message}. The stopped state was preserved.`
              : "The stopped state was preserved.",
          data: { threadId },
        });
      }
    },
    [cwd, lifecycleState.terminalLaunchMetadataById, runtimeEnv, setTerminalExitState, threadId],
  );

  const handleTerminalWorkspaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (
        event.nativeEvent.isComposing ||
        target.isContentEditable ||
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      const command = resolveTerminalWorkspaceShortcut({
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
      if (!command) return;

      const activeGroupIndex = resolvedTerminalGroups.findIndex(
        (group) => group.id === resolvedActiveGroupId,
      );
      let handled = false;

      if (command === "archive-active-group" && resolvedActiveGroupId) {
        requestArchiveGroup(resolvedActiveGroupId);
        handled = true;
      } else if (command === "restore-recent-group") {
        if (mostRecentlyArchivedGroup) {
          restoreGroupAndFocus(mostRecentlyArchivedGroup.id);
          handled = true;
        }
      } else if (command === "toggle-archived-groups") {
        setShowArchivedTerminalGroups(threadId, !lifecycleState.showArchivedTerminalGroups);
        handled = true;
      } else if (command === "move-group-left" && activeGroupIndex > 0) {
        const group = resolvedTerminalGroups[activeGroupIndex];
        if (group) reorderTerminalGroup(threadId, group.id, activeGroupIndex - 1);
        handled = group !== undefined;
      } else if (
        command === "move-group-right" &&
        activeGroupIndex >= 0 &&
        activeGroupIndex < resolvedTerminalGroups.length - 1
      ) {
        const group = resolvedTerminalGroups[activeGroupIndex];
        if (group) reorderTerminalGroup(threadId, group.id, activeGroupIndex + 1);
        handled = group !== undefined;
      } else if (command === "previous-group" || command === "next-group") {
        if (resolvedTerminalGroups.length > 1 && activeGroupIndex >= 0) {
          const direction = command === "next-group" ? 1 : -1;
          const nextIndex =
            (activeGroupIndex + direction + resolvedTerminalGroups.length) %
            resolvedTerminalGroups.length;
          const nextGroup = resolvedTerminalGroups[nextIndex];
          if (nextGroup) onActiveTerminalChange(nextGroup.activeTerminalId);
          handled = nextGroup !== undefined;
        }
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [
      lifecycleState.showArchivedTerminalGroups,
      onActiveTerminalChange,
      reorderTerminalGroup,
      requestArchiveGroup,
      resolvedActiveGroupId,
      resolvedTerminalGroups,
      mostRecentlyArchivedGroup,
      restoreGroupAndFocus,
      setShowArchivedTerminalGroups,
      threadId,
    ],
  );

  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Right (${splitShortcutLabel})`
      : "Split Right";
  const splitTerminalDownActionLabel = hasReachedSplitLimit
    ? `Split Down (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitDownShortcutLabel
      ? `Split Down (${splitDownShortcutLabel})`
      : "Split Down";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const resolvedCloseShortcutLabel = isWorkspaceMode
    ? (workspaceCloseShortcutLabel ?? closeShortcutLabel)
    : closeShortcutLabel;
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalDownAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalDown();
  }, [hasReachedSplitLimit, onSplitTerminalDown]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  const terminalChromeActions: TerminalChromeActionItem[] = [];
  const createTerminalMenu = (
    <Menu>
      <MenuTrigger
        aria-label={newTerminalActionLabel}
        render={<Button size="icon-xs" variant="chrome" />}
      >
        <Plus className="size-3.25" />
        <ChevronDownIcon className="size-2.5" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-52">
        <MenuItem disabled={hasReachedSplitLimit} onClick={onSplitTerminalAction}>
          <SquareSplitHorizontal />
          {splitTerminalActionLabel}
        </MenuItem>
        <MenuItem disabled={hasReachedSplitLimit} onClick={onSplitTerminalDownAction}>
          <SquareSplitVertical />
          {splitTerminalDownActionLabel}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onNewTerminalAction}>
          <Plus />
          New group
        </MenuItem>
        <MenuItem
          disabled={resolvedActiveGroupId === null || hasReachedSplitLimit}
          onClick={() => onNewTerminalTab(resolvedActiveTerminalId)}
        >
          <Plus />
          New tab
        </MenuItem>
        <MenuItem disabled={!onStartProjectScript} onClick={() => onStartProjectScript?.()}>
          Start project script
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
  const showTerminalGroupTabs =
    resolvedTerminalGroups.length > 0 || resolvedArchivedTerminalGroups.length > 0;
  const topTabBarActions = terminalChromeActions;
  const pendingCloseGroup = [...resolvedTerminalGroups, ...resolvedArchivedTerminalGroups].find(
    (group) => group.id === pendingCloseGroupId,
  );

  return (
    <>
      <aside
        className={cn(
          "thread-terminal-drawer relative flex w-full min-w-0 flex-col overflow-hidden bg-[var(--color-background-surface)]",
          isWorkspaceMode ? "h-full min-h-0" : "shrink-0 border-t border-border/70",
        )}
        style={isWorkspaceMode ? undefined : { height: `${drawerHeight}px` }}
        onKeyDownCapture={handleTerminalWorkspaceKeyDown}
      >
        {!isWorkspaceMode ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
          />
        ) : null}

        {showTerminalGroupTabs ? (
          <TerminalWorkspaceTabBar
            terminalGroups={resolvedTerminalGroups}
            archivedTerminalGroups={resolvedArchivedTerminalGroups}
            activeGroupId={resolvedActiveGroupId}
            showArchived={lifecycleState.showArchivedTerminalGroups}
            runningTerminalIds={runningTerminalIds}
            terminalAttentionStatesById={terminalAttentionStatesById}
            terminalExitStatesById={lifecycleState.terminalExitStatesById}
            terminalVisualIdentityById={terminalVisualIdentityById}
            actions={topTabBarActions}
            createMenu={createTerminalMenu}
            onActiveGroupChange={(groupId) => {
              const nextGroup = resolvedTerminalGroups.find((group) => group.id === groupId);
              if (!nextGroup) return;
              onActiveTerminalChange(nextGroup.activeTerminalId);
            }}
            onArchiveGroup={requestArchiveGroup}
            onRestoreGroup={restoreGroupAndFocus}
            onRenameGroup={(groupId, name) => renameTerminalGroup(threadId, groupId, name)}
            onRoleChange={(groupId, role) => setTerminalGroupRole(threadId, groupId, role)}
            onStopGroup={(groupId) => void stopAllInGroup(groupId)}
            onReorderGroup={(groupId, toIndex) => reorderTerminalGroup(threadId, groupId, toIndex)}
            selectedTerminalIds={activeGroupTerminalIds.filter((terminalId) =>
              terminalTabSelection.selectedIds.has(terminalId),
            )}
            onMoveTerminalsToGroup={(terminalIdsToMove, groupId) =>
              moveTerminalSelection(terminalIdsToMove, { kind: "group", groupId })
            }
            onMoveTerminalsToNewGroup={(terminalIdsToMove, toIndex) =>
              moveTerminalSelection(terminalIdsToMove, { kind: "new-group", toIndex })
            }
            onShowArchivedChange={(show) => setShowArchivedTerminalGroups(threadId, show)}
            onCloseGroup={setPendingCloseGroupId}
          />
        ) : null}

        <div className="min-h-0 w-full flex-1">
          <div
            id={resolvedActiveGroupId ? `terminal-group-panel-${resolvedActiveGroupId}` : undefined}
            role={resolvedActiveGroupId ? "tabpanel" : undefined}
            aria-labelledby={
              resolvedActiveGroupId ? `terminal-group-tab-${resolvedActiveGroupId}` : undefined
            }
            className={cn(
              "flex h-full min-h-0",
              hasTerminalSidebar && !isWorkspaceMode ? "gap-1.5" : "",
            )}
          >
            <div className="min-w-0 flex-1 h-full">
              {resolvedActiveGroupId && activeGroupLayout ? (
                <TerminalViewportPane
                  groupId={resolvedActiveGroupId}
                  layout={activeGroupLayout}
                  resolvedActiveTerminalId={resolvedActiveTerminalId}
                  terminalVisualIdentityById={terminalVisualIdentityById}
                  onActiveTerminalChange={onActiveTerminalChange}
                  onResizeSplit={onResizeTerminalSplit}
                  onSplitTerminalRight={
                    hasReachedSplitLimit
                      ? undefined
                      : (terminalId) => {
                          onActiveTerminalChange(terminalId);
                          onSplitTerminal();
                        }
                  }
                  onSplitTerminalDown={
                    hasReachedSplitLimit
                      ? undefined
                      : (terminalId) => {
                          onActiveTerminalChange(terminalId);
                          onSplitTerminalDown();
                        }
                  }
                  onNewTerminalTab={
                    hasReachedSplitLimit
                      ? undefined
                      : (terminalId) => {
                          onNewTerminalTab(terminalId);
                        }
                  }
                  onMoveTerminalToGroup={isWorkspaceMode ? onMoveTerminalToGroup : undefined}
                  onCloseTerminal={onCloseTerminal}
                  selectedTerminalIds={terminalTabSelection.selectedIds}
                  onTerminalSelectionChange={selectTerminalTab}
                  onTerminalDragStart={startTerminalTabDrag}
                  onTerminalDrop={(terminalIdsToMove, targetTerminalId) =>
                    moveTerminalSelection(terminalIdsToMove, {
                      kind: "group",
                      groupId: resolvedActiveGroupId,
                      targetTerminalId,
                    })
                  }
                  presentationMode={presentationMode}
                  onTogglePresentationMode={onTogglePresentationMode}
                  onTogglePanel={onTogglePanel}
                  isPanelOpen={isPanelOpen}
                  renderViewport={(terminalId, options) => (
                    <TerminalViewport
                      key={terminalId}
                      threadId={threadId}
                      terminalId={terminalId}
                      terminalLabel={
                        terminalVisualIdentityById.get(terminalId)?.title ?? "Terminal"
                      }
                      terminalCliKind={terminalVisualIdentityById.get(terminalId)?.cliKind ?? null}
                      cwd={cwd}
                      {...(runtimeEnv ? { runtimeEnv } : {})}
                      terminalRightClickToPaste={settings.terminalRightClickToPaste}
                      exitState={lifecycleState.terminalExitStatesById[terminalId]}
                      reattachOnly={
                        lifecycleState.terminalLaunchMetadataById[terminalId]?.reattachOnly === true
                      }
                      onRecoveryResolved={(recoveredTerminalId, recovery) => {
                        const launchMetadata =
                          lifecycleState.terminalLaunchMetadataById[recoveredTerminalId];
                        setTerminalLaunchMetadata(threadId, recoveredTerminalId, {
                          cwd: launchMetadata?.cwd ?? cwd,
                          reattachOnly: true,
                        });
                        const recoveredExitState = terminalExitStateFromRecovery(recovery);
                        if (recoveredExitState) {
                          setTerminalExitState(threadId, recoveredTerminalId, recoveredExitState);
                        }
                      }}
                      onSessionExited={(exit) =>
                        setTerminalExitState(
                          threadId,
                          terminalId,
                          terminalExitStateFromProcessExit(exit),
                        )
                      }
                      onRestart={() => restartTerminal(terminalId)}
                      onTerminalMetadataChange={onTerminalMetadataChange}
                      onTerminalActivityChange={onTerminalActivityChange}
                      onAddTerminalContext={onAddTerminalContext}
                      focusRequestId={focusRequestId}
                      autoFocus={options.autoFocus}
                      isVisible={isVisible && options.isVisible}
                    />
                  )}
                />
              ) : (
                <TerminalEmptyState
                  archivedGroupId={mostRecentlyArchivedGroup?.id}
                  onRestoreGroup={restoreGroupAndFocus}
                  onNewGroup={onNewTerminalAction}
                />
              )}
            </div>

            {hasTerminalSidebar && !isWorkspaceMode && resolvedActiveGroupId ? (
              <TerminalSidebar
                terminalIds={normalizedTerminalIds}
                terminalGroups={resolvedTerminalGroups}
                activeTerminalId={resolvedActiveTerminalId}
                activeGroupId={resolvedActiveGroupId}
                showGroupHeaders={showGroupHeaders}
                closeShortcutLabel={resolvedCloseShortcutLabel}
                terminalVisualIdentityById={terminalVisualIdentityById}
                actions={terminalChromeActions}
                onActiveTerminalChange={onActiveTerminalChange}
                onCloseTerminal={onCloseTerminal}
              />
            ) : null}
          </div>
        </div>
      </aside>
      <AlertDialog
        open={pendingArchiveGroupId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchiveGroupId(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop running terminals and archive?</AlertDialogTitle>
            <AlertDialogDescription>
              This group has running processes. Synara will stop them, preserve the terminal history
              and layout, and archive the group.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button autoFocus variant="default" onClick={() => void stopAndArchivePendingGroup()}>
              Stop and archive
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={pendingCloseGroup !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingCloseGroupId(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Close and remove {pendingCloseGroup?.name ?? "terminal group"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the group, closes every terminal in it, and deletes their
              terminal history. Archive the group instead if you may need it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              autoFocus
              variant="destructive"
              onClick={() => {
                if (!pendingCloseGroup) return;
                void closeTerminalGroupDestructively(pendingCloseGroup.id).then((closed) => {
                  if (closed) setPendingCloseGroupId(null);
                });
              }}
            >
              Close and remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
