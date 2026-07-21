import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarProjectGitActionIndicator } from "./SidebarProjectGitActionIndicator";

describe("SidebarProjectGitActionIndicator", () => {
  it("is visibly distinct and exposes the matched project in its accessible name", () => {
    const markup = renderToStaticMarkup(<SidebarProjectGitActionIndicator projectName="Synara" />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Git operation running for Synara"');
    expect(markup).toContain("text-info");
    expect(markup).toContain("motion-safe:animate-pulse");
  });
});
