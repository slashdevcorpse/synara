// FILE: benchmark-windows-process-snapshot.ts
// Purpose: Compares legacy per-terminal Windows CIM polling with one shared snapshot per cycle.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { runProcess } from "../src/processRunner";
import { inspectSubprocessActivity } from "../src/terminal/Layers/Manager";
import { captureWindowsProcessSnapshot } from "../src/terminal/windowsProcessSnapshot";

const ACTIVATION_BASE_SHA = "760f4f0679660e122477046f89d3a8b315e42f79";
const LEGACY_QUERY_TIMEOUT_MS = 1_500;
const LEGACY_QUERY_MAX_BUFFER_BYTES = 32_768;
const INTER_MEASUREMENT_SETTLE_MS = 500;

interface BenchmarkConfig {
  readonly terminalCounts: readonly number[];
  readonly warmupCycles: number;
  readonly measuredCycles: number;
  readonly format: "json";
}

interface QueryCounts {
  baseline: number;
  candidate: number;
}

interface TimingSummary {
  readonly rawMs: readonly number[];
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

interface TerminalCountResult {
  readonly terminals: number;
  readonly warmupCycles: number;
  readonly measuredCycles: number;
  readonly queryCounts: {
    readonly baselinePerCycle: number;
    readonly candidatePerCycle: number;
    readonly baselineMeasuredTotal: number;
    readonly candidateMeasuredTotal: number;
    readonly baselineWarmupTotal: number;
    readonly candidateWarmupTotal: number;
  };
  readonly baseline: TimingSummary;
  readonly candidate: TimingSummary;
  readonly acceptance: {
    readonly queryCountsPass: boolean;
    readonly candidateToBaselineP95Ratio: number;
    readonly p95WithinBudget: boolean;
  };
}

type TestRoot = ReturnType<typeof Bun.spawn>;

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(args: readonly string[]): BenchmarkConfig {
  let terminalCounts: readonly number[] = [1, 8, 32];
  let warmupCycles = 5;
  let measuredCycles = 50;
  let format: "json" = "json";

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--terminals") {
      terminalCounts = (value ?? "")
        .split(",")
        .map((entry) => positiveInteger(entry.trim(), option));
      if (terminalCounts.length === 0 || new Set(terminalCounts).size !== terminalCounts.length) {
        throw new Error("--terminals must contain unique positive integers");
      }
      index += 1;
      continue;
    }
    if (option === "--warmup") {
      warmupCycles = positiveInteger(value, option);
      index += 1;
      continue;
    }
    if (option === "--cycles") {
      measuredCycles = positiveInteger(value, option);
      index += 1;
      continue;
    }
    if (option === "--format") {
      if (value !== "json") throw new Error("--format must be json");
      format = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown benchmark option: ${option ?? "<missing>"}`);
  }

  return { terminalCounts, warmupCycles, measuredCycles, format };
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

function summarizeTimings(rawTimings: readonly number[]): TimingSummary {
  const sorted = [...rawTimings].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    rawMs: rawTimings.map(roundMilliseconds),
    medianMs: roundMilliseconds(median),
    p95Ms: roundMilliseconds(sorted[p95Index] ?? 0),
    maximumMs: roundMilliseconds(sorted.at(-1) ?? 0),
  };
}

async function measure(operation: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

async function runLegacyTerminalQuery(terminalPid: number): Promise<void> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      timeoutMs: LEGACY_QUERY_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: LEGACY_QUERY_MAX_BUFFER_BYTES,
      outputMode: "truncate",
    },
  );
}

async function runBaselineCycle(
  terminalPids: readonly number[],
  queryCounts: QueryCounts,
): Promise<void> {
  await Promise.all(
    terminalPids.map(async (terminalPid) => {
      queryCounts.baseline += 1;
      await runLegacyTerminalQuery(terminalPid);
    }),
  );
}

async function runCandidateCycle(
  terminalPids: readonly number[],
  queryCounts: QueryCounts,
): Promise<void> {
  queryCounts.candidate += 1;
  const snapshot = await captureWindowsProcessSnapshot();
  if (snapshot.kind === "unknown") {
    throw new Error(`Candidate snapshot was unknown: ${snapshot.reason}`);
  }
  for (const terminalPid of terminalPids) {
    inspectSubprocessActivity(terminalPid, snapshot.childrenByParentPid);
  }
}

async function runInterleavedPair(
  pairIndex: number,
  terminalPids: readonly number[],
  queryCounts: QueryCounts,
): Promise<{ readonly baselineMs: number; readonly candidateMs: number }> {
  let baselineMs = 0;
  let candidateMs = 0;
  const baseline = async () => {
    baselineMs = await measure(() => runBaselineCycle(terminalPids, queryCounts));
  };
  const candidate = async () => {
    candidateMs = await measure(() => runCandidateCycle(terminalPids, queryCounts));
  };

  if (pairIndex % 2 === 0) {
    await baseline();
    await Bun.sleep(INTER_MEASUREMENT_SETTLE_MS);
    await candidate();
  } else {
    await candidate();
    await Bun.sleep(INTER_MEASUREMENT_SETTLE_MS);
    await baseline();
  }
  await Bun.sleep(INTER_MEASUREMENT_SETTLE_MS);
  return { baselineMs, candidateMs };
}

function spawnTestRoots(count: number): TestRoot[] {
  return Array.from({ length: count }, () =>
    Bun.spawn({
      cmd: [process.execPath, "-e", "setInterval(() => {}, 60_000)"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
}

async function stopTestRoots(roots: readonly TestRoot[]): Promise<void> {
  for (const root of roots) {
    if (root.exitCode === null) root.kill();
  }
  await Promise.allSettled(roots.map((root) => root.exited));
}

async function benchmarkTerminalCount(
  terminals: number,
  config: BenchmarkConfig,
): Promise<TerminalCountResult> {
  const roots = spawnTestRoots(terminals);
  try {
    await Bun.sleep(250);
    if (roots.some((root) => root.exitCode !== null)) {
      throw new Error("A benchmark-owned process root exited before measurement");
    }
    const terminalPids = roots.map((root) => root.pid);
    const warmupQueryCounts: QueryCounts = { baseline: 0, candidate: 0 };
    const measuredQueryCounts: QueryCounts = { baseline: 0, candidate: 0 };

    for (let cycle = 0; cycle < config.warmupCycles; cycle += 1) {
      await runInterleavedPair(cycle, terminalPids, warmupQueryCounts);
    }

    const baselineTimings: number[] = [];
    const candidateTimings: number[] = [];
    for (let cycle = 0; cycle < config.measuredCycles; cycle += 1) {
      const result = await runInterleavedPair(
        config.warmupCycles + cycle,
        terminalPids,
        measuredQueryCounts,
      );
      baselineTimings.push(result.baselineMs);
      candidateTimings.push(result.candidateMs);
    }

    const expectedBaselineQueries = terminals * config.measuredCycles;
    const expectedCandidateQueries = config.measuredCycles;
    const baseline = summarizeTimings(baselineTimings);
    const candidate = summarizeTimings(candidateTimings);
    const ratio = candidate.p95Ms / baseline.p95Ms;
    return {
      terminals,
      warmupCycles: config.warmupCycles,
      measuredCycles: config.measuredCycles,
      queryCounts: {
        baselinePerCycle: measuredQueryCounts.baseline / config.measuredCycles,
        candidatePerCycle: measuredQueryCounts.candidate / config.measuredCycles,
        baselineMeasuredTotal: measuredQueryCounts.baseline,
        candidateMeasuredTotal: measuredQueryCounts.candidate,
        baselineWarmupTotal: warmupQueryCounts.baseline,
        candidateWarmupTotal: warmupQueryCounts.candidate,
      },
      baseline,
      candidate,
      acceptance: {
        queryCountsPass:
          measuredQueryCounts.baseline === expectedBaselineQueries &&
          measuredQueryCounts.candidate === expectedCandidateQueries,
        candidateToBaselineP95Ratio: Number(ratio.toFixed(4)),
        p95WithinBudget: terminals === 1 ? ratio <= 1.25 : candidate.p95Ms < baseline.p95Ms,
      },
    };
  } finally {
    await stopTestRoots(roots);
  }
}

async function gitOutput(args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, {
    timeoutMs: 5_000,
    maxBufferBytes: 262_144,
    outputMode: "truncate",
  });
  return result.stdout.trim();
}

async function powershellVersion(): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error("SystemRoot is required for the native Windows benchmark");
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = await runProcess(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    {
      timeoutMs: 5_000,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    },
  );
  return result.stdout.trim();
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("This benchmark must run natively on Windows");
  }
  const config = parseArguments(process.argv.slice(2));
  const scriptPath = fileURLToPath(import.meta.url);
  const headSha = await gitOutput(["rev-parse", "HEAD"]);
  const activationBase = await gitOutput(["merge-base", ACTIVATION_BASE_SHA, headSha]);
  if (activationBase !== ACTIVATION_BASE_SHA) {
    throw new Error("HEAD does not descend from the approved activation base");
  }
  const workingTreeStatus = await gitOutput(["status", "--short"]);
  if (workingTreeStatus.length > 0) {
    throw new Error("The benchmark requires an immutable clean worktree");
  }

  const results: TerminalCountResult[] = [];
  for (const terminals of config.terminalCounts) {
    results.push(await benchmarkTerminalCount(terminals, config));
  }

  const oneTerminal = results.find((result) => result.terminals === 1);
  const eightTerminals = results.find((result) => result.terminals === 8);
  const thirtyTwoTerminals = results.find((result) => result.terminals === 32);
  const queryCountsPass = results.every((result) => result.acceptance.queryCountsPass);
  const oneTerminalP95Pass = oneTerminal?.acceptance.p95WithinBudget === true;
  const eightTerminalP95Improved = eightTerminals?.acceptance.p95WithinBudget === true;
  const thirtyTwoTerminalP95Improved = thirtyTwoTerminals?.acceptance.p95WithinBudget === true;
  const passed =
    queryCountsPass &&
    oneTerminalP95Pass &&
    eightTerminalP95Improved &&
    thirtyTwoTerminalP95Improved;

  const output = {
    schemaVersion: 1,
    protocol: {
      baseline:
        "Frozen Manager legacy control: one filtered Get-CimInstance Win32_Process query per terminal",
      candidate: "One complete whole-system Windows process snapshot before terminal fan-out",
      ordering: "Deterministically alternating baseline-first and candidate-first pairs",
      interMeasurementSettleMs: INTER_MEASUREMENT_SETTLE_MS,
      processRoots: "Benchmark-owned Bun processes, created outside timing and always settled",
      warmupCycles: config.warmupCycles,
      measuredCycles: config.measuredCycles,
      terminalCounts: config.terminalCounts,
    },
    environment: {
      recordedAt: new Date().toISOString(),
      bunVersion: Bun.version,
      powershellVersion: await powershellVersion(),
      windowsVersion: os.version(),
      windowsRelease: os.release(),
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
    },
    source: {
      baseSha: ACTIVATION_BASE_SHA,
      headSha,
      workingTreeClean: true,
      benchmarkScriptSha256: createHash("sha256").update(fs.readFileSync(scriptPath)).digest("hex"),
    },
    results,
    acceptance: {
      queryCountsPass,
      oneTerminalP95Pass,
      eightTerminalP95Improved,
      thirtyTwoTerminalP95Improved,
      passed,
    },
  };

  if (config.format === "json") console.log(JSON.stringify(output, null, 2));
  if (!passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
