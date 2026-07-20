// FILE: SiteFavicon.browser.tsx
// Purpose: Browser regressions for cache-backed favicon source changes.

import "../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, "ok" | "fail">(),
  probe: vi.fn(() => new Promise<"ok" | "fail">(() => {})),
}));

function faviconSrc(host: string): string {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E#${host}`;
}

vi.mock("~/lib/siteFavicon", () => ({
  extractHostname: (url: string) => {
    try {
      return new URL(url).hostname || null;
    } catch {
      return null;
    }
  },
  probeSiteFavicon: mocks.probe,
  resolveSiteFaviconUrl: faviconSrc,
  siteFaviconStatusCache: mocks.cache,
}));

import { SiteFavicon } from "./SiteFavicon";

function visibleFavicon(): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>("img");
}

describe("SiteFavicon", () => {
  beforeEach(() => {
    mocks.cache.clear();
    mocks.probe.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a cached favicon immediately when the host changes", async () => {
    mocks.cache.set(faviconSrc("first.example"), "ok");
    mocks.cache.set(faviconSrc("second.example"), "ok");
    const screen = await render(<SiteFavicon url="https://first.example/a" />);

    expect(visibleFavicon()?.src ?? "").toContain("first.example");

    await screen.rerender(<SiteFavicon url="https://second.example/b" />);

    expect(visibleFavicon()?.src ?? "").toContain("second.example");
  });
});
