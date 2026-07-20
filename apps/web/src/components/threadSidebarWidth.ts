// Purpose: Keeps the persisted thread-sidebar width compatible with the current viewport.

export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
export const THREAD_SIDEBAR_DEFAULT_VIEWPORT_WIDTH =
  THREAD_SIDEBAR_DEFAULT_WIDTH + THREAD_MAIN_CONTENT_MIN_WIDTH;

function normalizeViewportWidth(viewportWidth: number): number {
  return Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : THREAD_SIDEBAR_DEFAULT_VIEWPORT_WIDTH;
}

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    normalizeViewportWidth(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

export function resolveThreadSidebarWidth(
  preferredWidth: number | null,
  viewportWidth: number,
): number {
  const width =
    preferredWidth !== null && Number.isFinite(preferredWidth)
      ? preferredWidth
      : THREAD_SIDEBAR_DEFAULT_WIDTH;
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.min(width, resolveThreadSidebarMaximumWidth(viewportWidth)),
  );
}
