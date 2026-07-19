import { describe, expect, it } from "vitest";

import {
  alternatingVersionOrder,
  assertComparableEditorBenchmarkRuntime,
  evaluateBenchmarkGates,
  hashFixtureLabel,
  parseBenchmarkArgs,
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
        base: summary({
          subprocessCount: callers * 30,
          maxSubprocessesPerIteration: callers,
        }),
        candidate: summary({ subprocessCount: 30, maxSubprocessesPerIteration: 1 }),
      }),
    ),
  ];
  return scenarios;
}

describe("benchmark-windows-command-discovery", () => {
  it("requires immutable SHAs, 30 iterations, five warmups, and a bounded output path", () => {
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
  });
});
