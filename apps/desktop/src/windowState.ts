// FILE: windowState.ts
// Purpose: Persists and safely restores the desktop window's normal bounds.
// Layer: Desktop main process

import * as FS from "node:fs";
import * as Path from "node:path";

export const DESKTOP_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
export const DESKTOP_WINDOW_STATE_RETRY_DELAY_MS = 1_000;
export const LINUX_WINDOW_BOUNDS_INTENT_SETTLE_MS = 1_000;
export const LINUX_WINDOW_BOUNDS_INTENT_CONTINUATION_MS = 750;
export const DEFAULT_DESKTOP_WINDOW_SIZE = {
  width: 1100,
  height: 780,
} as const;
export const MINIMUM_DESKTOP_WINDOW_SIZE = {
  width: 840,
  height: 620,
} as const;

export interface DesktopWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PersistedDesktopWindowState {
  readonly version: 1;
  readonly bounds: DesktopWindowBounds;
  readonly isMaximized: boolean;
}

export interface DesktopWindowStateSource {
  readonly getBounds: () => DesktopWindowBounds;
  readonly getNormalBounds: () => DesktopWindowBounds;
  readonly isDestroyed: () => boolean;
  readonly isFullScreen: () => boolean;
  readonly isMaximized: () => boolean;
  readonly isMinimized: () => boolean;
}

export interface DesktopWindowStateController {
  /** Enable post-launch persistence after native reveal/maximize events have settled. */
  readonly completeInitialReveal: () => void;
  /** Arm persistence after a positively identified user move, resize, or maximize action. */
  readonly noteUserBoundsChange: () => void;
  /** Debounce a read of the latest native window state. */
  readonly schedulePersist: () => void;
  /** Cancel the debounce and synchronously persist the latest stable state. */
  readonly flush: () => void;
  readonly dispose: () => void;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function normalizeDesktopWindowBounds(value: unknown): DesktopWindowBounds | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isFiniteInteger(candidate.x) ||
    !isFiniteInteger(candidate.y) ||
    !isFiniteInteger(candidate.width) ||
    candidate.width < MINIMUM_DESKTOP_WINDOW_SIZE.width ||
    !isFiniteInteger(candidate.height) ||
    candidate.height < MINIMUM_DESKTOP_WINDOW_SIZE.height
  ) {
    return null;
  }
  return {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  };
}

export function parseDesktopWindowState(value: unknown): PersistedDesktopWindowState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const bounds = normalizeDesktopWindowBounds(candidate.bounds);
  if (candidate.version !== 1 || bounds === null || typeof candidate.isMaximized !== "boolean") {
    return null;
  }
  return {
    version: 1,
    bounds,
    isMaximized: candidate.isMaximized,
  };
}

export function readDesktopWindowState(filePath: string): PersistedDesktopWindowState | null {
  try {
    return parseDesktopWindowState(JSON.parse(FS.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function writeDesktopWindowState(
  filePath: string,
  state: PersistedDesktopWindowState,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function windowFitsWithinWorkArea(
  windowBounds: DesktopWindowBounds,
  workArea: DesktopWindowBounds,
): boolean {
  return (
    windowBounds.x >= workArea.x &&
    windowBounds.y >= workArea.y &&
    windowBounds.x + windowBounds.width <= workArea.x + workArea.width &&
    windowBounds.y + windowBounds.height <= workArea.y + workArea.height
  );
}

/**
 * Return persisted bounds only when one connected display's usable work area
 * contains the complete rectangle. Taskbars, menu bars, partially visible
 * bounds, and disconnected displays all fall back to Electron placement.
 */
export function resolveRestorableDesktopWindowBounds(input: {
  readonly savedBounds: DesktopWindowBounds;
  readonly displayWorkAreas: ReadonlyArray<DesktopWindowBounds>;
}): DesktopWindowBounds | null {
  return input.displayWorkAreas.some((workArea) =>
    windowFitsWithinWorkArea(input.savedBounds, workArea),
  )
    ? input.savedBounds
    : null;
}

function desktopWindowStatesEqual(
  left: PersistedDesktopWindowState,
  right: PersistedDesktopWindowState,
): boolean {
  return (
    left.isMaximized === right.isMaximized &&
    left.bounds.x === right.bounds.x &&
    left.bounds.y === right.bounds.y &&
    left.bounds.width === right.bounds.width &&
    left.bounds.height === right.bounds.height
  );
}

function desktopWindowBoundsEqual(left: DesktopWindowBounds, right: DesktopWindowBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Electron exposes manual-only pre-move/pre-resize events on these platforms. */
export function desktopPlatformSupportsManualWindowBoundsEvents(
  platform: NodeJS.Platform,
): boolean {
  return platform === "darwin" || platform === "win32";
}

export interface DesktopWindowMaximizeIntentGuard {
  readonly noteProgrammaticStartupMaximize: () => void;
  readonly consumeMaximizeEventAsUserIntent: () => boolean;
  readonly consumeUnmaximizeEventAsUserIntent: () => boolean;
}

/** Separates the one startup maximize notification from later native user actions. */
export function createDesktopWindowMaximizeIntentGuard(): DesktopWindowMaximizeIntentGuard {
  let startupMaximizePending = false;
  return {
    noteProgrammaticStartupMaximize: () => {
      startupMaximizePending = true;
    },
    consumeMaximizeEventAsUserIntent: () => {
      if (!startupMaximizePending) {
        return true;
      }
      startupMaximizePending = false;
      return false;
    },
    consumeUnmaximizeEventAsUserIntent: () => {
      startupMaximizePending = false;
      return true;
    },
  };
}

export type DesktopWindowBoundsChangeKind = "move" | "resize";

export interface LinuxDesktopWindowBoundsIntentFallback {
  readonly completeInitialReveal: () => void;
  readonly noteBoundsChange: (
    kind: DesktopWindowBoundsChangeKind,
    bounds: DesktopWindowBounds,
  ) => void;
  readonly dispose: () => void;
}

/**
 * Linux does not expose Electron's manual-only pre-move/pre-resize events. The
 * conservative fallback ignores the reveal settling interval, then requires two
 * distinct normal-state updates of the same kind in quick succession. That
 * recognizes an ongoing drag/resize while a one-off compositor correction never
 * arms persistence. A discrete one-step move may therefore wait for a later
 * explicit maximize action or continuous bounds gesture before being persisted.
 */
export function createLinuxDesktopWindowBoundsIntentFallback(input: {
  readonly onUserBoundsChange: () => void;
  readonly now?: () => number;
  readonly settleMs?: number;
  readonly continuationMs?: number;
}): LinuxDesktopWindowBoundsIntentFallback {
  const now = input.now ?? Date.now;
  const settleMs = input.settleMs ?? LINUX_WINDOW_BOUNDS_INTENT_SETTLE_MS;
  const continuationMs = input.continuationMs ?? LINUX_WINDOW_BOUNDS_INTENT_CONTINUATION_MS;
  let disposed = false;
  let armed = false;
  let revealCompletedAt: number | null = null;
  let candidate: {
    readonly at: number;
    readonly bounds: DesktopWindowBounds;
    readonly kind: DesktopWindowBoundsChangeKind;
  } | null = null;

  return {
    completeInitialReveal: () => {
      if (disposed || revealCompletedAt !== null) {
        return;
      }
      revealCompletedAt = now();
      candidate = null;
    },
    noteBoundsChange: (kind, rawBounds) => {
      if (disposed || armed || revealCompletedAt === null) {
        return;
      }
      const at = now();
      if (at - revealCompletedAt < settleMs) {
        candidate = null;
        return;
      }
      const bounds = normalizeDesktopWindowBounds(rawBounds);
      if (bounds === null) {
        return;
      }
      if (
        candidate !== null &&
        candidate.kind === kind &&
        at - candidate.at <= continuationMs &&
        !desktopWindowBoundsEqual(candidate.bounds, bounds)
      ) {
        armed = true;
        candidate = null;
        input.onUserBoundsChange();
        return;
      }
      candidate = { at, bounds, kind };
    },
    dispose: () => {
      disposed = true;
      candidate = null;
    },
  };
}

export function createDesktopWindowStateController(input: {
  readonly source: DesktopWindowStateSource;
  readonly initialState: PersistedDesktopWindowState | null;
  readonly initialBoundsRestored: boolean;
  readonly persist: (state: PersistedDesktopWindowState) => void;
  readonly onPersistError?: (error: unknown) => void;
  readonly debounceMs?: number;
  readonly retryDelayMs?: number;
}): DesktopWindowStateController {
  const debounceMs = input.debounceMs ?? DESKTOP_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS;
  const retryDelayMs = input.retryDelayMs ?? DESKTOP_WINDOW_STATE_RETRY_DELAY_MS;
  let disposed = false;
  let initialRevealComplete = false;
  let persistenceEnabled = input.initialState === null || input.initialBoundsRestored;
  let lastPersistedState = input.initialState;
  let pendingState: PersistedDesktopWindowState | null = null;
  let pendingGeneration = 0;
  let retryAttemptedGeneration: number | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPendingTimer = () => {
    if (pendingTimer === null) {
      return;
    }
    clearTimeout(pendingTimer);
    pendingTimer = null;
  };

  const clearRetryTimer = () => {
    if (retryTimer === null) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const readCurrentState = (): PersistedDesktopWindowState | null => {
    try {
      if (input.source.isDestroyed()) {
        return null;
      }
      const isFullScreen = input.source.isFullScreen();
      const isMinimized = input.source.isMinimized();
      if (isFullScreen || isMinimized) {
        return null;
      }
      const isMaximized = input.source.isMaximized();
      const rawBounds = isMaximized ? input.source.getNormalBounds() : input.source.getBounds();
      const bounds = normalizeDesktopWindowBounds({
        x: Math.round(rawBounds.x),
        y: Math.round(rawBounds.y),
        width: Math.round(rawBounds.width),
        height: Math.round(rawBounds.height),
      });
      if (bounds === null) {
        return null;
      }
      return {
        version: 1,
        bounds,
        isMaximized,
      };
    } catch {
      return null;
    }
  };

  const setPendingState = (state: PersistedDesktopWindowState) => {
    if (pendingState === null || !desktopWindowStatesEqual(pendingState, state)) {
      pendingState = state;
      pendingGeneration += 1;
    }
  };

  const persistState = (state: PersistedDesktopWindowState): boolean => {
    if (lastPersistedState !== null && desktopWindowStatesEqual(lastPersistedState, state)) {
      return true;
    }
    try {
      input.persist(state);
      lastPersistedState = state;
      return true;
    } catch (error) {
      try {
        input.onPersistError?.(error);
      } catch {
        // Persistence failures must remain contained even if diagnostic logging fails.
      }
      return false;
    }
  };

  const captureCurrentState = () => {
    if (disposed || !initialRevealComplete || !persistenceEnabled) {
      return;
    }
    const state = readCurrentState();
    if (state === null) {
      return;
    }
    setPendingState(state);
  };

  const scheduleAutonomousRetry = () => {
    if (
      disposed ||
      pendingState === null ||
      retryTimer !== null ||
      retryAttemptedGeneration === pendingGeneration
    ) {
      return;
    }
    retryAttemptedGeneration = pendingGeneration;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      captureCurrentState();
      // A newer pending state inherits this already-bounded retry instead of
      // spawning another timer for the same unresolved write cycle.
      retryAttemptedGeneration = pendingGeneration;
      attemptPendingState();
    }, retryDelayMs);
  };

  const attemptPendingState = () => {
    if (pendingState === null) {
      return;
    }
    if (persistState(pendingState)) {
      pendingState = null;
      retryAttemptedGeneration = null;
      clearPendingTimer();
      clearRetryTimer();
      return;
    }
    scheduleAutonomousRetry();
  };

  return {
    completeInitialReveal: () => {
      if (disposed || initialRevealComplete) {
        return;
      }
      initialRevealComplete = true;
    },
    noteUserBoundsChange: () => {
      if (!disposed) {
        persistenceEnabled = true;
      }
    },
    schedulePersist: () => {
      if (disposed || !initialRevealComplete || !persistenceEnabled) {
        return;
      }
      const state = readCurrentState();
      if (state === null) {
        return;
      }
      setPendingState(state);
      clearPendingTimer();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        captureCurrentState();
        attemptPendingState();
      }, debounceMs);
    },
    flush: () => {
      clearPendingTimer();
      captureCurrentState();
      attemptPendingState();
    },
    dispose: () => {
      disposed = true;
      clearPendingTimer();
      clearRetryTimer();
      pendingState = null;
    },
  };
}
