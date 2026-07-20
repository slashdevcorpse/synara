import { describe, expect, it } from "vitest";

import { DEFAULT_THEME_STATE } from "./theme.logic";
import { resolveDefaultThemeState } from "./themeDefaults";

describe("resolveDefaultThemeState", () => {
  it("uses dark for the isolated Super Synara renderer origin", () => {
    expect(resolveDefaultThemeState("super-synara:")).toEqual({
      ...DEFAULT_THEME_STATE,
      mode: "dark",
    });
  });

  it.each([undefined, "http:", "https:", "synara:", "synara-canary:"])(
    "preserves the system default for the %s renderer origin",
    (protocol) => {
      expect(resolveDefaultThemeState(protocol)).toBe(DEFAULT_THEME_STATE);
    },
  );
});
