import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectQuarantineInventoryBatches,
  createQuarantineInventoryEnvironment,
  createQuarantineInventoryTemporaryDirectory,
  formatQuarantineSummary,
  parseVitestBrowserFiles,
  parseVitestQuarantineInventory,
  QUARANTINE_PLATFORMS,
  quarantineInventoryFileBatches,
  quarantineTestNamePattern,
  quarantineSuitesForPlatform,
  validateQuarantineCaseInventory,
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
  it("isolates route generation and removes inherited case variants", () => {
    const generatedRouteTreePath = resolve(tmpdir(), "quarantine-route-tree", "routeTree.gen.ts");
    const environment = createQuarantineInventoryEnvironment(
      {
        PATH: "inherited-path",
        SYNARA_GENERATED_ROUTE_TREE: "stale-exact-path",
        synara_generated_route_tree: "stale-lowercase-path",
        Synara_Generated_Route_Tree: "stale-mixed-case-path",
      },
      generatedRouteTreePath,
    );

    expect(environment).toMatchObject({
      PATH: "inherited-path",
      CI: "true",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      SYNARA_GENERATED_ROUTE_TREE: generatedRouteTreePath,
    });
    expect(environment.synara_generated_route_tree).toBeUndefined();
    expect(environment.Synara_Generated_Route_Tree).toBeUndefined();
    expect(() => createQuarantineInventoryEnvironment({}, "relative/routeTree.gen.ts")).toThrow(
      "absolute generated route-tree path",
    );
  });

  it("keeps generated route-tree staging on the repository filesystem", () => {
    const { root } = fixture();
    const temporaryDirectory = createQuarantineInventoryTemporaryDirectory(root);

    expect(relative(root, temporaryDirectory).replaceAll("\\", "/")).toMatch(
      /^apps\/web\/\.tanstack\/quarantine-inventory-/,
    );
  });

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

  it("requires the declared case count to equal Vitest-collected leaf tests", () => {
    const { root, source } = fixture();
    const registry = validateQuarantineRegistry(source, {
      repositoryRoot: root,
      today: "2026-07-20",
    }).registry!;
    const entry = registry.entries[0]!;
    const inventory = Array.from({ length: 11 }, (_, index) => ({
      path: entry.path,
      fullName: `suite ${entry.marker} case ${index + 1}`,
    }));

    expect(validateQuarantineCaseInventory(registry, inventory)).toEqual([]);
    expect(
      validateQuarantineCaseInventory(registry, [
        ...inventory,
        { path: entry.path, fullName: `suite ${entry.marker} case 12` },
      ]),
    ).toContain("Quarantine entry `web-geometry` declares 11 case(s), but Vitest collected 12.");
    expect(validateQuarantineCaseInventory(registry, [])).toContain(
      "Quarantine entry `web-geometry` declares 11 case(s), but Vitest collected 0.",
    );
  });

  it("counts marked describe and it.each expansions by collected leaf name", () => {
    const { root, source } = fixture();
    const parsed = validateQuarantineRegistry(source, {
      repositoryRoot: root,
      today: "2026-07-20",
    }).registry!;
    const entry = parsed.entries[0]!;
    const registry = {
      ...parsed,
      entries: [{ ...entry, platform: ["windows"] as const, cases: 3 }],
    };
    const inventory = [
      { path: entry.path, fullName: `${entry.marker} marked suite > child one` },
      { path: entry.path, fullName: `${entry.marker} marked suite > child two` },
      { path: entry.path, fullName: `suite > ${entry.marker} row three` },
    ];

    expect(validateQuarantineCaseInventory(registry, inventory)).toEqual([]);
  });

  it("rejects collected markers from the wrong file or without a registry entry", () => {
    const { root, source } = fixture();
    const registry = validateQuarantineRegistry(source, {
      repositoryRoot: root,
      today: "2026-07-20",
    }).registry!;
    const entry = registry.entries[0]!;
    const errors = validateQuarantineCaseInventory(registry, [
      { path: "apps/web/src/wrong.browser.tsx", fullName: `suite ${entry.marker} child` },
      {
        path: entry.path,
        fullName: `suite ${quarantineMarker("unregistered-collected")} child`,
      },
    ]);

    expect(errors).toEqual(
      expect.arrayContaining([
        `Quarantine marker ${entry.marker} was collected in apps/web/src/wrong.browser.tsx, not ${entry.path}.`,
        `Unregistered quarantine marker ${quarantineMarker("unregistered-collected")} collected in ${entry.path}.`,
        "Quarantine entry `web-geometry` declares 11 case(s), but Vitest collected 0.",
      ]),
    );
  });

  it("fails closed for malformed, unsuccessful, and timed-out Vitest inventory output", () => {
    const { root } = fixture();
    expect(() =>
      parseVitestQuarantineInventory(
        { status: 0, stdout: "not json", stderr: "" },
        { repositoryRoot: root },
      ),
    ).toThrow("did not return valid JSON");
    expect(() =>
      parseVitestQuarantineInventory(
        { status: 1, stdout: "", stderr: "collection failed" },
        { repositoryRoot: root },
      ),
    ).toThrow("exited with status 1");
    expect(() =>
      parseVitestQuarantineInventory(
        {
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          status: null,
          stdout: "",
          stderr: "",
        },
        { repositoryRoot: root },
      ),
    ).toThrow("collection timed out");
  });

  it("parses Vitest's complete JSON array after Vite optimizer logs", () => {
    const { root } = fixture();
    const file = resolve(root, "apps/web/src/example.browser.tsx");
    const stdout = [
      "3:50:13 p.m. [vite] (client) Re-optimizing dependencies because vite config has changed",
      "3:50:16 p.m. [vite] (client) [optimizer] bundling dependencies...",
      JSON.stringify([{ name: `${quarantineMarker("web-geometry")} case`, file }], null, 2),
      "",
    ].join("\n");

    expect(
      parseVitestQuarantineInventory(
        { status: 0, stdout, stderr: "a non-fatal Vite warning" },
        { repositoryRoot: root },
      ),
    ).toEqual([
      {
        path: "apps/web/src/example.browser.tsx",
        fullName: `${quarantineMarker("web-geometry")} case`,
      },
    ]);
    expect(() =>
      parseVitestQuarantineInventory(
        { status: 0, stdout: `${stdout}unexpected trailing output`, stderr: "" },
        { repositoryRoot: root },
      ),
    ).toThrow("did not return valid JSON");
  });

  it("discovers every browser file and partitions each path exactly once", () => {
    const { root } = fixture();
    const first = resolve(root, "apps/web/src/example.browser.tsx");
    const second = resolve(root, "apps/web/src/second.browser.tsx");
    const files = parseVitestBrowserFiles(
      {
        status: 0,
        stdout: JSON.stringify([{ file: second }, { file: first }, { file: second }]),
        stderr: "",
      },
      { repositoryRoot: root },
    );

    expect(files).toEqual(["apps/web/src/example.browser.tsx", "apps/web/src/second.browser.tsx"]);
    expect(quarantineInventoryFileBatches(files, 1)).toEqual([
      ["apps/web/src/example.browser.tsx"],
      ["apps/web/src/second.browser.tsx"],
    ]);
    expect(() => quarantineInventoryFileBatches(files, 0)).toThrow("positive integer");
  });

  it("retries failed batches, splits persistent conflicts, and fails closed per file", () => {
    const attempts: string[][] = [];
    const files = ["one.browser.ts", "two.browser.ts", "three.browser.ts"];
    const inventory = collectQuarantineInventoryBatches([files], (batch) => {
      attempts.push([...batch]);
      if (batch.length > 1) throw new Error("cross-file mock conflict");
      return batch;
    });

    expect(inventory).toEqual(files);
    expect(attempts.filter((batch) => batch.length > 1)).toHaveLength(4);
    expect(() =>
      collectQuarantineInventoryBatches([["broken.browser.ts"]], () => {
        throw new Error("single-file import failed");
      }),
    ).toThrow("single-file import failed");
  });

  it("uses pinned Vitest collection to expand each row into a separate case", () => {
    const root = mkdtempSync(resolve(tmpdir(), "synara-quarantine-inventory-"));
    roots.push(root);
    const marker = quarantineMarker("expanded-rows");
    const testPath = resolve(root, "expanded.test.ts");
    writeFileSync(
      testPath,
      `it.each(["one", "two", "three"])(${JSON.stringify(`${marker} row %s`)}, () => {});`,
    );
    const vitestCli = resolve(__dirname, "../../node_modules/vitest/vitest.mjs");
    const result = spawnSync(
      process.execPath,
      [vitestCli, "list", testPath, "--root", root, "--globals", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const inventory = parseVitestQuarantineInventory(
      {
        ...(result.error ? { error: result.error } : {}),
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      },
      { repositoryRoot: root },
    );
    const registry = {
      schemaVersion: 1 as const,
      entries: [
        {
          id: "expanded-rows",
          path: "expanded.test.ts",
          marker,
          suite: "browser-geometry" as const,
          platform: ["linux", "windows"] as const,
          reason: "Expanded rows verify collected inventory counts.",
          owner: "web/test-infrastructure",
          lastFlaked: "2026-07-01",
          cases: 3,
        },
      ],
    };

    expect(inventory).toHaveLength(3);
    expect(validateQuarantineCaseInventory(registry, inventory)).toEqual([]);
  });

  it("rejects a runtime-composed quarantine marker in a non-registered file", () => {
    const root = mkdtempSync(resolve(tmpdir(), "synara-quarantine-runtime-marker-"));
    roots.push(root);
    const marker = quarantineMarker("runtime-wrong-file");
    const registeredPath = resolve(root, "registered.test.ts");
    writeFileSync(registeredPath, `it(${JSON.stringify(`${marker} registered`)}, () => {});`);
    writeFileSync(
      resolve(root, "runtime-marker.ts"),
      'export const runtimeMarker = ["[quaran", "tine:runtime-wrong-file]"].join("");',
    );
    writeFileSync(
      resolve(root, "wrong-file.test.ts"),
      [
        'import { runtimeMarker } from "./runtime-marker";',
        "it(`${runtimeMarker} composed at runtime`, () => {});",
      ].join("\n"),
    );
    const vitestCli = resolve(__dirname, "../../node_modules/vitest/vitest.mjs");
    const result = spawnSync(
      process.execPath,
      [vitestCli, "list", "--root", root, "--globals", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const inventory = parseVitestQuarantineInventory(
      {
        ...(result.error ? { error: result.error } : {}),
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      },
      { repositoryRoot: root },
    );
    const registry = {
      schemaVersion: 1 as const,
      entries: [
        {
          id: "runtime-wrong-file",
          path: "registered.test.ts",
          marker,
          suite: "browser-geometry" as const,
          platform: ["linux", "windows"] as const,
          reason: "Runtime collection must reject markers from the wrong file.",
          owner: "web/test-infrastructure",
          lastFlaked: "2026-07-01",
          cases: 1,
        },
      ],
    };

    expect(inventory).toHaveLength(2);
    expect(validateQuarantineCaseInventory(registry, inventory)).toContain(
      `Quarantine marker ${marker} was collected in wrong-file.test.ts, not registered.test.ts.`,
    );
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

  it("rejects duplicate and unsorted entry ids", () => {
    const duplicateFixture = fixture();
    const duplicateSource = [
      duplicateFixture.source,
      ...duplicateFixture.source.split("\n").slice(2),
    ].join("\n");
    expect(
      validateQuarantineRegistry(duplicateSource, {
        repositoryRoot: duplicateFixture.root,
        today: "2026-07-20",
      }).errors,
    ).toContain("Quarantine entry 2 duplicates id `web-geometry`.");

    const unsortedFixture = fixture();
    const earlierId = "aaa-geometry";
    const earlierPath = "apps/web/src/aaa.browser.tsx";
    writeFileSync(
      resolve(unsortedFixture.root, earlierPath),
      `it(${JSON.stringify(`${quarantineMarker(earlierId)} measures layout`)}, () => {});`,
    );
    const earlierEntry = unsortedFixture.source
      .split("\n")
      .slice(2)
      .map((line) =>
        line
          .replaceAll("web-geometry", earlierId)
          .replace("apps/web/src/example.browser.tsx", earlierPath),
      );
    const unsortedSource = [unsortedFixture.source, ...earlierEntry].join("\n");
    expect(
      validateQuarantineRegistry(unsortedSource, {
        repositoryRoot: unsortedFixture.root,
        today: "2026-07-20",
      }).errors,
    ).toContain("Quarantine entries must be sorted by id.");
  });

  it("rejects escaped, missing, directory, and marker-free source paths", () => {
    const escapedFixture = fixture();
    const escapedSource = escapedFixture.source.replace(
      "path: apps/web/src/example.browser.tsx",
      "path: ../outside.browser.tsx",
    );
    expect(
      validateQuarantineRegistry(escapedSource, {
        repositoryRoot: escapedFixture.root,
        today: "2026-07-20",
      }).errors,
    ).toContain("Quarantine entry `web-geometry` escapes the repository root.");

    const missingFixture = fixture();
    const missingPath = "apps/web/src/missing.browser.tsx";
    const missingSource = missingFixture.source.replace(
      "apps/web/src/example.browser.tsx",
      missingPath,
    );
    expect(
      validateQuarantineRegistry(missingSource, {
        repositoryRoot: missingFixture.root,
        today: "2026-07-20",
      }).errors,
    ).toContain(`Quarantine entry \`web-geometry\` path does not exist: ${missingPath}.`);

    const directoryFixture = fixture();
    const directoryPath = "apps/web/src";
    const directorySource = directoryFixture.source.replace(
      "apps/web/src/example.browser.tsx",
      directoryPath,
    );
    expect(
      validateQuarantineRegistry(directorySource, {
        repositoryRoot: directoryFixture.root,
        today: "2026-07-20",
      }).errors,
    ).toContain(`Quarantine entry \`web-geometry\` path is not a file: ${directoryPath}.`);

    const markerFixture = fixture();
    writeFileSync(
      resolve(markerFixture.root, "apps/web/src/example.browser.tsx"),
      "it('has no quarantine marker', () => {});",
    );
    expect(
      validateQuarantineRegistry(markerFixture.source, {
        repositoryRoot: markerFixture.root,
        today: "2026-07-20",
      }).errors,
    ).toContain(
      "Quarantine entry `web-geometry` marker is missing from apps/web/src/example.browser.tsx.",
    );
  });

  it("rejects registered files reached through a repository-escaping symlink", () => {
    const { root, source } = fixture();
    const outsideRoot = mkdtempSync(resolve(tmpdir(), "synara-quarantine-outside-"));
    roots.push(outsideRoot);
    writeFileSync(
      resolve(outsideRoot, "escaped.browser.tsx"),
      `it(${JSON.stringify(`${quarantineMarker("web-geometry")} escaped`)}, () => {});`,
    );
    const linkedDirectory = resolve(root, "apps/web/escaped");
    symlinkSync(outsideRoot, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    const linkedSource = source.replace(
      "apps/web/src/example.browser.tsx",
      "apps/web/escaped/escaped.browser.tsx",
    );

    expect(
      validateQuarantineRegistry(linkedSource, { repositoryRoot: root, today: "2026-07-20" })
        .errors,
    ).toContain("Quarantine entry `web-geometry` escapes the repository root.");
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
    expect(linuxStable.test("suite title\nwithout a quarantine marker")).toBe(true);
    expect(linuxStable.test(`suite title\n${quarantineMarker("web-geometry")}`)).toBe(false);
  });

  it("rejects conflicting repeated platform flags", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(__dirname, "../quarantine-registry.ts"),
        "validate",
        "--platform",
        "linux",
        "--platform",
        "windows",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Usage:");
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
