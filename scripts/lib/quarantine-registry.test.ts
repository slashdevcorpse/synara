import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatQuarantineSummary,
  QUARANTINE_PLATFORMS,
  quarantineTestNamePattern,
  quarantineSuitesForPlatform,
  validateQuarantineRegistry,
} from "./quarantine-registry";

const roots: string[] = [];
const quarantineMarker = (id: string) => `[quarantine:${id}]`;

function fixture(): { readonly root: string; readonly source: string } {
  const root = mkdtempSync(resolve(tmpdir(), "synara-quarantine-"));
  roots.push(root);
  mkdirSync(resolve(root, "apps/web/src"), { recursive: true });
  writeFileSync(
    resolve(root, "apps/web/src/example.browser.tsx"),
    `it(${JSON.stringify(`${quarantineMarker("web-geometry")} measures layout`)}, () => {});`,
  );
  return {
    root,
    source: [
      "schemaVersion: 1",
      "entries:",
      "  - id: web-geometry",
      "    path: apps/web/src/example.browser.tsx",
      `    marker: ${JSON.stringify(quarantineMarker("web-geometry"))}`,
      "    suite: browser-geometry",
      "    platform:",
      "      - linux",
      "      - windows",
      "    reason: Hosted browser fonts change pixel geometry.",
      "    owner: web/transcript",
      '    lastFlaked: "2026-07-01"',
      "    cases: 11",
    ].join("\n"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("quarantine registry", () => {
  it("accepts a deterministic registry whose marker exists in the declared source", () => {
    const { root, source } = fixture();
    const result = validateQuarantineRegistry(source, {
      repositoryRoot: root,
      today: "2026-07-20",
    });

    expect(result.errors).toEqual([]);
    expect(result.registry?.entries).toHaveLength(1);
    expect(quarantineSuitesForPlatform(result.registry!, "windows")).toEqual(["browser-geometry"]);
    expect(QUARANTINE_PLATFORMS).toEqual(["linux", "windows"]);
  });

  it("rejects future dates, unsupported platforms, and markers that do not match the id", () => {
    const { root, source } = fixture();
    const invalid = source
      .replace(quarantineMarker("web-geometry"), quarantineMarker("wrong-id"))
      .replace("      - windows", "      - macos")
      .replace("2026-07-01", "2026-07-21");

    expect(
      validateQuarantineRegistry(invalid, { repositoryRoot: root, today: "2026-07-20" }).errors,
    ).toEqual(
      expect.arrayContaining([
        "Quarantine entry 1 marker must exactly match its id.",
        "Quarantine entry 1 platform must contain supported platforms.",
        "Quarantine entry 1 lastFlaked cannot be in the future.",
      ]),
    );
  });

  it("derives platform-scoped stable and quarantine selectors for every registered marker", () => {
    const { root, source } = fixture();
    writeFileSync(
      resolve(root, "apps/web/src/windows-only.browser.tsx"),
      `it(${JSON.stringify(`${quarantineMarker("web-windows-only")} measures Windows layout`)}, () => {});`,
    );
    const result = validateQuarantineRegistry(
      [
        source,
        "  - id: web-windows-only",
        "    path: apps/web/src/windows-only.browser.tsx",
        `    marker: ${JSON.stringify(quarantineMarker("web-windows-only"))}`,
        "    suite: browser-geometry",
        "    platform:",
        "      - windows",
        "    reason: Windows font metrics change pixel geometry.",
        "    owner: web/transcript",
        '    lastFlaked: "2026-07-02"',
        "    cases: 1",
      ].join("\n"),
      { repositoryRoot: root, today: "2026-07-20" },
    );

    expect(result.errors).toEqual([]);
    const linuxStable = quarantineTestNamePattern(result.registry!, "linux", "stable");
    const linuxQuarantine = quarantineTestNamePattern(result.registry!, "linux", "quarantine");
    const windowsStable = quarantineTestNamePattern(result.registry!, "windows", "stable");
    const windowsQuarantine = quarantineTestNamePattern(result.registry!, "windows", "quarantine");
    expect(linuxStable.test(`suite ${quarantineMarker("web-geometry")}`)).toBe(false);
    expect(linuxStable.test(`suite ${quarantineMarker("web-windows-only")}`)).toBe(true);
    expect(linuxQuarantine.test(`suite ${quarantineMarker("web-geometry")}`)).toBe(true);
    expect(linuxQuarantine.test(`suite ${quarantineMarker("web-windows-only")}`)).toBe(false);
    expect(windowsStable.test(`suite ${quarantineMarker("web-geometry")}`)).toBe(false);
    expect(windowsStable.test(`suite ${quarantineMarker("web-windows-only")}`)).toBe(false);
    expect(windowsQuarantine.test(`suite ${quarantineMarker("web-geometry")}`)).toBe(true);
    expect(windowsQuarantine.test(`suite ${quarantineMarker("web-windows-only")}`)).toBe(true);
  });

  it("rejects an unregistered quarantine marker discovered in another test source", () => {
    const { root, source } = fixture();
    writeFileSync(
      resolve(root, "apps/web/src/drift.test.ts"),
      `it(${JSON.stringify(quarantineMarker("unregistered"))}, () => {});`,
    );

    expect(
      validateQuarantineRegistry(source, { repositoryRoot: root, today: "2026-07-20" }).errors,
    ).toContain(
      `Unregistered quarantine marker ${quarantineMarker("unregistered")} found in apps/web/src/drift.test.ts.`,
    );
  });

  it("summarizes registered groups, cases, platform scope, and quarantine age", () => {
    const { root, source } = fixture();
    const registry = validateQuarantineRegistry(source, {
      repositoryRoot: root,
      today: "2026-07-20",
    }).registry!;

    const summary = formatQuarantineSummary(registry, {
      today: "2026-07-20",
      platform: "linux",
      baseline: {
        ref: "0".repeat(40),
        registry: { schemaVersion: 1, entries: [] },
      },
    });

    expect(summary).toContain("## Test quarantine for linux");
    expect(summary).toContain("Registered groups: **1**");
    expect(summary).toContain("Registered test cases: **11**");
    expect(summary).toContain("Oldest active quarantine: **19 days**");
    expect(summary).toContain(`Baseline ref: \`${"0".repeat(40)}\``);
    expect(summary).toContain("Change from baseline: **+1 groups**, **+11 cases**");
  });
});
