import { describe, expect, it } from "vitest";

import { resolveWebBuildVersion } from "./viteBuildVersion";

describe("Vite build version", () => {
  it("embeds the explicit desktop release version", () => {
    expect(
      resolveWebBuildVersion({ SYNARA_WEB_BUILD_VERSION: "0.5.5-super.11" }, "0.5.5"),
    ).toBe("0.5.5-super.11");
  });

  it("uses the web package version for normal development and source builds", () => {
    expect(resolveWebBuildVersion({}, "0.5.5")).toBe("0.5.5");
    expect(resolveWebBuildVersion({ SYNARA_WEB_BUILD_VERSION: "  " }, "0.5.5")).toBe("0.5.5");
  });
});
