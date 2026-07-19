// FILE: benchmark-windows-command-discovery.ts
// Purpose: Compare immutable Windows discovery implementations under one reproducible fixture.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, tmpdir, version } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import pathWin32 from "node:path/win32";
import { pathToFileURL } from "node:url";

import { Effect } from "effect";

const PR397_HEAD_SHA = "7c39415c16415224253c376c8e85df74489596b8";
const DEFAULT_WARMUPS = 5;
const MIN_ITERATIONS = 30;
const FIXTURE_ID = "windows-command-discovery-v2";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RECEIPT_DIRECTORY_PATTERN = /^synara-goal09-benchmark-[0-9a-f]{32}$/i;
const RECEIPT_FILENAME = "receipt.json";
const SIMULATED_WHERE_DELAY_MS = 2;

export interface BenchmarkCliOptions {
  readonly repo: string;
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly parentSha: string;
  readonly iterations: number;
  readonly warmups: number;
  readonly output: string;
}

interface RuntimeModule {
  readonly resolveWindowsCommandCandidates: (
    command: string,
    input?: Record<string, unknown>,
  ) => string[];
  readonly createWindowsCommandDiscoveryCache?: (options?: {
    readonly now?: () => number;
  }) => unknown;
  readonly getWindowsCommandDiscoveryCacheStats?: (cache?: unknown) => { readonly size: number };
}

interface EditorAvailabilityRuntimeModule {
  readonly makeEditorAvailability: (options: {
    readonly discover: (
      signal: AbortSignal,
      identity: string,
    ) => Promise<EditorDiscoveryRuntimeResult>;
    readonly identity: () => string;
  }) => Effect.Effect<EditorAvailabilityFixtureService, never, never>;
}

interface OpenRuntimeModule {
  readonly resolveAvailableEditors: (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
  ) => ReadonlyArray<string>;
  readonly discoverAvailableEditors?: (options: {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly signal: AbortSignal;
  }) => Promise<EditorDiscoveryRuntimeResult>;
}

interface EditorAppDiscoveryRuntimeModule {
  readonly clearWindowsStorePackageDiscoveryCache: () => void;
}

interface EditorAvailabilityFixtureService {
  readonly getSnapshotAndSchedule: Effect.Effect<EditorAvailabilityFixtureSnapshot>;
  readonly refresh: Effect.Effect<EditorAvailabilityFixtureSnapshot>;
}

interface EditorAvailabilityFixtureSnapshot {
  readonly availableEditors: ReadonlyArray<string>;
}

type EditorDiscoveryRuntimeResult =
  | {
      readonly status: "success";
      readonly availableEditors: ReadonlyArray<string>;
      readonly fileSystemOperations: number;
      readonly subprocessCount: number;
    }
  | {
      readonly status: "failure";
      readonly category: string;
      readonly fileSystemOperations: number;
      readonly subprocessCount: number;
    };

export interface BenchmarkSample {
  readonly elapsedMs: number;
  readonly subprocessCount: number;
  readonly statusCategory: string;
}

export interface BenchmarkSummary {
  readonly samples: number;
  readonly subprocessCount: number;
  readonly maxSubprocessesPerIteration: number;
  readonly statusCategories: Readonly<Record<string, number>>;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface ScenarioComparison {
  readonly name: string;
  readonly base: BenchmarkSummary;
  readonly candidate: BenchmarkSummary;
}

export interface BenchmarkGate {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface ScenarioContext {
  readonly run: () => Promise<BenchmarkSample>;
}

interface VersionRuntime {
  readonly label: "base" | "candidate";
  readonly sha: string;
  readonly worktree: string;
  readonly command: RuntimeModule;
  readonly open: OpenRuntimeModule;
  readonly editorAppDiscovery: EditorAppDiscoveryRuntimeModule;
  readonly editorAvailability: EditorAvailabilityRuntimeModule | null;
}

export interface BenchmarkFixture {
  readonly root: string;
  readonly cwdA: string;
  readonly cwdB: string;
  readonly binA: string;
  readonly binB: string;
  readonly exeCandidate: string;
  readonly cmdCandidate: string;
  readonly systemRoot: string;
  readonly powerShellBin: string;
  readonly powerShellExecutable: string;
  readonly powerShellExecutableSha256: string;
  readonly appxModuleRoot: string;
  readonly appxModulePath: string;
  readonly appxMarkerDirectory: string;
  readonly appxInstallLocation: string;
  readonly treeSha256: string;
}

export interface EditorFixturePreflight {
  readonly commandType: "Function";
  readonly moduleName: "Appx";
  readonly modulePathSha256: string;
  readonly powerShellVersion: string;
  readonly powerShellExecutableSha256: string;
  readonly packageFamilyName: "Microsoft.VisualStudioCode_8wekyb3d8bbwe";
  readonly installLocationSha256: string;
  readonly markerCount: 1;
  readonly transportCommandHidden: true;
}

interface NodeDuplicateEnvironmentOracle {
  readonly launcherRuntime: { readonly name: "bun"; readonly version: string };
  readonly oracleRuntime: { readonly name: "node"; readonly version: string };
  readonly effectiveKey: string | null;
  readonly effectiveValueSha256: string | null;
  readonly expectedKey: "PATH";
  readonly expectedValueSha256: string;
  readonly passed: boolean;
}

interface DependencyProvenance {
  readonly bunLockSha256: string;
  readonly provisioning: {
    readonly mode: "revision-local-workspace-junctions";
    readonly network: "disabled";
    readonly lifecycleScripts: "not-run";
    readonly externalEffectPackageJsonSha256: string;
    readonly externalEffectVersion: string;
  };
  readonly revisionLocalResolutions: {
    readonly contracts: string;
    readonly sharedWindowsProcess: string;
  };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

export function parseBenchmarkArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
): BenchmarkCliOptions {
  let repo = cwd;
  let baseSha: string | undefined;
  let candidateSha: string | undefined;
  let parentSha = PR397_HEAD_SHA;
  let iterations = MIN_ITERATIONS;
  let warmups = DEFAULT_WARMUPS;
  let output: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case "--repo":
        repo = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--base-sha":
        baseSha = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--candidate-sha":
        candidateSha = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--pr397-sha":
        parentSha = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--iterations":
        iterations = parseInteger(requiredValue(args, index, flag), flag);
        index += 1;
        break;
      case "--warmups":
        warmups = parseInteger(requiredValue(args, index, flag), flag);
        index += 1;
        break;
      case "--output":
        output = requiredValue(args, index, flag);
        index += 1;
        break;
      default:
        throw new Error(`Unknown benchmark argument: ${flag ?? "<missing>"}`);
    }
  }

  if (!baseSha) throw new Error("--base-sha is required.");
  if (!candidateSha) throw new Error("--candidate-sha is required.");
  if (!output) throw new Error("--output is required.");
  if (iterations < MIN_ITERATIONS) {
    throw new Error(`--iterations must be at least ${MIN_ITERATIONS}.`);
  }
  if (warmups < DEFAULT_WARMUPS) {
    throw new Error(`--warmups must be at least ${DEFAULT_WARMUPS}.`);
  }
  for (const [label, sha] of [
    ["base", baseSha],
    ["candidate", candidateSha],
    ["#397 parent", parentSha],
  ] as const) {
    if (!SHA_PATTERN.test(sha)) throw new Error(`${label} SHA must be a full 40-character SHA.`);
  }
  if (baseSha.toLowerCase() === candidateSha.toLowerCase()) {
    throw new Error("Base and candidate SHAs must be different immutable revisions.");
  }

  return {
    repo: resolve(repo),
    baseSha: baseSha.toLowerCase(),
    candidateSha: candidateSha.toLowerCase(),
    parentSha: parentSha.toLowerCase(),
    iterations,
    warmups,
    output: isAbsolute(output) ? output : resolve(cwd, output),
  };
}

export function hashFixtureLabel(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizeSamples(samples: readonly BenchmarkSample[]): BenchmarkSummary {
  const elapsed = samples.map((sample) => sample.elapsedMs).toSorted((left, right) => left - right);
  const statuses: Record<string, number> = {};
  for (const sample of samples) {
    statuses[sample.statusCategory] = (statuses[sample.statusCategory] ?? 0) + 1;
  }
  return {
    samples: samples.length,
    subprocessCount: samples.reduce((total, sample) => total + sample.subprocessCount, 0),
    maxSubprocessesPerIteration: Math.max(0, ...samples.map((sample) => sample.subprocessCount)),
    statusCategories: statuses,
    medianMs: roundMetric(percentile(elapsed, 0.5)),
    p95Ms: roundMetric(percentile(elapsed, 0.95)),
    maxMs: roundMetric(elapsed.at(-1) ?? 0),
  };
}

export function alternatingVersionOrder(
  index: number,
): readonly ["base", "candidate"] | readonly ["candidate", "base"] {
  return index % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
}

export function assertComparableEditorBenchmarkRuntime(input: {
  readonly baseResolveAvailableEditors: boolean;
  readonly candidateDiscoverAvailableEditors: boolean;
  readonly candidateEditorAvailability: boolean;
}): void {
  if (!input.baseResolveAvailableEditors) {
    throw new Error("Immutable base open.ts editor discovery path is unavailable.");
  }
  if (!input.candidateDiscoverAvailableEditors || !input.candidateEditorAvailability) {
    throw new Error("Immutable candidate editor discovery/service path is unavailable.");
  }
}

function scenarioByName(
  scenarios: readonly ScenarioComparison[],
  name: string,
): ScenarioComparison {
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`Missing benchmark scenario: ${name}`);
  return scenario;
}

export function evaluateBenchmarkGates(
  scenarios: readonly ScenarioComparison[],
  structural: {
    readonly lruPassed: boolean;
    readonly initialEditorSnapshotNonBlocking: boolean;
    readonly nodeEnvironmentOraclePassed: boolean;
  },
): readonly BenchmarkGate[] {
  const cold = scenarioByName(scenarios, "cold_exe");
  const warm8 = scenarioByName(scenarios, "warm_8_identical_command_callers");
  const warm32 = scenarioByName(scenarios, "warm_32_identical_command_callers");
  const authoritativeNegative = scenarioByName(scenarios, "authoritative_negative");
  const transient = scenarioByName(scenarios, "transient_failure");
  const changedScenarios = ["changed_path", "changed_pathext", "changed_cwd"].map((name) =>
    scenarioByName(scenarios, name),
  );
  const editorScenarios = [1, 8, 32].map((callers) =>
    scenarioByName(scenarios, `editor_${callers}_callers`),
  );
  const timingGate = (scenario: ScenarioComparison) =>
    scenario.candidate.medianMs <= scenario.base.medianMs * 0.25 &&
    scenario.candidate.p95Ms <= scenario.base.p95Ms * 0.5;

  return [
    {
      name: "warm_8_latency",
      passed: timingGate(warm8),
      detail: `candidate median/p95 ${warm8.candidate.medianMs}/${warm8.candidate.p95Ms} ms; base ${warm8.base.medianMs}/${warm8.base.p95Ms} ms`,
    },
    {
      name: "warm_32_latency",
      passed: timingGate(warm32),
      detail: `candidate median/p95 ${warm32.candidate.medianMs}/${warm32.candidate.p95Ms} ms; base ${warm32.base.medianMs}/${warm32.base.p95Ms} ms`,
    },
    {
      name: "cold_p95_regression",
      passed: cold.candidate.p95Ms <= cold.base.p95Ms + Math.max(cold.base.p95Ms * 0.2, 10),
      detail: `candidate ${cold.candidate.p95Ms} ms; base ${cold.base.p95Ms} ms`,
    },
    {
      name: "warm_zero_additional_where",
      passed: warm8.candidate.subprocessCount === 0 && warm32.candidate.subprocessCount === 0,
      detail: `candidate subprocess totals: warm8=${warm8.candidate.subprocessCount}, warm32=${warm32.candidate.subprocessCount}`,
    },
    {
      name: "identity_changes_discover_once",
      passed: changedScenarios.every(
        (scenario) => scenario.candidate.maxSubprocessesPerIteration === 1,
      ),
      detail: changedScenarios
        .map((scenario) => `${scenario.name}=${scenario.candidate.maxSubprocessesPerIteration}`)
        .join(", "),
    },
    {
      name: "negative_cached_transient_retried",
      passed:
        authoritativeNegative.candidate.subprocessCount === 0 &&
        transient.candidate.maxSubprocessesPerIteration === 2,
      detail: `negative total=${authoritativeNegative.candidate.subprocessCount}; transient max=${transient.candidate.maxSubprocessesPerIteration}`,
    },
    {
      name: "editor_single_flight",
      passed: editorScenarios.every(
        (scenario) =>
          scenario.base.maxSubprocessesPerIteration === 1 &&
          scenario.base.subprocessCount === scenario.base.samples &&
          scenario.candidate.maxSubprocessesPerIteration === 1 &&
          scenario.candidate.subprocessCount === scenario.candidate.samples,
      ),
      detail: editorScenarios
        .map(
          (scenario) =>
            `${scenario.name}=base:${scenario.base.subprocessCount}/${scenario.base.samples},candidate:${scenario.candidate.subprocessCount}/${scenario.candidate.samples}`,
        )
        .join(", "),
    },
    {
      name: "lru_256",
      passed: structural.lruPassed,
      detail: "257 identities evict the true LRU while retaining at most 256 entries",
    },
    {
      name: "initial_editor_snapshot_nonblocking",
      passed: structural.initialEditorSnapshotNonBlocking,
      detail: "initial editor snapshot settled while the injected discovery remained unresolved",
    },
    {
      name: "node_duplicate_environment_oracle",
      passed: structural.nodeEnvironmentOraclePassed,
      detail: "duplicate environment selection was executed by Node, not Bun",
    },
  ];
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function assertCandidateCheckoutIdentity(input: {
  readonly headSha: string;
  readonly candidateSha: string;
  readonly trackedStatus: string;
}): void {
  if (input.headSha.toLowerCase() !== input.candidateSha.toLowerCase()) {
    throw new Error(
      `Benchmark checkout HEAD ${input.headSha} does not match candidate ${input.candidateSha}.`,
    );
  }
  if (input.trackedStatus.trim().length > 0) {
    throw new Error(`Benchmark checkout has tracked changes:\n${input.trackedStatus}`);
  }
}

function assertInvokingCheckout(repo: string, candidateSha: string): void {
  assertCandidateCheckoutIdentity({
    headSha: git(repo, ["rev-parse", "HEAD"]),
    candidateSha,
    trackedStatus: git(repo, ["status", "--porcelain=v1", "--untracked-files=no"]),
  });
}

export function assertSafeBenchmarkOutputPath(
  output: string,
  operatingSystemTemp: string = tmpdir(),
): void {
  const resolvedOutput = resolve(output);
  const parent = dirname(resolvedOutput);
  const tempRoot = realpathSync(resolve(operatingSystemTemp));
  if (basename(resolvedOutput) !== RECEIPT_FILENAME) {
    throw new Error(`Benchmark output filename must be ${RECEIPT_FILENAME}.`);
  }
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error(`Benchmark output directory must already exist: ${parent}`);
  }
  const realParent = realpathSync(parent);
  const expectedTemp = statSync(tempRoot, { bigint: true });
  const actualTemp = statSync(dirname(realParent), { bigint: true });
  if (
    expectedTemp.dev !== actualTemp.dev ||
    expectedTemp.ino !== actualTemp.ino ||
    !RECEIPT_DIRECTORY_PATTERN.test(basename(realParent))
  ) {
    throw new Error(
      `Benchmark output directory is outside the controlled temp boundary: ${parent}`,
    );
  }
  if (readdirSync(realParent).length > 0 || existsSync(resolvedOutput)) {
    throw new Error(`Benchmark output directory must be empty: ${parent}`);
  }
}

export function benchmarkDependencyLinks(
  worktree: string,
  externalEffectPackage: string,
): ReadonlyArray<{ readonly link: string; readonly target: string }> {
  return [
    {
      link: join(worktree, "apps", "server", "node_modules", "@synara", "contracts"),
      target: join(worktree, "packages", "contracts"),
    },
    {
      link: join(worktree, "apps", "server", "node_modules", "@synara", "shared"),
      target: join(worktree, "packages", "shared"),
    },
    {
      link: join(worktree, "apps", "server", "node_modules", "effect"),
      target: externalEffectPackage,
    },
    {
      link: join(worktree, "packages", "contracts", "node_modules", "effect"),
      target: externalEffectPackage,
    },
  ];
}

export function assertRevisionLocalResolutions(
  worktree: string,
  resolutions: {
    readonly contracts: string;
    readonly sharedWindowsProcess: string;
    readonly effectFromServer: string;
    readonly effectFromContracts: string;
  },
  externalEffectPackage: string,
): void {
  for (const [name, resolvedPath] of Object.entries({
    contracts: resolutions.contracts,
    sharedWindowsProcess: resolutions.sharedWindowsProcess,
  })) {
    if (!isPathInside(worktree, resolvedPath)) {
      throw new Error(
        `Benchmark dependency ${name} resolved outside detached revision ${worktree}: ${resolvedPath}`,
      );
    }
  }
  for (const [name, resolvedPath] of Object.entries({
    effectFromServer: resolutions.effectFromServer,
    effectFromContracts: resolutions.effectFromContracts,
  })) {
    if (!isPathInside(externalEffectPackage, resolvedPath)) {
      throw new Error(
        `Benchmark dependency ${name} did not resolve from the locked external Effect package: ${resolvedPath}`,
      );
    }
  }
}

function provisionRevisionDependencies(
  worktree: string,
  externalEffectPackage: string,
  committedBunLockSha256: string,
): DependencyProvenance {
  const effectPackageJsonPath = join(externalEffectPackage, "package.json");
  const effectPackageJsonContents = readFileSync(effectPackageJsonPath);
  const effectPackageJson = JSON.parse(effectPackageJsonContents.toString("utf8")) as {
    readonly version?: unknown;
  };
  if (typeof effectPackageJson.version !== "string" || effectPackageJson.version.length === 0) {
    throw new Error(`Invalid Effect package metadata: ${effectPackageJsonPath}`);
  }
  for (const dependency of benchmarkDependencyLinks(worktree, externalEffectPackage)) {
    mkdirSync(dirname(dependency.link), { recursive: true });
    symlinkSync(dependency.target, dependency.link, "junction");
  }
  const resolutionScript = [
    "const root = process.env.SYNARA_BENCHMARK_WORKTREE;",
    'if (!root) throw new Error("Missing benchmark worktree.");',
    "const parent = `${root}/apps/server/src/open.ts`;",
    "const contractsParent = `${root}/packages/contracts/src/index.ts`;",
    "process.stdout.write(JSON.stringify({",
    '  contracts: Bun.resolveSync("@synara/contracts", parent),',
    '  sharedWindowsProcess: Bun.resolveSync("@synara/shared/windowsProcess", parent),',
    '  effectFromServer: Bun.resolveSync("effect", parent),',
    '  effectFromContracts: Bun.resolveSync("effect", contractsParent),',
    "}));",
  ].join("\n");
  const resolutionEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_PATH"),
  );
  const resolutions = JSON.parse(
    execFileSync(process.execPath, ["-e", resolutionScript], {
      cwd: worktree,
      encoding: "utf8",
      env: { ...resolutionEnvironment, SYNARA_BENCHMARK_WORKTREE: worktree },
      timeout: 30_000,
      windowsHide: true,
    }),
  ) as {
    readonly contracts: string;
    readonly sharedWindowsProcess: string;
    readonly effectFromServer: string;
    readonly effectFromContracts: string;
  };
  assertRevisionLocalResolutions(worktree, resolutions, externalEffectPackage);
  assertCleanWorktree(worktree);
  return {
    bunLockSha256: committedBunLockSha256,
    provisioning: {
      mode: "revision-local-workspace-junctions",
      network: "disabled",
      lifecycleScripts: "not-run",
      externalEffectPackageJsonSha256: createHash("sha256")
        .update(effectPackageJsonContents)
        .digest("hex"),
      externalEffectVersion: effectPackageJson.version,
    },
    revisionLocalResolutions: {
      contracts: relative(worktree, resolutions.contracts).replaceAll("\\", "/"),
      sharedWindowsProcess: relative(worktree, resolutions.sharedWindowsProcess).replaceAll(
        "\\",
        "/",
      ),
    },
  };
}

function removeRevisionDependencyLinks(worktree: string, externalEffectPackage: string): void {
  for (const dependency of [
    ...benchmarkDependencyLinks(worktree, externalEffectPackage),
  ].reverse()) {
    if (existsSync(dependency.link)) unlinkSync(dependency.link);
  }
}

export function runCleanupSteps(steps: ReadonlyArray<() => void>): Error[] {
  const errors: Error[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (cause) {
      errors.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }
  return errors;
}

function resolveCommit(repo: string, sha: string): string {
  const resolvedSha = git(repo, ["rev-parse", `${sha}^{commit}`]).toLowerCase();
  if (resolvedSha !== sha.toLowerCase()) {
    throw new Error(`SHA did not resolve immutably: requested ${sha}, resolved ${resolvedSha}`);
  }
  return resolvedSha;
}

function hashCommittedFile(repo: string, sha: string, path: string): string {
  const contents = execFileSync("git", ["-C", repo, "show", `${sha}:${path}`], {
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return createHash("sha256").update(contents).digest("hex");
}

function readCommittedPackageManager(repo: string, sha: string): string {
  const packageJson = JSON.parse(
    execFileSync("git", ["-C", repo, "show", `${sha}:package.json`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }),
  ) as { readonly packageManager?: unknown };
  if (typeof packageJson.packageManager !== "string" || packageJson.packageManager.length === 0) {
    throw new Error(`Revision ${sha} has no packageManager declaration.`);
  }
  return packageJson.packageManager;
}

export function assertMatchingLockfileProvenance(
  baseDigest: string,
  candidateDigest: string,
): void {
  if (baseDigest !== candidateDigest) {
    throw new Error(
      `Benchmark revisions have different committed bun.lock digests: base=${baseDigest}, candidate=${candidateDigest}.`,
    );
  }
}

export function assertMatchingPackageManagerProvenance(
  baseDeclaration: string,
  candidateDeclaration: string,
): void {
  if (baseDeclaration !== candidateDeclaration) {
    throw new Error(
      `Benchmark revisions have different packageManager declarations: base=${baseDeclaration}, candidate=${candidateDeclaration}.`,
    );
  }
}

function assertAncestor(repo: string, ancestor: string, descendant: string, label: string): void {
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    throw new Error(`${label}: ${ancestor} is not an ancestor of ${descendant}.`);
  }
}

function assertCleanWorktree(worktree: string): void {
  const dirty = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty.length > 0) throw new Error(`Benchmark worktree is dirty: ${worktree}`);
}

function assertDetachedRevision(worktree: string, expectedSha: string): void {
  const headSha = git(worktree, ["rev-parse", "HEAD"]).toLowerCase();
  if (headSha !== expectedSha.toLowerCase()) {
    throw new Error(
      `Detached benchmark worktree HEAD ${headSha} does not match expected ${expectedSha}.`,
    );
  }
  assertCleanWorktree(worktree);
}

function assertSafeTempRoot(tempRoot: string, allowedParent: string): void {
  const relativePath = relative(allowedParent, tempRoot);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    !basename(tempRoot).startsWith("synara-discovery-benchmark-")
  ) {
    throw new Error(`Refusing unsafe benchmark temporary path: ${tempRoot}`);
  }
}

const APPX_MARKER_PATTERN = /^powershell-process-[0-9a-f]{32}\.json$/i;
const EXPECTED_APPX_FAMILY = "Microsoft.VisualStudioCode_8wekyb3d8bbwe";

const APPX_MODULE_CONTENTS = [
  "Set-StrictMode -Version Latest",
  "",
  "$script:MarkerDirectory = $env:SYNARA_BENCHMARK_APPX_MARKER_DIR",
  "if ([string]::IsNullOrWhiteSpace($script:MarkerDirectory)) {",
  "    throw 'SYNARA_BENCHMARK_APPX_MARKER_DIR is required.'",
  "}",
  "$script:MarkerPath = Join-Path -Path $script:MarkerDirectory -ChildPath (",
  "    'powershell-process-{0}.json' -f [Guid]::NewGuid().ToString('N')",
  ")",
  "$script:RequestedNames = [Collections.Generic.List[string]]::new()",
  "",
  "function Write-SynaraAppxMarker {",
  "    $marker = [ordered]@{",
  "        ProcessId = $PID",
  "        ModulePath = $PSCommandPath",
  "        RequestedNames = @($script:RequestedNames)",
  "    } | ConvertTo-Json -Compress",
  "    [IO.File]::WriteAllText(",
  "        $script:MarkerPath,",
  "        $marker,",
  "        [Text.UTF8Encoding]::new($false)",
  "    )",
  "}",
  "",
  "Write-SynaraAppxMarker",
  "",
  "function Get-AppxPackage {",
  "    [CmdletBinding()]",
  "    param(",
  "        [Parameter(Position = 0)]",
  "        [string] $Name",
  "    )",
  "",
  "    $installLocation = $env:SYNARA_BENCHMARK_APPX_LOCATION",
  "    if ([string]::IsNullOrWhiteSpace($installLocation)) {",
  "        throw 'SYNARA_BENCHMARK_APPX_LOCATION is required.'",
  "    }",
  "",
  "    $script:RequestedNames.Add($Name)",
  "    Write-SynaraAppxMarker",
  "",
  "    if ($Name -ieq 'Microsoft.VisualStudioCode') {",
  "        [PSCustomObject]@{",
  "            Name = 'Microsoft.VisualStudioCode'",
  "            PackageFullName = 'Microsoft.VisualStudioCode_1.0.0.0_x64__8wekyb3d8bbwe'",
  "            PackageFamilyName = 'Microsoft.VisualStudioCode_8wekyb3d8bbwe'",
  "            PublisherId = '8wekyb3d8bbwe'",
  "            InstallLocation = $installLocation",
  "            IsFramework = $false",
  "        }",
  "    }",
  "}",
  "",
  "Export-ModuleMember -Function Get-AppxPackage",
].join("\r\n");

const APPX_MANIFEST_CONTENTS = [
  "@{",
  "    RootModule = 'Appx.psm1'",
  "    ModuleVersion = '1.0.0'",
  "    GUID = '4f48295e-594b-4f03-a9f4-b916b5287e67'",
  "    Author = 'Synara benchmark fixture'",
  "    Description = 'Deterministic Get-AppxPackage fixture for Windows discovery benchmarks.'",
  "    PowerShellVersion = '5.1'",
  "    FunctionsToExport = @('Get-AppxPackage')",
  "    CmdletsToExport = @()",
  "    VariablesToExport = @()",
  "    AliasesToExport = @()",
  "}",
].join("\r\n");

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertSameFile(left: string, right: string, description: string): void {
  const leftIdentity = statSync(left, { bigint: true });
  const rightIdentity = statSync(right, { bigint: true });
  if (leftIdentity.dev !== rightIdentity.dev || leftIdentity.ino !== rightIdentity.ino) {
    throw new Error(description + " resolved different files.");
  }
}

function assertPathInside(parent: string, child: string, description: string): void {
  const parentIdentity = statSync(realpathSync(parent), { bigint: true });
  for (let ancestor = dirname(realpathSync(child)); ; ancestor = dirname(ancestor)) {
    const ancestorIdentity = statSync(ancestor, { bigint: true });
    if (
      ancestorIdentity.dev === parentIdentity.dev &&
      ancestorIdentity.ino === parentIdentity.ino
    ) {
      return;
    }
    const next = dirname(ancestor);
    if (next === ancestor) break;
  }
  throw new Error(description + " resolved outside the controlled fixture.");
}

export function createFixture(tempRoot: string): BenchmarkFixture {
  const root = join(tempRoot, "fixture space é");
  const cwdA = join(root, "cwd-a");
  const cwdB = join(root, "cwd-b");
  const binA = join(root, "bin-a");
  const binB = join(root, "bin-b");
  const configuredSystemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!configuredSystemRoot) {
    throw new Error("SystemRoot or WINDIR is required for the editor benchmark fixture.");
  }
  const systemRoot = realpathSync(configuredSystemRoot);
  const powerShellBin = realpathSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0"));
  const powerShellExecutable = realpathSync(join(powerShellBin, "powershell.exe"));
  const powerShellExecutableSha256 = sha256File(powerShellExecutable);
  const editorRoot = join(tempRoot, "editor-fixture");
  const appxModuleRoot = join(editorRoot, "modules");
  const appxModuleDirectory = join(appxModuleRoot, "Appx");
  const appxModulePath = join(appxModuleDirectory, "Appx.psm1");
  const appxManifestPath = join(appxModuleDirectory, "Appx.psd1");
  const appxMarkerDirectory = join(editorRoot, "markers");
  const appxInstallLocation = join(editorRoot, "appx-install", "VS Code");
  for (const directory of [
    cwdA,
    cwdB,
    binA,
    binB,
    appxModuleDirectory,
    appxMarkerDirectory,
    appxInstallLocation,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  const exeCandidate = join(binA, "native tool.exe");
  const cmdCandidate = join(binB, "shim tool.cmd");
  writeFileSync(exeCandidate, "MZ-synara-benchmark\n", { flag: "wx" });
  writeFileSync(cmdCandidate, "@echo off\r\nexit /b 0\r\n", { flag: "wx" });
  writeFileSync(appxModulePath, APPX_MODULE_CONTENTS + "\r\n", { flag: "wx" });
  writeFileSync(appxManifestPath, APPX_MANIFEST_CONTENTS + "\r\n", { flag: "wx" });
  const treeSha256 = createHash("sha256")
    .update("bin-a/native tool.exe\0")
    .update(readFileSync(exeCandidate))
    .update("\0bin-b/shim tool.cmd\0")
    .update(readFileSync(cmdCandidate))
    .update("\0editor-fixture/modules/Appx/Appx.psm1\0")
    .update(readFileSync(appxModulePath))
    .update("\0editor-fixture/modules/Appx/Appx.psd1\0")
    .update(readFileSync(appxManifestPath))
    .update("\0host-powershell.exe.sha256\0")
    .update(powerShellExecutableSha256)
    .digest("hex");
  return {
    root,
    cwdA,
    cwdB,
    binA,
    binB,
    exeCandidate,
    cmdCandidate,
    systemRoot,
    powerShellBin,
    powerShellExecutable,
    powerShellExecutableSha256,
    appxModuleRoot,
    appxModulePath,
    appxMarkerDirectory,
    appxInstallLocation,
    treeSha256,
  };
}

export function editorFixtureEnvironment(fixture: BenchmarkFixture): NodeJS.ProcessEnv {
  return {
    PATH: fixture.powerShellBin,
    PATHEXT: ".CMD",
    SystemRoot: fixture.systemRoot,
    WINDIR: fixture.systemRoot,
    PSModulePath: fixture.appxModuleRoot,
    SYNARA_BENCHMARK_APPX_MARKER_DIR: fixture.appxMarkerDirectory,
    SYNARA_BENCHMARK_APPX_LOCATION: fixture.appxInstallLocation,
  };
}

function readAppxMarkerFiles(fixture: BenchmarkFixture): readonly string[] {
  const entries = readdirSync(fixture.appxMarkerDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !APPX_MARKER_PATTERN.test(entry.name)) {
      throw new Error("Unexpected AppX benchmark marker entry: " + entry.name);
    }
  }
  return entries.map((entry) => join(fixture.appxMarkerDirectory, entry.name));
}

export function resetAppxSubprocessMarkers(fixture: BenchmarkFixture): void {
  for (const markerPath of readAppxMarkerFiles(fixture)) unlinkSync(markerPath);
}

export function readAppxSubprocessCount(fixture: BenchmarkFixture): number {
  return readAppxMarkerFiles(fixture).length;
}

export function assertSingleEditorFixtureSubprocessCount(
  count: number,
  label: string,
): asserts count is 1 {
  if (count !== 1) {
    throw new Error(label + " used " + count + " AppX subprocesses; expected exactly one.");
  }
}

export function preflightEditorFixture(fixture: BenchmarkFixture): EditorFixturePreflight {
  resetAppxSubprocessMarkers(fixture);
  const environment = editorFixtureEnvironment(fixture);
  const whereProbe = spawnSync(join(fixture.systemRoot, "System32", "where.exe"), ["powershell"], {
    encoding: "utf8",
    env: environment,
    shell: false,
    windowsHide: true,
  });
  if (whereProbe.error) throw whereProbe.error;
  if (whereProbe.status !== 1 || whereProbe.stdout.trim().length > 0) {
    throw new Error(
      "Editor transport leaked into command discovery: status=" +
        whereProbe.status +
        ", stdout=" +
        JSON.stringify(whereProbe.stdout.trim()) +
        ".",
    );
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$command = Get-Command Get-AppxPackage -ErrorAction Stop",
    "$package = @(Get-AppxPackage -Name 'Microsoft.VisualStudioCode' -ErrorAction Stop | Select-Object -First 1)[0]",
    "$result = [ordered]@{ CommandType = [string]$command.CommandType; ModuleName = [string]$command.ModuleName; ModulePath = [string]$command.Module.Path; PowerShellVersion = [string]$PSVersionTable.PSVersion; ExecutablePath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName; PackageFamilyName = [string]$package.PackageFamilyName; InstallLocation = [string]$package.InstallLocation }",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: environment,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const parsed = JSON.parse(output.trim()) as {
    readonly CommandType?: unknown;
    readonly ModuleName?: unknown;
    readonly ModulePath?: unknown;
    readonly PowerShellVersion?: unknown;
    readonly ExecutablePath?: unknown;
    readonly PackageFamilyName?: unknown;
    readonly InstallLocation?: unknown;
  };
  if (
    parsed.CommandType !== "Function" ||
    parsed.ModuleName !== "Appx" ||
    typeof parsed.ModulePath !== "string" ||
    typeof parsed.PowerShellVersion !== "string" ||
    typeof parsed.ExecutablePath !== "string" ||
    parsed.PackageFamilyName !== EXPECTED_APPX_FAMILY ||
    parsed.InstallLocation !== fixture.appxInstallLocation
  ) {
    throw new Error("Editor fixture preflight returned unexpected data: " + output.trim());
  }
  assertPathInside(fixture.appxModuleRoot, parsed.ModulePath, "Get-AppxPackage module");
  assertSameFile(
    fixture.powerShellExecutable,
    parsed.ExecutablePath,
    "PATH and absolute PowerShell launch",
  );
  const markerFiles = readAppxMarkerFiles(fixture);
  assertSingleEditorFixtureSubprocessCount(markerFiles.length, "Editor fixture preflight");
  const markerPath = markerFiles[0];
  if (!markerPath) throw new Error("Editor fixture preflight marker was missing.");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    readonly ProcessId?: unknown;
    readonly ModulePath?: unknown;
    readonly RequestedNames?: unknown;
  };
  if (
    typeof marker.ProcessId !== "number" ||
    typeof marker.ModulePath !== "string" ||
    !Array.isArray(marker.RequestedNames) ||
    marker.RequestedNames.length !== 1 ||
    marker.RequestedNames[0] !== "Microsoft.VisualStudioCode"
  ) {
    throw new Error("Editor fixture marker was malformed: " + JSON.stringify(marker));
  }
  assertPathInside(fixture.appxModuleRoot, marker.ModulePath, "AppX marker module");
  const result: EditorFixturePreflight = {
    commandType: "Function",
    moduleName: "Appx",
    modulePathSha256: hashFixtureLabel(realpathSync(parsed.ModulePath)),
    powerShellVersion: parsed.PowerShellVersion,
    powerShellExecutableSha256: fixture.powerShellExecutableSha256,
    packageFamilyName: EXPECTED_APPX_FAMILY,
    installLocationSha256: hashFixtureLabel(fixture.appxInstallLocation),
    markerCount: 1,
    transportCommandHidden: true,
  };
  resetAppxSubprocessMarkers(fixture);
  return result;
}

function blockForFixtureDelay(): void {
  const view = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(view, 0, 0, SIMULATED_WHERE_DELAY_MS);
}

function commandInput(input: {
  readonly cache: unknown;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly outcome: "resolved_exe" | "resolved_cmd" | "not_found" | "transient";
  readonly fixture: BenchmarkFixture;
  readonly counter: { value: number };
}): Record<string, unknown> {
  return {
    platform: "win32",
    cwd: input.cwd,
    env: input.env,
    ...(input.cache === undefined ? {} : { commandDiscoveryCache: input.cache }),
    spawnSync: () => {
      input.counter.value += 1;
      blockForFixtureDelay();
      switch (input.outcome) {
        case "resolved_exe":
          return { status: 0, stdout: `${input.fixture.exeCandidate}\r\n` };
        case "resolved_cmd":
          return { status: 0, stdout: `${input.fixture.cmdCandidate}\r\n` };
        case "not_found":
          return { status: 1, stdout: "" };
        case "transient":
          return { status: null, stdout: "", error: new Error("fixture spawn failure") };
      }
    },
  };
}

function makeCache(runtime: RuntimeModule, now?: () => number): unknown {
  return runtime.createWindowsCommandDiscoveryCache?.(now ? { now } : undefined);
}

function baseEnvironment(fixture: BenchmarkFixture): NodeJS.ProcessEnv {
  return {
    PATH: `${fixture.binA};${fixture.binB}`,
    Path: `${fixture.binB};${fixture.binA}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
  };
}

function makeCommandScenario(
  runtime: VersionRuntime,
  fixture: BenchmarkFixture,
  name: string,
): ScenarioContext {
  const module = runtime.command;
  const environment = baseEnvironment(fixture);
  const persistentCounter = { value: 0 };
  const persistentCache = makeCache(module);

  const call = (input: {
    readonly cache: unknown;
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly command?: string;
    readonly outcome?: "resolved_exe" | "resolved_cmd" | "not_found" | "transient";
    readonly counter: { value: number };
  }) => {
    const outcome = input.outcome ?? "resolved_exe";
    const result = module.resolveWindowsCommandCandidates(
      input.command ?? "synara-fixture-tool",
      commandInput({
        cache: input.cache,
        env: input.env ?? environment,
        cwd: input.cwd ?? fixture.cwdA,
        outcome,
        fixture,
        counter: input.counter,
      }),
    );
    return {
      result,
      status:
        outcome === "transient"
          ? "transient_failure"
          : outcome === "not_found"
            ? "not_found"
            : "resolved",
    };
  };

  if (name.startsWith("warm_")) {
    call({ cache: persistentCache, counter: persistentCounter });
    persistentCounter.value = 0;
  }
  if (name === "authoritative_negative") {
    call({ cache: persistentCache, counter: persistentCounter, outcome: "not_found" });
    persistentCounter.value = 0;
  }

  return {
    run: async () => {
      const counter =
        name.startsWith("warm_") || name === "authoritative_negative"
          ? persistentCounter
          : { value: 0 };
      const startCount = counter.value;
      const startedAt = performance.now();
      let statusCategory = "resolved";
      switch (name) {
        case "cold_exe":
          call({ cache: makeCache(module), counter });
          break;
        case "cold_cmd_spaces_non_ascii":
          call({ cache: makeCache(module), counter, outcome: "resolved_cmd" });
          break;
        case "warm_8_identical_command_callers":
          for (let index = 0; index < 8; index += 1) call({ cache: persistentCache, counter });
          break;
        case "warm_32_identical_command_callers":
          for (let index = 0; index < 32; index += 1) call({ cache: persistentCache, counter });
          break;
        case "changed_path": {
          const cache = makeCache(module);
          call({ cache, counter, env: { ...environment, PATH: fixture.binA, Path: undefined } });
          const beforeChange = counter.value;
          const changed = call({
            cache,
            counter,
            env: { ...environment, PATH: fixture.binB, Path: undefined },
            outcome: "resolved_cmd",
          });
          counter.value = startCount + (counter.value - beforeChange);
          statusCategory = changed.status;
          break;
        }
        case "changed_pathext": {
          const cache = makeCache(module);
          call({ cache, counter, env: { ...environment, PATHEXT: ".EXE" } });
          const beforeChange = counter.value;
          const changed = call({
            cache,
            counter,
            env: { ...environment, PATHEXT: ".CMD" },
            outcome: "resolved_cmd",
          });
          counter.value = startCount + (counter.value - beforeChange);
          statusCategory = changed.status;
          break;
        }
        case "changed_cwd": {
          const cache = makeCache(module);
          call({ cache, counter, cwd: fixture.cwdA });
          const beforeChange = counter.value;
          const changed = call({ cache, counter, cwd: fixture.cwdB });
          counter.value = startCount + (counter.value - beforeChange);
          statusCategory = changed.status;
          break;
        }
        case "authoritative_negative":
          statusCategory = call({
            cache: persistentCache,
            counter,
            outcome: "not_found",
          }).status;
          break;
        case "transient_failure": {
          const cache = makeCache(module);
          call({ cache, counter, outcome: "transient" });
          statusCategory = call({ cache, counter, outcome: "transient" }).status;
          break;
        }
        case "missing_pathext": {
          const { PATHEXT: _removed, ...withoutPathExt } = environment;
          call({ cache: makeCache(module), counter, env: withoutPathExt });
          break;
        }
        case "empty_pathext":
          call({ cache: makeCache(module), counter, env: { ...environment, PATHEXT: "" } });
          break;
        default:
          throw new Error(`Unknown command benchmark scenario: ${name}`);
      }
      return {
        elapsedMs: performance.now() - startedAt,
        subprocessCount: counter.value - startCount,
        statusCategory,
      };
    },
  };
}

const EDITOR_DISCOVERY_SUCCESS: EditorDiscoveryRuntimeResult = {
  status: "success",
  availableEditors: ["vscode"],
  fileSystemOperations: 1,
  subprocessCount: 1,
};

function assertExpectedEditorResult(editors: ReadonlyArray<string>, runtime: VersionRuntime): void {
  if (editors.length !== 1 || editors[0] !== "vscode") {
    throw new Error(
      `${runtime.label} editor workload returned ${JSON.stringify(editors)}; expected [\"vscode\"].`,
    );
  }
}

function makeEditorScenario(
  runtime: VersionRuntime,
  fixture: BenchmarkFixture,
  callers: number,
): ScenarioContext {
  return {
    run: async () => {
      resetAppxSubprocessMarkers(fixture);
      runtime.editorAppDiscovery.clearWindowsStorePackageDiscoveryCache();
      const env = editorFixtureEnvironment(fixture);
      const startedAt = performance.now();
      if (runtime.label === "base") {
        const results = await Promise.all(
          Array.from({ length: callers }, async () =>
            runtime.open.resolveAvailableEditors("win32", env),
          ),
        );
        for (const editors of results) assertExpectedEditorResult(editors, runtime);
      } else {
        if (runtime.editorAvailability === null || !runtime.open.discoverAvailableEditors) {
          throw new Error("Candidate editor discovery/service path is unavailable.");
        }
        const editorAvailability = runtime.editorAvailability;
        const discoverAvailableEditors = runtime.open.discoverAvailableEditors;
        const snapshot = await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(
              editorAvailability.makeEditorAvailability({
                discover: (signal) =>
                  discoverAvailableEditors({
                    platform: "win32",
                    env,
                    cwd: fixture.cwdA,
                    signal,
                  }),
                identity: () => "benchmark-editor-identity",
              }),
              (availability) =>
                Effect.all(
                  Array.from({ length: callers }, () => availability.getSnapshotAndSchedule),
                  { concurrency: "unbounded" },
                ).pipe(Effect.andThen(availability.refresh)),
            ),
          ),
        );
        assertExpectedEditorResult(snapshot.availableEditors, runtime);
      }
      const subprocessCount = readAppxSubprocessCount(fixture);
      assertSingleEditorFixtureSubprocessCount(subprocessCount, runtime.label + " editor sample");
      return {
        elapsedMs: performance.now() - startedAt,
        subprocessCount,
        statusCategory: "resolved",
      };
    },
  };
}

async function measureScenario(input: {
  readonly name: string;
  readonly base: ScenarioContext;
  readonly candidate: ScenarioContext;
  readonly warmups: number;
  readonly iterations: number;
}): Promise<ScenarioComparison> {
  const samples = { base: [] as BenchmarkSample[], candidate: [] as BenchmarkSample[] };
  const totalRuns = input.warmups + input.iterations;
  for (let index = 0; index < totalRuns; index += 1) {
    for (const versionLabel of alternatingVersionOrder(index)) {
      const sample = await input[versionLabel].run();
      if (index >= input.warmups) samples[versionLabel].push(sample);
    }
  }
  return {
    name: input.name,
    base: summarizeSamples(samples.base),
    candidate: summarizeSamples(samples.candidate),
  };
}

async function importVersionRuntime(
  label: "base" | "candidate",
  sha: string,
  worktree: string,
): Promise<VersionRuntime> {
  const commandPath = join(worktree, "packages", "shared", "src", "windowsProcess.ts");
  const command = (await import(pathToFileURL(commandPath).href)) as RuntimeModule;
  const openPath = join(worktree, "apps", "server", "src", "open.ts");
  const open = (await import(pathToFileURL(openPath).href)) as OpenRuntimeModule;
  const editorAppDiscoveryPath = join(worktree, "apps", "server", "src", "editorAppDiscovery.ts");
  const editorAppDiscovery = (await import(
    pathToFileURL(editorAppDiscoveryPath).href
  )) as EditorAppDiscoveryRuntimeModule;
  const editorPath = join(worktree, "apps", "server", "src", "editorAvailability.ts");
  const editorAvailability = existsSync(editorPath)
    ? ((await import(pathToFileURL(editorPath).href)) as EditorAvailabilityRuntimeModule)
    : null;
  return {
    label,
    sha,
    worktree,
    command,
    open,
    editorAppDiscovery,
    editorAvailability,
  };
}

async function checkInitialEditorSnapshotNonBlocking(runtime: VersionRuntime): Promise<boolean> {
  if (runtime.editorAvailability === null) return false;
  let discoveryStarted = false;
  let released = false;
  let releaseDiscovery!: () => void;
  const held = new Promise<EditorDiscoveryRuntimeResult>((resolvePromise) => {
    releaseDiscovery = () => {
      released = true;
      resolvePromise(EDITOR_DISCOVERY_SUCCESS);
    };
  });
  let snapshotSettledBeforeRelease = false;

  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        runtime.editorAvailability.makeEditorAvailability({
          discover: () => {
            discoveryStarted = true;
            return held;
          },
          identity: () => "held-editor-identity",
        }),
        (availability) =>
          Effect.gen(function* () {
            yield* availability.getSnapshotAndSchedule;
            snapshotSettledBeforeRelease = !released;
            yield* Effect.yieldNow;
            releaseDiscovery();
            yield* availability.refresh;
          }),
      ),
    ),
  );
  return discoveryStarted && snapshotSettledBeforeRelease;
}

function checkCandidateLru(runtime: VersionRuntime, fixture: BenchmarkFixture): boolean {
  const module = runtime.command;
  if (!module.createWindowsCommandDiscoveryCache || !module.getWindowsCommandDiscoveryCacheStats) {
    return false;
  }
  const cache = makeCache(module);
  const counter = { value: 0 };
  const env = baseEnvironment(fixture);
  const invoke = (index: number) =>
    module.resolveWindowsCommandCandidates(
      `synara-lru-${index}`,
      commandInput({
        cache,
        env,
        cwd: fixture.cwdA,
        outcome: "resolved_exe",
        fixture,
        counter,
      }),
    );
  for (let index = 0; index < 256; index += 1) invoke(index);
  invoke(0);
  invoke(256);
  const beforeEvictedRead = counter.value;
  invoke(1);
  return (
    counter.value === beforeEvictedRead + 1 &&
    module.getWindowsCommandDiscoveryCacheStats(cache).size === 256
  );
}

function runNodeDuplicateEnvironmentOracle(): NodeDuplicateEnvironmentOracle {
  const nodeDescriptor = JSON.parse(
    execFileSync(
      "node",
      ["-p", "JSON.stringify({execPath:process.execPath,version:process.version})"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    ),
  ) as { readonly execPath: string; readonly version: string };
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
  );
  const upperValue = "C:\\synara-oracle-upper";
  const mixedValue = "C:\\synara-oracle-mixed";
  const oracleOutput = JSON.parse(
    execFileSync(
      nodeDescriptor.execPath,
      [
        "-e",
        "const keys=Object.keys(process.env).filter((key)=>key.toUpperCase()==='PATH').sort();process.stdout.write(JSON.stringify({keys,values:keys.map((key)=>process.env[key])}));",
      ],
      {
        encoding: "utf8",
        env: { ...cleanEnvironment, Path: mixedValue, PATH: upperValue },
        windowsHide: true,
      },
    ),
  ) as { readonly keys: readonly string[]; readonly values: readonly string[] };
  const effectiveKey = oracleOutput.keys[0] ?? null;
  const effectiveValue = oracleOutput.values[0] ?? null;
  return {
    launcherRuntime: { name: "bun", version: Bun.version },
    oracleRuntime: { name: "node", version: nodeDescriptor.version },
    effectiveKey,
    effectiveValueSha256: effectiveValue === null ? null : hashFixtureLabel(effectiveValue),
    expectedKey: "PATH",
    expectedValueSha256: hashFixtureLabel(upperValue),
    passed: effectiveKey === "PATH" && effectiveValue === upperValue,
  };
}

async function measureNativeWhere(
  runtime: VersionRuntime,
  fixture: BenchmarkFixture,
): Promise<BenchmarkSample> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const cache = makeCache(runtime.command);
  let observedSubprocesses = 0;
  const startedAt = performance.now();
  const candidates = runtime.command.resolveWindowsCommandCandidates("where", {
    platform: "win32",
    cwd: fixture.cwdA,
    env: {
      PATH: pathWin32.join(systemRoot, "System32"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: systemRoot,
    },
    ...(cache === undefined ? {} : { commandDiscoveryCache: cache }),
    onCommandDiscovery: (observation: { readonly source?: string }) => {
      if (observation.source === "where") observedSubprocesses += 1;
    },
  });
  return {
    elapsedMs: performance.now() - startedAt,
    subprocessCount: runtime.command.createWindowsCommandDiscoveryCache ? observedSubprocesses : 1,
    statusCategory: candidates.length > 0 ? "resolved" : "not_found",
  };
}

async function runBenchmark(options: BenchmarkCliOptions): Promise<Record<string, unknown>> {
  if (platform() !== "win32") throw new Error("The final discovery benchmark must run on Windows.");
  if (!existsSync(join(options.repo, ".git")))
    throw new Error(`Not a Git repository: ${options.repo}`);
  if (process.env.NODE_PATH?.trim()) {
    throw new Error("NODE_PATH must be unset for the isolated discovery benchmark.");
  }
  assertSafeBenchmarkOutputPath(options.output);

  const baseSha = resolveCommit(options.repo, options.baseSha);
  const candidateSha = resolveCommit(options.repo, options.candidateSha);
  const parentSha = resolveCommit(options.repo, options.parentSha);
  if (baseSha === candidateSha) {
    throw new Error("Base and candidate SHAs must resolve to different immutable revisions.");
  }
  assertAncestor(options.repo, parentSha, baseSha, "Required #397 parent check");
  assertAncestor(options.repo, baseSha, candidateSha, "Candidate ancestry check");
  assertInvokingCheckout(options.repo, candidateSha);
  const baseBunLockSha256 = hashCommittedFile(options.repo, baseSha, "bun.lock");
  const candidateBunLockSha256 = hashCommittedFile(options.repo, candidateSha, "bun.lock");
  assertMatchingLockfileProvenance(baseBunLockSha256, candidateBunLockSha256);
  const basePackageManager = readCommittedPackageManager(options.repo, baseSha);
  const candidatePackageManager = readCommittedPackageManager(options.repo, candidateSha);
  assertMatchingPackageManagerProvenance(basePackageManager, candidatePackageManager);
  const externalEffectPackage = realpathSync(
    join(options.repo, "apps", "server", "node_modules", "effect"),
  );

  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windowsRoot) throw new Error("SystemRoot or WINDIR is required for benchmark isolation.");
  const isolatedWorktreeTemp = realpathSync(join(windowsRoot, "Temp"));
  for (let ancestor = isolatedWorktreeTemp; ; ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, "node_modules"))) {
      throw new Error(`Benchmark worktree ancestor contains node_modules: ${ancestor}`);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
  }
  const tempRoot = mkdtempSync(join(isolatedWorktreeTemp, "synara-discovery-benchmark-"));
  assertSafeTempRoot(tempRoot, isolatedWorktreeTemp);
  const baseWorktree = join(tempRoot, "base");
  const candidateWorktree = join(tempRoot, "candidate");
  let benchmarkReport: Record<string, unknown> | undefined;
  let benchmarkFailure: unknown;
  let benchmarkFailed = false;
  let baseWorktreeRegistered = false;
  let candidateWorktreeRegistered = false;

  try {
    execFileSync(
      "git",
      ["-C", options.repo, "worktree", "add", "--detach", baseWorktree, baseSha],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    baseWorktreeRegistered = true;
    execFileSync(
      "git",
      ["-C", options.repo, "worktree", "add", "--detach", candidateWorktree, candidateSha],
      { stdio: "ignore", windowsHide: true },
    );
    candidateWorktreeRegistered = true;
    assertDetachedRevision(baseWorktree, baseSha);
    assertDetachedRevision(candidateWorktree, candidateSha);
    const baseDependencies = provisionRevisionDependencies(
      baseWorktree,
      externalEffectPackage,
      baseBunLockSha256,
    );
    const candidateDependencies = provisionRevisionDependencies(
      candidateWorktree,
      externalEffectPackage,
      candidateBunLockSha256,
    );
    assertDetachedRevision(baseWorktree, baseSha);
    assertDetachedRevision(candidateWorktree, candidateSha);

    const fixture = createFixture(tempRoot);
    const editorFixturePreflight = preflightEditorFixture(fixture);
    const [baseRuntime, candidateRuntime] = await Promise.all([
      importVersionRuntime("base", baseSha, baseWorktree),
      importVersionRuntime("candidate", candidateSha, candidateWorktree),
    ]);
    assertComparableEditorBenchmarkRuntime({
      baseResolveAvailableEditors: typeof baseRuntime.open.resolveAvailableEditors === "function",
      candidateDiscoverAvailableEditors:
        typeof candidateRuntime.open.discoverAvailableEditors === "function",
      candidateEditorAvailability: candidateRuntime.editorAvailability !== null,
    });
    const commandScenarioNames = [
      "cold_exe",
      "cold_cmd_spaces_non_ascii",
      "warm_8_identical_command_callers",
      "warm_32_identical_command_callers",
      "changed_path",
      "changed_pathext",
      "changed_cwd",
      "authoritative_negative",
      "transient_failure",
      "missing_pathext",
      "empty_pathext",
    ] as const;
    const scenarios: ScenarioComparison[] = [];
    for (const name of commandScenarioNames) {
      scenarios.push(
        await measureScenario({
          name,
          base: makeCommandScenario(baseRuntime, fixture, name),
          candidate: makeCommandScenario(candidateRuntime, fixture, name),
          warmups: options.warmups,
          iterations: options.iterations,
        }),
      );
    }
    for (const callers of [1, 8, 32] as const) {
      scenarios.push(
        await measureScenario({
          name: `editor_${callers}_callers`,
          base: makeEditorScenario(baseRuntime, fixture, callers),
          candidate: makeEditorScenario(candidateRuntime, fixture, callers),
          warmups: options.warmups,
          iterations: options.iterations,
        }),
      );
    }

    const nativeWhere = {
      base: await measureNativeWhere(baseRuntime, fixture),
      candidate: await measureNativeWhere(candidateRuntime, fixture),
    };
    const nodeEnvironmentOracle = runNodeDuplicateEnvironmentOracle();
    const structural = {
      lruPassed: checkCandidateLru(candidateRuntime, fixture),
      initialEditorSnapshotNonBlocking:
        await checkInitialEditorSnapshotNonBlocking(candidateRuntime),
      nodeEnvironmentOraclePassed: nodeEnvironmentOracle.passed,
    };
    const gates = evaluateBenchmarkGates(scenarios, structural);
    const nativeWhereSystemRootSource = process.env.SystemRoot
      ? "SystemRoot"
      : process.env.WINDIR
        ? "WINDIR"
        : "fallback";
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      repository: git(options.repo, ["remote", "get-url", "origin"]),
      immutableRevisions: { baseSha, candidateSha, pr397ParentOrIntegrationSha: parentSha },
      dirtyStateRejection: {
        enforced: true,
        scope: "candidate-matched tracked-clean invoking checkout plus clean detached worktrees",
      },
      dependencyProvenance: {
        identicalCommittedLockfile: true,
        base: baseDependencies,
        candidate: candidateDependencies,
      },
      machine: {
        platform: platform(),
        windowsVersion: version(),
        windowsRelease: release(),
        architecture: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        cpuCount: cpus().length,
        runnerImage: process.env.ImageOS ?? process.env.RUNNER_OS ?? "local",
      },
      runtimes: {
        benchmark: { name: "bun", version: Bun.version },
        node: { name: "node", version: nodeEnvironmentOracle.oracleRuntime.version },
        packageManagerPolicy: {
          baseDeclaration: basePackageManager,
          candidateDeclaration: candidatePackageManager,
          actualRuntime: `bun@${Bun.version}`,
          exactDeclarationMatch: basePackageManager === `bun@${Bun.version}`,
          policy:
            "relative benchmark uses one recorded Bun runtime for both revisions; declaration drift is rejected and exact-pin mismatch is disclosed",
        },
      },
      fixture: {
        id: FIXTURE_ID,
        treeSha256: fixture.treeSha256,
        editorPowerShell: editorFixturePreflight,
        labels: {
          command: {
            path: hashFixtureLabel(`${fixture.binA};${fixture.binB}`),
            pathExt: hashFixtureLabel(".COM;.EXE;.BAT;.CMD"),
            cwdA: hashFixtureLabel(fixture.cwdA),
            cwdB: hashFixtureLabel(fixture.cwdB),
          },
          editor: {
            path: hashFixtureLabel(fixture.powerShellBin),
            pathExt: hashFixtureLabel(".CMD"),
            cwd: hashFixtureLabel(fixture.cwdA),
            systemRoot: hashFixtureLabel(fixture.systemRoot),
            psModulePath: hashFixtureLabel(fixture.appxModuleRoot),
          },
        },
        systemRootSources: {
          editor: nativeWhereSystemRootSource,
          nativeWhere: nativeWhereSystemRootSource,
        },
        includes: [
          "native .exe",
          ".cmd shim",
          "spaces",
          "non-ASCII",
          "mixed-case duplicate environment keys",
          "missing PATHEXT",
          "empty PATHEXT",
          "real Windows PowerShell with an isolated deterministic Appx module",
        ],
      },
      procedure: {
        alternatingOrder: true,
        warmups: options.warmups,
        iterations: options.iterations,
        sameMachine: true,
        isolatedWorktrees: true,
        editorWorkload: {
          basePath: "immutable base apps/server/src/open.ts#resolveAvailableEditors",
          candidatePath:
            "immutable candidate apps/server/src/open.ts#discoverAvailableEditors through editorAvailability.ts",
          callerCounts: [1, 8, 32],
          callerSchedule:
            "base callers execute immutable synchronous discovery serially; candidate callers submit concurrently and join one refresh",
          appxBoundary:
            "same real Windows PowerShell binary, isolated Appx module, filesystem fixture, PATH, PATHEXT, cwd, and expected editor array",
          cacheReset: "each immutable editorAppDiscovery cache cleared once per sample",
          subprocessExpectation:
            "exactly one Appx process per base and candidate sample; the cached base is not presented as an uncached subprocess baseline",
        },
      },
      policy: {
        positiveTtlMs: 30_000,
        authoritativeNegativeTtlMs: 2_000,
        maxEntries: 256,
        refreshAfterMs: 300_000,
        editorRetryAfterMs: 2_000,
        whereDeadlineMs: 2_000,
        appxDeadlineMs: 2_000,
        discoveryOutputLimitBytes: 256 * 1024,
        maxAsyncFileSystemOperations: 8,
      },
      scenarios,
      nativeWhere,
      nodeDuplicateEnvironmentOracle: nodeEnvironmentOracle,
      structural,
      gates,
      passed: gates.every((gate) => gate.passed),
    };

    benchmarkReport = report;
  } catch (cause) {
    benchmarkFailed = true;
    benchmarkFailure = cause;
  }

  const cleanupErrors = runCleanupSteps([
    () => {
      if (existsSync(candidateWorktree)) {
        removeRevisionDependencyLinks(candidateWorktree, externalEffectPackage);
      }
    },
    () => {
      if (!candidateWorktreeRegistered) return;
      execFileSync(
        "git",
        ["-C", options.repo, "worktree", "remove", "--force", candidateWorktree],
        { stdio: "ignore", windowsHide: true },
      );
      candidateWorktreeRegistered = false;
    },
    () => {
      if (existsSync(baseWorktree)) {
        removeRevisionDependencyLinks(baseWorktree, externalEffectPackage);
      }
    },
    () => {
      if (!baseWorktreeRegistered) return;
      execFileSync("git", ["-C", options.repo, "worktree", "remove", "--force", baseWorktree], {
        stdio: "ignore",
        windowsHide: true,
      });
      baseWorktreeRegistered = false;
    },
    () => {
      assertSafeTempRoot(tempRoot, isolatedWorktreeTemp);
      const registeredWorktrees = [candidateWorktree, baseWorktree].filter((worktree) =>
        existsSync(worktree),
      );
      if (registeredWorktrees.length > 0 || candidateWorktreeRegistered || baseWorktreeRegistered) {
        throw new Error(
          `Refusing to remove benchmark root while worktrees remain: ${registeredWorktrees.join(", ") || "registered metadata"}`,
        );
      }
      if (existsSync(tempRoot)) {
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  ]);
  if (benchmarkFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [benchmarkFailure, ...cleanupErrors],
        "Benchmark failed and cleanup also reported errors.",
      );
    }
    throw benchmarkFailure;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Benchmark cleanup reported errors.");
  }
  if (benchmarkReport === undefined) throw new Error("Benchmark did not produce a report.");
  writeFileSync(options.output, `${JSON.stringify(benchmarkReport, null, 2)}\n`, { flag: "wx" });
  return benchmarkReport;
}

export function formatBenchmarkFailure(cause: unknown): string {
  if (cause instanceof AggregateError) {
    const nested = Array.from(cause.errors, (error, index) => {
      const formatted = formatBenchmarkFailure(error)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `[${index + 1}]\n${formatted}`;
    });
    return [cause.stack ?? cause.message, ...nested].join("\n");
  }
  return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  const report = await runBenchmark(options);
  const passed = report.passed === true;
  process.stdout.write(`${passed ? "PASS" : "FAIL"}: ${options.output}\n`);
  if (!passed) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    process.stderr.write(`${formatBenchmarkFailure(cause)}\n`);
    process.exitCode = 1;
  });
}
