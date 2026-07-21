// FILE: useThreadSidebarWidth.ts
// Purpose: Hydrates and maintains the thread sidebar width for the live viewport.
// Layer: Web shell UI

import * as Schema from "effect/Schema";
import { type CSSProperties, useLayoutEffect, useMemo, useState } from "react";

import { getLocalStorageItem } from "../hooks/useLocalStorage";
import {
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_VIEWPORT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarWidth,
} from "./threadSidebarWidth";
import type { SidebarResizableOptions } from "./ui/sidebar";

export interface ThreadSidebarWidthLifecycle {
  readonly providerStyle: CSSProperties;
  readonly resizable: SidebarResizableOptions;
}

function getThreadSidebarViewportWidth(): number {
  return typeof window === "undefined" ? THREAD_SIDEBAR_DEFAULT_VIEWPORT_WIDTH : window.innerWidth;
}

function readThreadSidebarWidth(viewportWidth: number): number {
  try {
    return resolveThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      viewportWidth,
    );
  } catch (error) {
    console.warn("[thread-sidebar] Failed to restore persisted width:", error);
    return resolveThreadSidebarWidth(null, viewportWidth);
  }
}

export function useThreadSidebarWidth(): ThreadSidebarWidthLifecycle {
  const [viewportWidth, setViewportWidth] = useState(getThreadSidebarViewportWidth);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readThreadSidebarWidth(getThreadSidebarViewportWidth()),
  );

  useLayoutEffect(() => {
    const syncWidthToViewport = () => {
      const nextViewportWidth = getThreadSidebarViewportWidth();
      setViewportWidth(nextViewportWidth);
      // Re-read rather than persist the clamp so widening can recover the
      // user's preferred width after a temporarily narrow viewport.
      setSidebarWidth(readThreadSidebarWidth(nextViewportWidth));
    };

    window.addEventListener("resize", syncWidthToViewport);
    syncWidthToViewport();
    return () => {
      window.removeEventListener("resize", syncWidthToViewport);
    };
  }, []);

  const resizable = useMemo<SidebarResizableOptions>(
    () => ({
      maxWidth: resolveThreadSidebarMaximumWidth(viewportWidth),
      minWidth: THREAD_SIDEBAR_MIN_WIDTH,
      onResize: setSidebarWidth,
      shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
        nextWidth <= currentWidth ||
        wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
      storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
    }),
    [viewportWidth],
  );
  const providerStyle = useMemo(
    () => ({ "--sidebar-width": `${sidebarWidth}px` }) as CSSProperties,
    [sidebarWidth],
  );

  return { providerStyle, resizable };
}
