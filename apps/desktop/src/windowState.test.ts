import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopWindowMaximizeIntentGuard,
  createDesktopWindowStateController,
  createLinuxDesktopWindowBoundsIntentFallback,
  desktopPlatformSupportsManualWindowBoundsEvents,
  type DesktopWindowBounds,
  type DesktopWindowStateSource,
  parseDesktopWindowState,
  readDesktopWindowState,
  resolveRestorableDesktopWindowBounds,
  writeDesktopWindowState,
} from "./windowState";

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const temporaryDirectories: string[] = [];

interface MutableWindowSourceState {
  bounds: DesktopWindowBounds;
  normalBounds: DesktopWindowBounds;
  destroyed: boolean;
  fullScreen: boolean;
  maximized: boolean;
  minimized: boolean;
}

function makeWindowSource(overrides: Partial<MutableWindowSourceState> = {}): {
  readonly source: DesktopWindowStateSource;
  readonly state: MutableWindowSourceState;
} {
  const state: MutableWindowSourceState = {
    bounds: { x: 80, y: 60, width: 1100, height: 780 },
    normalBounds: { x: 80, y: 60, width: 1100, height: 780 },
    destroyed: false,
    fullScreen: false,
    maximized: false,
    minimized: false,
    ...overrides,
  };
  return {
    state,
    source: {
      getBounds: () => state.bounds,
      getNormalBounds: () => state.normalBounds,
      isDestroyed: () => state.destroyed,
      isFullScreen: () => state.fullScreen,
      isMaximized: () => state.maximized,
      isMinimized: () => state.minimized,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop window state persistence", () => {
  it("parses domain-valid bounds and rejects sub-minimum or fractional geometry", () => {
    expect(
      parseDesktopWindowState({
        version: 1,
        bounds: { x: -1200, y: 40, width: 840, height: 620 },
        isMaximized: false,
      }),
    ).toEqual({
      version: 1,
      bounds: { x: -1200, y: 40, width: 840, height: 620 },
      isMaximized: false,
    });
    expect(
      parseDesktopWindowState({
        version: 1,
        bounds: { x: 0, y: 0, width: 839, height: 620 },
        isMaximized: false,
      }),
    ).toBeNull();
    expect(
      parseDesktopWindowState({
        version: 1,
        bounds: { x: 0.5, y: 0, width: 840, height: 620 },
        isMaximized: false,
      }),
    ).toBeNull();
  });

  it("round-trips valid state and ignores corrupt persisted JSON", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-window-state-"));
    temporaryDirectories.push(directory);
    const filePath = Path.join(directory, "nested", "window-state.json");
    const state = {
      version: 1,
      bounds: { x: 40, y: 50, width: 1280, height: 800 },
      isMaximized: true,
    } as const;

    writeDesktopWindowState(filePath, state);
    expect(readDesktopWindowState(filePath)).toEqual(state);

    FS.writeFileSync(filePath, "{not-json", "utf8");
    expect(readDesktopWindowState(filePath)).toBeNull();
  });

  it("restores bounds only when one connected display work area fully contains them", () => {
    const secondaryWorkArea = { x: -1920, y: 0, width: 1920, height: 1080 };
    const savedBounds = { x: -1800, y: 80, width: 1200, height: 800 };

    expect(
      resolveRestorableDesktopWindowBounds({
        savedBounds,
        displayWorkAreas: [workArea, secondaryWorkArea],
      }),
    ).toEqual(savedBounds);
    expect(
      resolveRestorableDesktopWindowBounds({
        savedBounds: { x: -100, y: 80, width: 1200, height: 800 },
        displayWorkAreas: [workArea],
      }),
    ).toBeNull();
    expect(resolveRestorableDesktopWindowBounds({ savedBounds, displayWorkAreas: [] })).toBeNull();
  });

  it("rejects bounds that fit the physical display but cross its usable work area", () => {
    const physicalDisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const usableWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const savedBounds = { x: 100, y: 300, width: 1200, height: 780 };

    expect(
      resolveRestorableDesktopWindowBounds({
        savedBounds,
        displayWorkAreas: [physicalDisplayBounds],
      }),
    ).toEqual(savedBounds);
    expect(
      resolveRestorableDesktopWindowBounds({
        savedBounds,
        displayWorkAreas: [usableWorkArea],
      }),
    ).toBeNull();
  });

  it("identifies platforms with manual-only pre-move and pre-resize events", () => {
    expect(desktopPlatformSupportsManualWindowBoundsEvents("win32")).toBe(true);
    expect(desktopPlatformSupportsManualWindowBoundsEvents("darwin")).toBe(true);
    expect(desktopPlatformSupportsManualWindowBoundsEvents("linux")).toBe(false);
  });

  it("consumes only the programmatic startup maximize notification", () => {
    const guard = createDesktopWindowMaximizeIntentGuard();

    guard.noteProgrammaticStartupMaximize();
    expect(guard.consumeMaximizeEventAsUserIntent()).toBe(false);
    expect(guard.consumeMaximizeEventAsUserIntent()).toBe(true);

    guard.noteProgrammaticStartupMaximize();
    expect(guard.consumeUnmaximizeEventAsUserIntent()).toBe(true);
    expect(guard.consumeMaximizeEventAsUserIntent()).toBe(true);
  });

  it("uses a conservative continuous-gesture fallback for Linux bounds intent", () => {
    let now = 0;
    const onUserBoundsChange = vi.fn();
    const fallback = createLinuxDesktopWindowBoundsIntentFallback({
      now: () => now,
      onUserBoundsChange,
    });
    const firstBounds = { x: 80, y: 60, width: 1100, height: 780 };
    const secondBounds = { x: 100, y: 80, width: 1100, height: 780 };
    const thirdBounds = { x: 120, y: 100, width: 1100, height: 780 };

    fallback.completeInitialReveal();
    now = 500;
    fallback.noteBoundsChange("move", firstBounds);
    now = 600;
    fallback.noteBoundsChange("move", secondBounds);
    expect(onUserBoundsChange).not.toHaveBeenCalled();

    now = 1_100;
    fallback.noteBoundsChange("move", firstBounds);
    now = 1_200;
    fallback.noteBoundsChange("move", firstBounds);
    expect(onUserBoundsChange).not.toHaveBeenCalled();

    now = 2_100;
    fallback.noteBoundsChange("move", secondBounds);
    expect(onUserBoundsChange).not.toHaveBeenCalled();

    now = 2_200;
    fallback.noteBoundsChange("move", thirdBounds);
    expect(onUserBoundsChange).toHaveBeenCalledTimes(1);

    fallback.dispose();
    now = 2_300;
    fallback.noteBoundsChange("move", { ...thirdBounds, x: 140 });
    expect(onUserBoundsChange).toHaveBeenCalledTimes(1);
  });

  it("coalesces move and resize activity into the latest state after 500ms", () => {
    vi.useFakeTimers();
    const { source, state } = makeWindowSource();
    const persisted: Array<unknown> = [];
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist: (nextState) => persisted.push(nextState),
    });
    controller.completeInitialReveal();

    state.bounds = { x: 120, y: 80, width: 1200, height: 820 };
    controller.schedulePersist();
    vi.advanceTimersByTime(250);
    state.bounds = { x: 160, y: 100, width: 1360, height: 900 };
    controller.schedulePersist();
    vi.advanceTimersByTime(499);
    expect(persisted).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(persisted).toEqual([
      {
        version: 1,
        bounds: { x: 160, y: 100, width: 1360, height: 900 },
        isMaximized: false,
      },
    ]);
  });

  it("persists normal bounds for maximized windows and current bounds after unmaximize", () => {
    vi.useFakeTimers();
    const { source, state } = makeWindowSource({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      normalBounds: { x: 220, y: 140, width: 1380, height: 920 },
      maximized: true,
    });
    const persisted: Array<unknown> = [];
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist: (nextState) => persisted.push(nextState),
    });
    controller.completeInitialReveal();

    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    state.maximized = false;
    state.bounds = { x: 240, y: 160, width: 1400, height: 940 };
    controller.schedulePersist();
    vi.advanceTimersByTime(500);

    expect(persisted).toEqual([
      {
        version: 1,
        bounds: { x: 220, y: 140, width: 1380, height: 920 },
        isMaximized: true,
      },
      {
        version: 1,
        bounds: { x: 240, y: 160, width: 1400, height: 940 },
        isMaximized: false,
      },
    ]);
  });

  it("ignores fullscreen and minimized geometry", () => {
    vi.useFakeTimers();
    const initialState = {
      version: 1,
      bounds: { x: 120, y: 80, width: 1280, height: 840 },
      isMaximized: true,
    } as const;
    const { source, state } = makeWindowSource({
      normalBounds: { x: 160, y: 100, width: 1360, height: 900 },
      fullScreen: true,
    });
    const persisted: Array<unknown> = [];
    const controller = createDesktopWindowStateController({
      source,
      initialState,
      initialBoundsRestored: true,
      persist: (nextState) => persisted.push(nextState),
    });
    controller.completeInitialReveal();

    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persisted).toEqual([]);

    state.fullScreen = false;
    state.minimized = true;
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persisted).toEqual([]);

    state.minimized = false;
    state.maximized = true;
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persisted).toEqual([
      {
        version: 1,
        bounds: { x: 160, y: 100, width: 1360, height: 900 },
        isMaximized: true,
      },
    ]);
  });

  it("ignores transient invalid native bounds", () => {
    vi.useFakeTimers();
    const { source, state } = makeWindowSource({
      bounds: { x: -32_000, y: -32_000, width: 160, height: 28 },
    });
    const persisted: Array<unknown> = [];
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist: (nextState) => persisted.push(nextState),
    });
    controller.completeInitialReveal();

    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persisted).toEqual([]);

    state.bounds = { x: 80, y: 60, width: 1100, height: 780 };
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persisted).toHaveLength(1);
  });

  it("flushes the latest state and cancels a pending debounce", () => {
    vi.useFakeTimers();
    const { source, state } = makeWindowSource();
    const persisted: Array<unknown> = [];
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist: (nextState) => persisted.push(nextState),
    });
    controller.completeInitialReveal();

    controller.schedulePersist();
    vi.advanceTimersByTime(200);
    state.bounds = { x: 240, y: 160, width: 1410, height: 930 };
    controller.flush();
    controller.flush();
    vi.advanceTimersByTime(500);

    expect(persisted).toEqual([
      {
        version: 1,
        bounds: { x: 240, y: 160, width: 1410, height: 930 },
        isMaximized: false,
      },
    ]);
  });

  it("flushes the last valid pending state while the native window is minimized", () => {
    vi.useFakeTimers();
    const { source, state } = makeWindowSource();
    const persisted: Array<unknown> = [];
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist: (nextState) => persisted.push(nextState),
    });
    controller.completeInitialReveal();

    state.bounds = { x: 260, y: 180, width: 1420, height: 950 };
    controller.schedulePersist();
    state.minimized = true;
    state.bounds = { x: -32_000, y: -32_000, width: 160, height: 28 };
    controller.flush();
    vi.advanceTimersByTime(500);

    expect(persisted).toEqual([
      {
        version: 1,
        bounds: { x: 260, y: 180, width: 1420, height: 950 },
        isMaximized: false,
      },
    ]);
  });

  it("protects delayed fallback geometry changes until explicit user intent", () => {
    vi.useFakeTimers();
    const initialState = {
      version: 1,
      bounds: { x: 3000, y: 120, width: 1400, height: 920 },
      isMaximized: false,
    } as const;
    const { source, state } = makeWindowSource({
      bounds: { x: 80, y: 60, width: 1100, height: 780 },
    });
    const persisted: Array<unknown> = [];
    const controller = createDesktopWindowStateController({
      source,
      initialState,
      initialBoundsRestored: false,
      persist: (nextState) => persisted.push(nextState),
    });

    controller.completeInitialReveal();
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    controller.flush();
    expect(persisted).toEqual([]);

    state.bounds = { x: 140, y: 100, width: 1180, height: 820 };
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    controller.flush();
    expect(persisted).toEqual([]);

    controller.noteUserBoundsChange();
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persisted).toEqual([
      {
        version: 1,
        bounds: { x: 140, y: 100, width: 1180, height: 820 },
        isMaximized: false,
      },
    ]);
  });

  it("retains explicit user intent noted immediately before reveal completes", () => {
    vi.useFakeTimers();
    const initialState = {
      version: 1,
      bounds: { x: 3000, y: 120, width: 1400, height: 920 },
      isMaximized: false,
    } as const;
    const { source } = makeWindowSource();
    const persist = vi.fn();
    const controller = createDesktopWindowStateController({
      source,
      initialState,
      initialBoundsRestored: false,
      persist,
    });

    controller.noteUserBoundsChange();
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persist).not.toHaveBeenCalled();

    controller.completeInitialReveal();
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("autonomously retries a failed write once without another window event", () => {
    vi.useFakeTimers();
    const { source, state } = makeWindowSource();
    let persistAttempt = 0;
    const persist = vi.fn(() => {
      persistAttempt += 1;
      if (persistAttempt === 1) {
        throw new Error("disk unavailable");
      }
    });
    const onPersistError = vi.fn();
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist,
      onPersistError,
    });
    controller.completeInitialReveal();

    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    expect(persist).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(999);
    expect(persist).toHaveBeenCalledTimes(1);
    state.bounds = { x: 180, y: 120, width: 1240, height: 840 };
    vi.advanceTimersByTime(1);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({
      version: 1,
      bounds: { x: 180, y: 120, width: 1240, height: 840 },
      isMaximized: false,
    });
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated failures and does not let flush create a retry storm", () => {
    vi.useFakeTimers();
    const { source } = makeWindowSource();
    const persist = vi.fn(() => {
      throw new Error("disk unavailable");
    });
    const onPersistError = vi.fn();
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist,
      onPersistError,
    });
    controller.completeInitialReveal();

    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(10_000);
    expect(persist).toHaveBeenCalledTimes(2);

    controller.flush();
    expect(persist).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10_000);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(onPersistError).toHaveBeenCalledTimes(3);
  });

  it("cancels an autonomous persistence retry when disposed", () => {
    vi.useFakeTimers();
    const { source } = makeWindowSource();
    const persist = vi.fn(() => {
      throw new Error("disk unavailable");
    });
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist,
    });
    controller.completeInitialReveal();
    controller.schedulePersist();
    vi.advanceTimersByTime(500);
    controller.dispose();

    vi.advanceTimersByTime(1_000);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("cancels pending persistence when disposed", () => {
    vi.useFakeTimers();
    const { source } = makeWindowSource();
    const persist = vi.fn();
    const controller = createDesktopWindowStateController({
      source,
      initialState: null,
      initialBoundsRestored: false,
      persist,
    });
    controller.completeInitialReveal();
    controller.schedulePersist();
    controller.dispose();

    vi.advanceTimersByTime(500);
    expect(persist).not.toHaveBeenCalled();
  });
});
