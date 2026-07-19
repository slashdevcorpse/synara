import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  alternatingVersionOrder,
  assertComparableEditorBenchmarkRuntime,
  assertCandidateCheckoutIdentity,
  assertMatchingLockfileProvenance,
  assertMatchingPackageManagerProvenance,
  assertRevisionLocalResolutions,
  assertSafeBenchmarkOutputPath,
  assertSingleEditorFixtureSubprocessCount,
  benchmarkDependencyLinks,
  createFixture,
  editorFixtureEnvironment,
  evaluateBenchmarkGates,
  formatBenchmarkFailure,
  hashFixtureLabel,
  parseBenchmarkArgs,
  preflightEditorFixture,
  readAppxSubprocessCount,
  resetAppxSubprocessMarkers,
  runCleanupSteps,
  summarizeSamples,
  type BenchmarkSummary,
  type ScenarioComparison,
} from "./benchmark-windows-command-discovery.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function summary(overrides: Partial<BenchmarkSummary> = {}): BenchmarkSummary {
  return {
    samples: 30,
    subprocessCount: 0,
    maxSubprocessesPerIteration: 0,
    statusCategories: { resolved: 30 },
    medianMs: 1,
    p95Ms: 1,
    maxMs: 1,
    ...overrides,
  };
}

function passingScenarios(): ScenarioComparison[] {
  const scenarios: ScenarioComparison[] = [
    {
      name: "cold_exe",
      base: summary({ medianMs: 10, p95Ms: 10, subprocessCount: 30 }),
      candidate: summary({ medianMs: 11, p95Ms: 12, subprocessCount: 30 }),
    },
    ...["warm_8_identical_command_callers", "warm_32_identical_command_callers"].map(
      (name): ScenarioComparison => ({
        name,
        base: summary({ medianMs: 10, p95Ms: 12, subprocessCount: 240 }),
        candidate: summary({ medianMs: 2, p95Ms: 5, subprocessCount: 0 }),
      }),
    ),
    ...["changed_path", "changed_pathext", "changed_cwd"].map(
      (name): ScenarioComparison => ({
        name,
        base: summary({ subprocessCount: 30, maxSubprocessesPerIteration: 1 }),
        candidate: summary({ subprocessCount: 30, maxSubprocessesPerIteration: 1 }),
      }),
    ),
    {
      name: "authoritative_negative",
      base: summary({ subprocessCount: 30, maxSubprocessesPerIteration: 1 }),
      candidate: summary({ statusCategories: { not_found: 30 } }),
    },
    {
      name: "transient_failure",
      base: summary({ subprocessCount: 60, maxSubprocessesPerIteration: 2 }),
      candidate: summary({ subprocessCount: 60, maxSubprocessesPerIteration: 2 }),
    },
    ...[1, 8, 32].map(
      (callers): ScenarioComparison => ({
        name: `editor_${callers}_callers`,
        base: summary({ subprocessCount: 30, maxSubprocessesPerIteration: 1 }),
        candidate: summary({ subprocessCount: 30, maxSubprocessesPerIteration: 1 }),
      }),
    ),
  ];
  return scenarios;
}

describe("benchmark-windows-command-discovery", () => {
  it("requires immutable SHAs, 30 iterations, and five warmups", () => {
    const parsed = parseBenchmarkArgs(
      [
        "--repo",
        ".",
        "--base-sha",
        SHA_A,
        "--candidate-sha",
        SHA_B,
        "--pr397-sha",
        SHA_C,
        "--iterations",
        "30",
        "--warmups",
        "5",
        "--output",
        "artifacts/discovery.json",
      ],
      "C:\\repo",
    );

    expect(parsed).toMatchObject({
      baseSha: SHA_A,
      candidateSha: SHA_B,
      parentSha: SHA_C,
      iterations: 30,
      warmups: 5,
    });
    expect(parsed.output.endsWith("discovery.json")).toBe(true);
    expect(() =>
      parseBenchmarkArgs(
        [
          "--base-sha",
          "short",
          "--candidate-sha",
          SHA_B,
          "--iterations",
          "30",
          "--output",
          "result.json",
        ],
        "C:\\repo",
      ),
    ).toThrow("full 40-character SHA");
    expect(() =>
      parseBenchmarkArgs(
        [
          "--base-sha",
          SHA_A,
          "--candidate-sha",
          SHA_B,
          "--iterations",
          "29",
          "--output",
          "result.json",
        ],
        "C:\\repo",
      ),
    ).toThrow("at least 30");
    expect(() =>
      parseBenchmarkArgs(
        [
          "--base-sha",
          SHA_A,
          "--candidate-sha",
          SHA_A,
          "--iterations",
          "30",
          "--output",
          "result.json",
        ],
        "C:\\repo",
      ),
    ).toThrow("must be different");
  });

  it("requires the invoking tracked checkout to match the candidate revision", () => {
    expect(() =>
      assertCandidateCheckoutIdentity({
        headSha: SHA_B,
        candidateSha: SHA_B,
        trackedStatus: "",
      }),
    ).not.toThrow();
    expect(() =>
      assertCandidateCheckoutIdentity({
        headSha: SHA_A,
        candidateSha: SHA_B,
        trackedStatus: "",
      }),
    ).toThrow("does not match candidate");
    expect(() =>
      assertCandidateCheckoutIdentity({
        headSha: SHA_B,
        candidateSha: SHA_B,
        trackedStatus: " M scripts/benchmark-windows-command-discovery.ts",
      }),
    ).toThrow("tracked changes");
  });

  it("provisions shallow no-network links and rejects dependency leakage", () => {
    const worktree = "C:\\benchmark\\candidate";
    const externalEffect = "C:\\locked-dependencies\\effect";
    expect(benchmarkDependencyLinks(worktree, externalEffect)).toEqual(
      expect.arrayContaining([
        {
          link: join(worktree, "apps", "server", "node_modules", "@synara", "contracts"),
          target: join(worktree, "packages", "contracts"),
        },
        {
          link: join(worktree, "apps", "server", "node_modules", "effect"),
          target: externalEffect,
        },
      ]),
    );
    expect(() =>
      assertRevisionLocalResolutions(
        worktree,
        {
          contracts: join(worktree, "packages", "contracts", "src", "index.ts"),
          sharedWindowsProcess: join(worktree, "packages", "shared", "src", "windowsProcess.ts"),
          effectFromServer: join(externalEffect, "dist", "effect.js"),
          effectFromContracts: join(externalEffect, "dist", "effect.js"),
        },
        externalEffect,
      ),
    ).not.toThrow();
    expect(() =>
      assertRevisionLocalResolutions(
        worktree,
        {
          contracts: "C:\\mutable-source\\packages\\contracts\\src\\index.ts",
          sharedWindowsProcess: join(worktree, "packages", "shared", "src", "windowsProcess.ts"),
          effectFromServer: join(externalEffect, "dist", "effect.js"),
          effectFromContracts: join(externalEffect, "dist", "effect.js"),
        },
        externalEffect,
      ),
    ).toThrow("resolved outside detached revision");
    expect(() =>
      assertRevisionLocalResolutions(
        worktree,
        {
          contracts: join(worktree, "packages", "contracts", "src", "index.ts"),
          sharedWindowsProcess: join(worktree, "packages", "shared", "src", "windowsProcess.ts"),
          effectFromServer: "C:\\ancestor-node-modules\\effect\\dist\\effect.js",
          effectFromContracts: join(externalEffect, "dist", "effect.js"),
        },
        externalEffect,
      ),
    ).toThrow("locked external Effect package");
  });

  it("rejects immutable revisions with different committed lockfiles", () => {
    expect(() => assertMatchingLockfileProvenance("same", "same")).not.toThrow();
    expect(() => assertMatchingLockfileProvenance("base", "candidate")).toThrow(
      "different committed bun.lock digests",
    );
    expect(() => assertMatchingPackageManagerProvenance("bun@1.3.12", "bun@1.3.12")).not.toThrow();
    expect(() => assertMatchingPackageManagerProvenance("bun@1.3.12", "bun@1.3.14")).toThrow(
      "different packageManager declarations",
    );
  });

  it("accepts only an empty controlled receipt directory directly under OS temp", () => {
    const suffix = randomUUID().replaceAll("-", "");
    const controlled = join(tmpdir(), `synara-goal09-benchmark-${suffix}`);
    const uncontrolled = join(tmpdir(), `goal09-benchmark-${suffix}`);
    mkdirSync(controlled);
    mkdirSync(uncontrolled);
    try {
      const output = join(controlled, "receipt.json");
      expect(() => assertSafeBenchmarkOutputPath(output)).not.toThrow();
      const longTempAlias = process.env.USERPROFILE
        ? join(process.env.USERPROFILE, "AppData", "Local", "Temp")
        : null;
      if (process.platform === "win32" && longTempAlias && existsSync(longTempAlias)) {
        const shortIdentity = statSync(tmpdir(), { bigint: true });
        const longIdentity = statSync(longTempAlias, { bigint: true });
        if (shortIdentity.dev === longIdentity.dev && shortIdentity.ino === longIdentity.ino) {
          expect(() =>
            assertSafeBenchmarkOutputPath(
              join(longTempAlias, `synara-goal09-benchmark-${suffix}`, "receipt.json"),
            ),
          ).not.toThrow();
        }
      }
      expect(() => assertSafeBenchmarkOutputPath(join(controlled, "other.json"))).toThrow(
        "filename must be receipt.json",
      );
      expect(() => assertSafeBenchmarkOutputPath(join(uncontrolled, "receipt.json"))).toThrow(
        "outside the controlled temp boundary",
      );
      writeFileSync(join(controlled, "unexpected.txt"), "unexpected\n");
      expect(() => assertSafeBenchmarkOutputPath(output)).toThrow("must be empty");
    } finally {
      rmSync(controlled, { recursive: true, force: true });
      rmSync(uncontrolled, { recursive: true, force: true });
    }
  });

  it("attempts every cleanup step and reports each failure", () => {
    const calls: string[] = [];
    const errors = runCleanupSteps([
      () => {
        calls.push("candidate");
        throw new Error("candidate cleanup failed");
      },
      () => {
        calls.push("base");
      },
      () => {
        calls.push("root");
        throw new Error("root cleanup failed");
      },
    ]);
    expect(calls).toEqual(["candidate", "base", "root"]);
    expect(errors.map((error) => error.message)).toEqual([
      "candidate cleanup failed",
      "root cleanup failed",
    ]);
    const formatted = formatBenchmarkFailure(
      new AggregateError([new Error("primary failure"), ...errors], "benchmark and cleanup failed"),
    );
    expect(formatted).toContain("primary failure");
    expect(formatted).toContain("candidate cleanup failed");
    expect(formatted).toContain("root cleanup failed");
  });

  it("rejects editor measurements that cannot invoke both immutable implementations", () => {
    expect(() =>
      assertComparableEditorBenchmarkRuntime({
        baseResolveAvailableEditors: false,
        candidateDiscoverAvailableEditors: true,
        candidateEditorAvailability: true,
      }),
    ).toThrow("base open.ts");
    expect(() =>
      assertComparableEditorBenchmarkRuntime({
        baseResolveAvailableEditors: true,
        candidateDiscoverAvailableEditors: false,
        candidateEditorAvailability: true,
      }),
    ).toThrow("candidate editor discovery/service");
    expect(() =>
      assertComparableEditorBenchmarkRuntime({
        baseResolveAvailableEditors: true,
        candidateDiscoverAvailableEditors: true,
        candidateEditorAvailability: true,
      }),
    ).not.toThrow();
  });

  it("requires exactly one AppX subprocess for every editor sample", () => {
    expect(() => assertSingleEditorFixtureSubprocessCount(0, "base editor sample")).toThrow(
      "used 0 AppX subprocesses",
    );
    expect(() =>
      assertSingleEditorFixtureSubprocessCount(1, "candidate editor sample"),
    ).not.toThrow();
    expect(() => assertSingleEditorFixtureSubprocessCount(2, "candidate editor sample")).toThrow(
      "used 2 AppX subprocesses",
    );
  });

  it.runIf(process.platform === "win32")(
    "preflights the isolated Appx module without exposing PowerShell as a terminal",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "synara-editor-fixture-test-"));
      try {
        const fixture = createFixture(root);
        expect(preflightEditorFixture(fixture)).toMatchObject({
          commandType: "Function",
          moduleName: "Appx",
          packageFamilyName: "Microsoft.VisualStudioCode_8wekyb3d8bbwe",
          markerCount: 1,
          transportCommandHidden: true,
        });
        const open = (await import(
          new URL("../apps/server/src/open.ts", import.meta.url).href
        )) as {
          readonly resolveAvailableEditors: (
            platform: NodeJS.Platform,
            env: NodeJS.ProcessEnv,
          ) => ReadonlyArray<string>;
          readonly discoverAvailableEditors: (options: {
            readonly platform: NodeJS.Platform;
            readonly env: NodeJS.ProcessEnv;
            readonly cwd: string;
            readonly signal: AbortSignal;
          }) => Promise<{
            readonly status: string;
            readonly availableEditors?: ReadonlyArray<string>;
          }>;
        };
        const discovery = (await import(
          new URL("../apps/server/src/editorAppDiscovery.ts", import.meta.url).href
        )) as {
          readonly clearWindowsStorePackageDiscoveryCache: () => void;
        };
        const env = editorFixtureEnvironment(fixture);

        discovery.clearWindowsStorePackageDiscoveryCache();
        expect(open.resolveAvailableEditors("win32", env)).toEqual(["vscode"]);
        expect(readAppxSubprocessCount(fixture)).toBe(1);

        resetAppxSubprocessMarkers(fixture);
        discovery.clearWindowsStorePackageDiscoveryCache();
        const candidate = await open.discoverAvailableEditors({
          platform: "win32",
          env,
          cwd: fixture.cwdA,
          signal: new AbortController().signal,
        });
        expect(candidate).toMatchObject({ status: "success", availableEditors: ["vscode"] });
        expect(readAppxSubprocessCount(fixture)).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("summarizes recorded samples without including warmups", () => {
    expect(
      summarizeSamples([
        { elapsedMs: 4, subprocessCount: 1, statusCategory: "resolved" },
        { elapsedMs: 1, subprocessCount: 0, statusCategory: "resolved" },
        { elapsedMs: 3, subprocessCount: 2, statusCategory: "transient_failure" },
        { elapsedMs: 2, subprocessCount: 0, statusCategory: "resolved" },
      ]),
    ).toEqual({
      samples: 4,
      subprocessCount: 3,
      maxSubprocessesPerIteration: 2,
      statusCategories: { resolved: 3, transient_failure: 1 },
      medianMs: 2,
      p95Ms: 4,
      maxMs: 4,
    });
  });

  it("alternates base/candidate order and hashes fixture labels instead of exposing paths", () => {
    expect(alternatingVersionOrder(0)).toEqual(["base", "candidate"]);
    expect(alternatingVersionOrder(1)).toEqual(["candidate", "base"]);
    const sensitivePath = "C:\\Users\\private\\fixture";
    const label = hashFixtureLabel(sensitivePath);
    expect(label).toMatch(/^[0-9a-f]{64}$/);
    expect(label).not.toContain("Users");
  });

  it("enforces latency, subprocess, invalidation, LRU, readiness, and Node-oracle gates", () => {
    const passing = evaluateBenchmarkGates(passingScenarios(), {
      lruPassed: true,
      initialEditorSnapshotNonBlocking: true,
      nodeEnvironmentOraclePassed: true,
    });
    expect(passing.every((gate) => gate.passed)).toBe(true);

    const failingScenarios = passingScenarios().map((scenario) =>
      scenario.name === "warm_8_identical_command_callers"
        ? {
            ...scenario,
            candidate: summary({ medianMs: 9, p95Ms: 11, subprocessCount: 30 }),
          }
        : scenario,
    );
    const failing = evaluateBenchmarkGates(failingScenarios, {
      lruPassed: false,
      initialEditorSnapshotNonBlocking: false,
      nodeEnvironmentOraclePassed: false,
    });
    expect(failing.filter((gate) => !gate.passed).map((gate) => gate.name)).toEqual(
      expect.arrayContaining([
        "warm_8_latency",
        "warm_zero_additional_where",
        "lru_256",
        "initial_editor_snapshot_nonblocking",
        "node_duplicate_environment_oracle",
      ]),
    );

    for (const invalidSide of ["base", "candidate"] as const) {
      const invalidSummary = summary({
        subprocessCount: invalidSide === "base" ? 0 : 60,
        maxSubprocessesPerIteration: invalidSide === "base" ? 0 : 2,
      });
      const invalidEditorScenarios = passingScenarios().map((scenario) =>
        scenario.name === "editor_8_callers"
          ? {
              name: scenario.name,
              base: invalidSide === "base" ? invalidSummary : scenario.base,
              candidate: invalidSide === "candidate" ? invalidSummary : scenario.candidate,
            }
          : scenario,
      );
      const editorGate = evaluateBenchmarkGates(invalidEditorScenarios, {
        lruPassed: true,
        initialEditorSnapshotNonBlocking: true,
        nodeEnvironmentOraclePassed: true,
      }).find((gate) => gate.name === "editor_single_flight");
      expect(editorGate?.passed).toBe(false);
    }
  });
});
