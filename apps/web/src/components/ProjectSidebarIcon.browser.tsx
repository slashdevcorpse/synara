// FILE: ProjectSidebarIcon.browser.tsx
// Purpose: Browser regressions for project favicon cache transitions.

import "../index.css";

import { useState } from "react";
import { flushSync } from "react-dom";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/lib/wsHttpUrl", () => ({
  resolveWsHttpUrl: (rawPath: string) =>
    `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E#${rawPath}`,
}));

import { ProjectSidebarIcon } from "./ProjectSidebarIcon";

class ProbeImage extends EventTarget {
  static instances: ProbeImage[] = [];
  src = "";

  constructor() {
    super();
    ProbeImage.instances.push(this);
  }
}

function visibleFavicon(): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>('img[aria-hidden="true"]');
}

describe("ProjectSidebarIcon", () => {
  beforeEach(() => {
    ProbeImage.instances = [];
    vi.stubGlobal("Image", ProbeImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders a cached favicon immediately when cwd changes", async () => {
    const cwdA = `C:\\projects\\favicon-a-${crypto.randomUUID()}`;
    const cwdB = `C:\\projects\\favicon-b-${crypto.randomUUID()}`;

    function Harness() {
      const [cwd, setCwd] = useState(cwdA);
      return (
        <>
          <button type="button" onClick={() => setCwd(cwdA)}>
            Show A
          </button>
          <button type="button" onClick={() => setCwd(cwdB)}>
            Show B
          </button>
          <ProjectSidebarIcon cwd={cwd} expanded={false} />
        </>
      );
    }

    await render(<Harness />);
    await vi.waitFor(() => expect(ProbeImage.instances).toHaveLength(1));
    flushSync(() => {
      ProbeImage.instances[0]?.dispatchEvent(new Event("load"));
    });
    await vi.waitFor(() => expect(visibleFavicon()?.src ?? "").toContain(encodeURIComponent(cwdA)));

    await page.getByRole("button", { name: "Show B" }).click();
    await vi.waitFor(() => expect(ProbeImage.instances).toHaveLength(2));
    flushSync(() => {
      ProbeImage.instances[1]?.dispatchEvent(new Event("load"));
    });
    await vi.waitFor(() => expect(visibleFavicon()?.src ?? "").toContain(encodeURIComponent(cwdB)));

    await page.getByRole("button", { name: "Show A" }).click();

    expect(visibleFavicon()?.src ?? "").toContain(encodeURIComponent(cwdA));
  });
});
