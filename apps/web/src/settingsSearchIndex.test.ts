// FILE: settingsSearchIndex.test.ts
// Purpose: Guards search coverage for settings entries that do not have a dedicated panel test.
// Layer: Web settings search tests

import { describe, expect, it } from "vitest";

import { rankSettingsSearchEntries, settingsSearchEntryTarget } from "./settingsSearchIndex";

describe("terminal right-click paste settings search", () => {
  it("finds the setting through both paste and context-menu terminology", () => {
    for (const query of ["right click paste", "ctrl context menu"]) {
      const entry = rankSettingsSearchEntries(query, 12).find(
        (candidate) => candidate.id === "behavior:terminal-right-click-paste",
      );

      expect(entry).toBeDefined();
      expect(entry ? settingsSearchEntryTarget(entry) : null).toBe(
        "setting-terminal-right-click-paste",
      );
    }
  });
});
