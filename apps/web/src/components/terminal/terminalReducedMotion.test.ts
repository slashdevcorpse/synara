import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("terminal running indicator motion", () => {
  it("disables pulsing under reduced-motion preferences", () => {
    const css = fs.readFileSync(new URL("../../index.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.terminal-running-indicator__dot\s*\{[\s\S]*?animation:\s*none;/,
    );
  });
});
