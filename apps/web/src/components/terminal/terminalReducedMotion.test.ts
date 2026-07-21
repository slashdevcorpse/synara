import fs from "node:fs";

import { describe, expect, it } from "vitest";

function cssAtRuleBlocks(css: string, atRule: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const atRuleIndex = css.indexOf(atRule, searchFrom);
    if (atRuleIndex === -1) break;
    const openBraceIndex = css.indexOf("{", atRuleIndex + atRule.length);
    if (openBraceIndex === -1) break;
    let depth = 1;
    let cursor = openBraceIndex + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (depth === 0) blocks.push(css.slice(openBraceIndex + 1, cursor - 1));
    searchFrom = cursor;
  }
  return blocks;
}

describe("terminal running indicator motion", () => {
  it("disables pulsing under reduced-motion preferences", () => {
    const css = fs.readFileSync(new URL("../../index.css", import.meta.url), "utf8");
    const reducedMotionBlocks = cssAtRuleBlocks(css, "@media (prefers-reduced-motion: reduce)");
    expect(
      reducedMotionBlocks.some((block) =>
        /\.terminal-running-indicator__dot\s*\{[^{}]*animation:\s*none;/.test(block),
      ),
    ).toBe(true);
  });
});
