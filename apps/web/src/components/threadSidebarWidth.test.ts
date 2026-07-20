import { describe, expect, it } from "vitest";

import {
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarWidth,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveThreadSidebarWidth(null, 1440)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveThreadSidebarWidth(120, 1440)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("clamps a stored width against the current viewport", () => {
    expect(resolveThreadSidebarMaximumWidth(1000)).toBe(360);
    expect(resolveThreadSidebarWidth(500, 1000)).toBe(360);
  });

  it("keeps the sidebar usable when the viewport cannot fit both minimums", () => {
    expect(resolveThreadSidebarMaximumWidth(700)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
    expect(resolveThreadSidebarWidth(null, 700)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
    expect(resolveThreadSidebarWidth(500, 700)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("can reapply the stored preference after the viewport widens", () => {
    const storedWidth = 500;
    expect(resolveThreadSidebarWidth(storedWidth, 1000)).toBe(360);
    expect(resolveThreadSidebarWidth(storedWidth, 1400)).toBe(storedWidth);
  });

  it("falls back safely for non-finite width or viewport values", () => {
    expect(resolveThreadSidebarWidth(Number.NaN, Number.NaN)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });
});
