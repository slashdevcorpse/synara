// FILE: desktop.fixture.ts
// Purpose: Launches the built Electron/main/preload/web/server stack with an isolated fake Codex CLI.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { closeElectronApplication } from "./support/processTree";

const requireFromFixture = createRequire(__filename);
const REPO_ROOT = Path.resolve(__dirname, "../../..");
const DESKTOP_MAIN_PATH = Path.join(REPO_ROOT, "apps/desktop/dist-electron/main.js");
const ELECTRON_BOOTSTRAP_PATH = Path.join(__dirname, "fixtures/electron-bootstrap.cjs");
const DIAGNOSTIC_REDACTION_PATH = Path.join(__dirname, "fixtures/diagnostic-redaction.cjs");
const FAKE_CODEX_SOURCE_PATH = Path.join(__dirname, "fixtures/fake-codex.ts");
const NETWORK_GUARD_PATH = Path.join(__dirname, "fixtures/network-guard.cjs");
const { redactDiagnosticText } = requireFromFixture(DIAGNOSTIC_REDACTION_PATH) as {
  readonly redactDiagnosticText: (value: unknown) => string;
};
type JsonRecord = Record<string, unknown>;
interface RendererReadinessResult {
  readonly snapshotSequence: number;
  readonly providers: ReadonlyArray<JsonRecord>;
}

function formatAggregateError(error: unknown): string {
  if (error instanceof AggregateError) {
    const nestedErrors = [...error.errors].map(formatAggregateError).join(" | ");
    return nestedErrors ? `${error.name}: ${error.message} (${nestedErrors})` : error.message;
  }
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

const PROVIDER_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "CURSOR_",
  "DROID_",
  "FACTORY_",
  "GEMINI_",
  "GOOGLE_",
  "GROK_",
  "KILO_",
  "OPENAI_",
  "OPENCODE_",
  "PI_",
  "XAI_",
] as const;
const SENSITIVE_ENV_KEY_PATTERN =
  /(?:^|_)(?:AUTH|TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|COOKIE)(?:_|$)/u;
const EXPLICIT_ENV_KEYS_TO_REMOVE = new Set([
  "BUN_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "GIT_ASKPASS",
  "NODE_OPTIONS",
  "NPM_CONFIG_USERCONFIG",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]);
const CHROMIUM_NETWORK_GUARD_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1",
  "--metrics-recording-only",
  "--proxy-bypass-list=<local>;127.0.0.1;[::1]",
  "--proxy-server=http://127.0.0.1:9",
] as const;
const PROJECT_SKILL_ROOTS = [
  [".synara", "skills"],
  [".codex", "skills"],
  [".claude", "skills"],
  [".cursor", "skills"],
  [".cursor", "skills-cursor"],
  [".grok", "skills"],
  [".factory", "skills"],
  [".kilo", "skills"],
  [".opencode", "skills"],
  [".pi", "agent", "skills"],
  [".agents", "skills"],
] as const;
const BROWSER_SESSION_PARTITION = "persist:synara-browser";
const FAKE_CODEX_PREFLIGHT_TIMEOUT_MS = 15_000;
const FAKE_CODEX_RUNTIME_BUILD_TIMEOUT_MS = 30_000;
const NETWORK_GUARD_PREFLIGHT_TIMEOUT_MS = 5_000;
const BUN_RUNTIME_COMMAND = resolveExecutableOnPath("bun");
const NODE_RUNTIME_COMMAND = resolveExecutableOnPath("node");

export function normalizePathDirectory(rawDirectory: string): string {
  return rawDirectory.trim().replace(/^"|"$/gu, "");
}

function resolveExecutableOnPath(command: string): string {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter(Boolean)
      : [""];
  for (const rawDirectory of (process.env.PATH ?? "").split(Path.delimiter)) {
    const directory = normalizePathDirectory(rawDirectory);
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = Path.join(directory, `${command}${extension}`);
      try {
        FS.accessSync(candidate, FS.constants.X_OK);
        if (FS.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue through the remaining PATH candidates.
      }
    }
  }
  throw new Error(`Desktop E2E requires ${command} on PATH.`);
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relative = Path.relative(Path.resolve(parentPath), Path.resolve(candidatePath));
  return (
    relative === "" ||
    (!Path.isAbsolute(relative) && !relative.startsWith(`..${Path.sep}`) && relative !== "..")
  );
}

function isolatedOperationalBase(): string {
  const realHomeDir = Path.resolve(OS.homedir());
  const baseDir =
    process.platform === "win32"
      ? Path.resolve(
          process.env.PUBLIC?.trim() || Path.join(Path.dirname(realHomeDir), "Public"),
          "Documents",
        )
      : Path.resolve(OS.tmpdir());
  if (isPathWithin(realHomeDir, baseDir)) {
    throw new Error(
      `Desktop E2E operational base must not be nested under the real user home: ${baseDir}`,
    );
  }
  return baseDir;
}

async function assertWorkspaceAncestorsAreIsolated(workspaceDir: string): Promise<void> {
  const existingRoots: string[] = [];
  let ancestor = Path.resolve(workspaceDir);
  while (true) {
    for (const segments of PROJECT_SKILL_ROOTS) {
      const candidate = Path.join(ancestor, ...segments);
      if (FS.existsSync(candidate)) existingRoots.push(candidate);
    }
    const parent = Path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (existingRoots.length > 0) {
    throw new Error(
      `Desktop E2E workspace ancestors expose live skill roots: ${existingRoots.join(", ")}`,
    );
  }
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function buildFakeCodexRuntime(runtimeDir: string): Promise<string> {
  const outputPath = Path.join(runtimeDir, "fake-codex-runtime.mjs");
  const result = spawnSync(
    BUN_RUNTIME_COMMAND,
    ["build", FAKE_CODEX_SOURCE_PATH, "--target=node", "--format=esm", "--outfile", outputPath],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: FAKE_CODEX_RUNTIME_BUILD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new Error(`Failed to build the fake Codex Node runtime: ${result.error.message}`);
  }
  if (result.status !== 0 || !FS.existsSync(outputPath)) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit status ${result.status}`;
    throw new Error(`Failed to build the fake Codex Node runtime: ${detail}`);
  }
  return outputPath;
}

async function createFakeCodexLauncher(
  runtimeDir: string,
  fakeCodexRuntimePath: string,
): Promise<string> {
  const launcherDir = Path.join(runtimeDir, "fake-codex");
  const fakeCodexHome = Path.join(runtimeDir, "fake-codex-home");
  await FS.promises.mkdir(launcherDir, { recursive: true });
  await FS.promises.mkdir(fakeCodexHome, { recursive: true });
  if (process.platform === "win32") {
    const launcherPath = Path.join(launcherDir, "codex.cmd");
    const contents = [
      "@echo off",
      `${quoteCmdArgument(NODE_RUNTIME_COMMAND)} ${quoteCmdArgument(fakeCodexRuntimePath)} %*`,
      "exit /b %errorlevel%",
      "",
    ].join("\r\n");
    await FS.promises.writeFile(launcherPath, contents, "utf8");
    return launcherPath;
  }

  const launcherPath = Path.join(launcherDir, "codex");
  const contents = [
    "#!/usr/bin/env sh",
    `exec ${quotePosixArgument(NODE_RUNTIME_COMMAND)} ${quotePosixArgument(fakeCodexRuntimePath)} "$@"`,
    "",
  ].join("\n");
  await FS.promises.writeFile(launcherPath, contents, { encoding: "utf8", mode: 0o755 });
  await FS.promises.chmod(launcherPath, 0o755);
  return launcherPath;
}

async function preflightFakeCodexLauncher(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { prepareResolvedWindowsSafeProcess } = await import("@synara/shared/windowsProcess");
  const probes = [
    { args: ["--version"], expectedOutput: "codex-cli 0.99.0" },
    { args: ["login", "status"], expectedOutput: "Logged in" },
  ] as const;
  for (const probe of probes) {
    const prepared = prepareResolvedWindowsSafeProcess(input.binaryPath, probe.args, {
      cwd: input.cwd,
      env: input.env,
    });
    const result = spawnSync(prepared.command, prepared.args, {
      cwd: input.cwd,
      env: input.env,
      encoding: "utf8",
      shell: prepared.shell,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: FAKE_CODEX_PREFLIGHT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: prepared.windowsHide,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (result.error) {
      throw new Error(
        `Fake Codex preflight ${JSON.stringify(probe.args)} failed: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const detail = stderr.trim() || stdout.trim() || `exit status ${result.status ?? "null"}`;
      throw new Error(`Fake Codex preflight ${JSON.stringify(probe.args)} failed: ${detail}`);
    }
    if (stdout.trim() !== probe.expectedOutput || stderr.trim().length > 0) {
      throw new Error(
        `Fake Codex preflight ${JSON.stringify(probe.args)} returned unexpected output: ${JSON.stringify({ stdout, stderr })}`,
      );
    }
  }
}

function preflightNodeNetworkGuard(input: {
  readonly cwd: string;
  readonly networkGuardPath: string;
  readonly networkLogPath: string;
}): void {
  const script = [
    'const Net = require("node:net");',
    'const socket = Net.connect({ host: "203.0.113.1", port: 9 });',
    'const timeout = setTimeout(() => { console.error("guard timeout"); socket.destroy(); process.exit(3); }, 1_000);',
    'socket.once("connect", () => { clearTimeout(timeout); console.error("guard connected"); socket.destroy(); process.exit(4); });',
    'socket.once("error", (error) => { clearTimeout(timeout); if (error?.code !== "EACCES") { console.error(error); process.exit(5); } console.log("EACCES"); });',
  ].join("\n");
  const result = spawnSync(
    NODE_RUNTIME_COMMAND,
    ["--require", input.networkGuardPath, "-e", script],
    {
      cwd: input.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        SYNARA_E2E_NETWORK_ROLE: "guard-probe",
        SYNARA_FAKE_CODEX_NETWORK_LOG_PATH: input.networkLogPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: NETWORK_GUARD_PREFLIGHT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (
    result.error ||
    result.status !== 0 ||
    stdout.trim() !== "EACCES" ||
    stderr.trim().length > 0
  ) {
    throw new Error(
      `Desktop E2E Node network guard preflight failed: ${JSON.stringify({
        error: result.error?.message ?? null,
        status: result.status,
        stdout,
        stderr,
      })}`,
    );
  }
}

export function isolatedExecutablePath(
  fakeCodexDir: string,
  inheritedPath: string | undefined,
): string {
  const codexNames =
    process.platform === "win32"
      ? ["codex", "codex.com", "codex.exe", "codex.cmd", "codex.bat"]
      : ["codex"];
  const seen = new Set<string>();
  const safeInheritedDirectories = (inheritedPath ?? "")
    .split(Path.delimiter)
    .map(normalizePathDirectory)
    .filter(Boolean)
    .filter((directory) => {
      const normalized =
        process.platform === "win32"
          ? Path.resolve(directory).toLowerCase()
          : Path.resolve(directory);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return !codexNames.some((name) => FS.existsSync(Path.join(directory, name)));
    });
  return [fakeCodexDir, ...safeInheritedDirectories].join(Path.delimiter);
}

export function assertFakeCodexIsOnlyPathCandidate(
  pathValue: string,
  fakeCodexPath: string,
): readonly string[] {
  const candidateNames =
    process.platform === "win32"
      ? ["codex.com", "codex.exe", "codex.cmd", "codex.bat", "codex"]
      : ["codex"];
  const candidates = pathValue
    .split(Path.delimiter)
    .map(normalizePathDirectory)
    .filter(Boolean)
    .flatMap((directory) =>
      candidateNames
        .map((name) => Path.resolve(directory, name))
        .filter((candidate) => FS.existsSync(candidate)),
    );
  const normalizedFakePath =
    process.platform === "win32"
      ? Path.resolve(fakeCodexPath).toLowerCase()
      : Path.resolve(fakeCodexPath);
  const unexpected = candidates.filter((candidate) => {
    const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    return normalized !== normalizedFakePath;
  });
  if (
    !candidates.some((candidate) => {
      const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      return normalized === normalizedFakePath;
    })
  ) {
    throw new Error(
      `The fake Codex launcher is not resolvable from the isolated PATH: ${fakeCodexPath}`,
    );
  }
  if (unexpected.length > 0) {
    throw new Error(
      `The isolated PATH exposes non-fixture Codex candidates: ${unexpected.join(", ")}`,
    );
  }
  return candidates;
}

async function seedServerSettings(
  homeDir: string,
  fakeCodexPath: string,
  runtimeDir: string,
): Promise<void> {
  const settingsDir = Path.join(homeDir, "userdata");
  await FS.promises.mkdir(settingsDir, { recursive: true });
  await FS.promises.writeFile(
    Path.join(settingsDir, "settings.json"),
    `${JSON.stringify(
      {
        enableAssistantStreaming: true,
        enableProviderUpdateChecks: false,
        defaultThreadEnvMode: "local",
        providers: {
          codex: {
            enabled: true,
            binaryPath: fakeCodexPath,
            homePath: Path.join(runtimeDir, "fake-codex-home"),
            customModels: ["gpt-5.5", "gpt-5.3-codex"],
          },
          commandCode: { enabled: false },
          claudeAgent: { enabled: false },
          cursor: { enabled: false },
          antigravity: { enabled: false },
          grok: { enabled: false },
          droid: { enabled: false },
          kilo: { enabled: false },
          opencode: { enabled: false },
          pi: { enabled: false },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function isolatedElectronEnv(input: {
  readonly desktopMainPath: string;
  readonly fakeCodexPath: string;
  readonly homeDir: string;
  readonly networkLogPath: string;
  readonly networkGuardPath: string;
  readonly profileDir: string;
  readonly protocolLogPath: string;
  readonly invocationLogPath: string;
  readonly runtimeDir: string;
  readonly workspaceDir: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    if (
      upperKey.startsWith("SYNARA_") ||
      upperKey.startsWith("VITE_") ||
      PROVIDER_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix)) ||
      SENSITIVE_ENV_KEY_PATTERN.test(upperKey) ||
      EXPLICIT_ENV_KEYS_TO_REMOVE.has(upperKey)
    ) {
      delete env[key];
    }
  }

  const osHomeDir = Path.join(input.runtimeDir, "os-home", process.platform);
  env.HOME = osHomeDir;
  env.USERPROFILE = osHomeDir;
  if (process.platform === "win32") {
    env.APPDATA = Path.join(input.profileDir, "windows", "roaming");
    env.LOCALAPPDATA = Path.join(input.profileDir, "windows", "local");
  } else if (process.platform === "linux") {
    env.XDG_CONFIG_HOME = Path.join(input.profileDir, "linux", "config");
    env.XDG_CACHE_HOME = Path.join(input.profileDir, "linux", "cache");
  }

  const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
  const isolatedPath = isolatedExecutablePath(Path.dirname(input.fakeCodexPath), inheritedPath);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  assertFakeCodexIsOnlyPathCandidate(isolatedPath, input.fakeCodexPath);

  return {
    ...env,
    ALL_PROXY: "http://127.0.0.1:9",
    ELECTRON_ENABLE_LOGGING: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost,::1",
    PATH: isolatedPath,
    SYNARA_DESKTOP_FLAVOR: "super",
    SYNARA_DESKTOP_DISABLE_UPDATES: "1",
    SYNARA_DISABLE_AUTO_UPDATE: "1",
    SYNARA_E2E_DESKTOP_MAIN_PATH: input.desktopMainPath,
    SYNARA_E2E_NETWORK_LOG_PATH: input.networkLogPath,
    SYNARA_E2E_NETWORK_GUARD_PATH: input.networkGuardPath,
    SYNARA_E2E_WORKSPACE_PATH: input.workspaceDir,
    SYNARA_FAKE_CODEX_INVOCATION_LOG_PATH: input.invocationLogPath,
    SYNARA_FAKE_CODEX_NETWORK_LOG_PATH: input.networkLogPath,
    SYNARA_FAKE_CODEX_NETWORK_GUARD_PATH: input.networkGuardPath,
    SYNARA_FAKE_CODEX_PROTOCOL_LOG_PATH: input.protocolLogPath,
    SYNARA_FAKE_CODEX_WORKSPACE_PATH: input.workspaceDir,
    SYNARA_HOME: input.homeDir,
    SYNARA_LOG_PROVIDER_EVENTS: "1",
    SYNARA_LOG_WS_EVENTS: "1",
    SYNARA_NO_BROWSER: "1",
    SYNARA_TELEMETRY_ENABLED: "0",
    VITEST: "1",
    all_proxy: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

function appendLog(logPath: string, label: string, chunk: unknown): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  FS.appendFileSync(logPath, redactDiagnosticText(`[${label}] ${buffer.toString("utf8")}`), "utf8");
}

export class DesktopHarness {
  readonly operationalBase: string;
  readonly operationalDir: string;
  readonly runtimeDir: string;
  readonly homeDir: string;
  readonly profileDir: string;
  readonly workspaceDir: string;
  readonly protocolLogPath: string;
  readonly invocationLogPath: string;
  readonly desktopLogPath: string;
  readonly networkLogPath: string;
  readonly networkGuardPath: string;
  readonly fakeCodexPath: string;
  private electronAppValue: ElectronApplication | null = null;
  private pageValue: Page | null = null;
  private launchCount = 0;
  private finished = false;

  private constructor(
    private readonly testInfo: TestInfo,
    operationalBase: string,
    operationalDir: string,
  ) {
    this.operationalBase = operationalBase;
    this.operationalDir = operationalDir;
    this.runtimeDir = testInfo.outputPath("runtime");
    this.homeDir = Path.join(this.operationalDir, "home");
    this.profileDir = Path.join(this.operationalDir, "profile");
    this.workspaceDir = Path.join(this.operationalDir, "workspace");
    this.protocolLogPath = Path.join(this.runtimeDir, "protocol.jsonl");
    this.invocationLogPath = Path.join(this.runtimeDir, "invocations.jsonl");
    this.desktopLogPath = Path.join(this.runtimeDir, "desktop.log");
    this.networkLogPath = Path.join(this.runtimeDir, "network.jsonl");
    this.networkGuardPath = Path.join(this.operationalDir, "network-guard.cjs");
    this.fakeCodexPath = Path.join(
      this.operationalDir,
      "fake-codex",
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
  }

  static async create(testInfo: TestInfo): Promise<DesktopHarness> {
    const operationalBase = isolatedOperationalBase();
    await FS.promises.mkdir(operationalBase, { recursive: true });
    const operationalDir = await FS.promises.mkdtemp(Path.join(operationalBase, "synara-e2e-"));
    const harness = new DesktopHarness(testInfo, operationalBase, operationalDir);
    try {
      await FS.promises.mkdir(harness.runtimeDir, { recursive: true });
      await FS.promises.mkdir(harness.workspaceDir, { recursive: true });
      await FS.promises.mkdir(harness.profileDir, { recursive: true });
      await FS.promises.writeFile(harness.invocationLogPath, "", "utf8");
      await FS.promises.writeFile(harness.protocolLogPath, "", "utf8");
      await assertWorkspaceAncestorsAreIsolated(harness.workspaceDir);
      await FS.promises.copyFile(
        DIAGNOSTIC_REDACTION_PATH,
        Path.join(harness.operationalDir, "diagnostic-redaction.cjs"),
      );
      await FS.promises.copyFile(NETWORK_GUARD_PATH, harness.networkGuardPath);
      preflightNodeNetworkGuard({
        cwd: harness.workspaceDir,
        networkGuardPath: harness.networkGuardPath,
        networkLogPath: harness.networkLogPath,
      });
      const fakeCodexRuntimePath = await buildFakeCodexRuntime(harness.operationalDir);
      const fakeCodexPath = await createFakeCodexLauncher(
        harness.operationalDir,
        fakeCodexRuntimePath,
      );
      if (Path.resolve(fakeCodexPath) !== Path.resolve(harness.fakeCodexPath)) {
        throw new Error(`Unexpected fake Codex launcher path: ${fakeCodexPath}`);
      }
      await seedServerSettings(harness.homeDir, fakeCodexPath, harness.operationalDir);
      await harness.launch();
      return harness;
    } catch (error) {
      try {
        await harness.finish();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Desktop E2E launch failed and its cleanup also reported an error.",
        );
      }
      throw error;
    }
  }

  get electronApp(): ElectronApplication {
    if (!this.electronAppValue) throw new Error("The desktop application is not running.");
    return this.electronAppValue;
  }

  get page(): Page {
    if (!this.pageValue) throw new Error("The desktop page is not available.");
    return this.pageValue;
  }

  async launch(): Promise<void> {
    if (this.electronAppValue) throw new Error("The desktop application is already running.");
    this.launchCount += 1;
    const networkEventBaseline = (await this.readJsonLines(this.networkLogPath)).length;
    await FS.promises.appendFile(
      this.desktopLogPath,
      `\n[e2e] launch=${this.launchCount} at=${new Date().toISOString()}\n`,
      "utf8",
    );
    const electronPath = requireFromFixture("electron") as string;
    const launchEnv = isolatedElectronEnv({
      fakeCodexPath: this.fakeCodexPath,
      homeDir: this.homeDir,
      networkLogPath: this.networkLogPath,
      profileDir: this.profileDir,
      protocolLogPath: this.protocolLogPath,
      invocationLogPath: this.invocationLogPath,
      runtimeDir: this.operationalDir,
      workspaceDir: this.workspaceDir,
      desktopMainPath: DESKTOP_MAIN_PATH,
      networkGuardPath: this.networkGuardPath,
    });
    // Prove the isolated launcher directly instead of depending on background health-refresh timing.
    await preflightFakeCodexLauncher({
      binaryPath: this.fakeCodexPath,
      cwd: this.workspaceDir,
      env: launchEnv,
    });
    const codexPathCandidates = assertFakeCodexIsOnlyPathCandidate(
      launchEnv.PATH ?? "",
      this.fakeCodexPath,
    );
    await FS.promises.appendFile(
      this.desktopLogPath,
      [
        `[e2e] fake-codex=${this.fakeCodexPath}`,
        `[e2e] codex-path-candidates=${JSON.stringify(codexPathCandidates)}`,
        `[e2e] isolated-path=${launchEnv.PATH ?? ""}`,
        "",
      ].join("\n"),
      "utf8",
    );
    // Exclude the direct launcher preflight while retaining every provider probe from this
    // Electron launch, including a startup refresh that begins before renderer readiness.
    const rendererRpcInvocationBaseline = (await this.readJsonLines(this.invocationLogPath)).length;
    const electronApp = await _electron.launch({
      executablePath: electronPath,
      args: [...CHROMIUM_NETWORK_GUARD_ARGS, ELECTRON_BOOTSTRAP_PATH],
      cwd: REPO_ROOT,
      env: launchEnv,
      timeout: 60_000,
    });
    this.electronAppValue = electronApp;
    try {
      const child = electronApp.process();
      child.stdout?.on("data", (chunk) => appendLog(this.desktopLogPath, "stdout", chunk));
      child.stderr?.on("data", (chunk) => appendLog(this.desktopLogPath, "stderr", chunk));
      child.on("exit", (code, signal) => {
        appendLog(
          this.desktopLogPath,
          "process",
          `exit code=${code ?? "null"} signal=${signal ?? "null"}\n`,
        );
      });
      await expect
        .poll(
          async () => {
            const events = (await this.readJsonLines(this.networkLogPath)).slice(
              networkEventBaseline,
            );
            return {
              desktopMain: events.some(
                (entry) => entry.event === "guard-installed" && entry.role === "desktop-main",
              ),
              backend: events.some(
                (entry) => entry.event === "guard-installed" && entry.role === "backend",
              ),
              defaultGuard: events.some(
                (entry) => entry.event === "guard-installed" && entry.partition === "default",
              ),
              browserGuard: events.some(
                (entry) =>
                  entry.event === "guard-installed" &&
                  entry.partition === BROWSER_SESSION_PARTITION,
              ),
              defaultProxy: events.find(
                (entry) => entry.event === "proxy-resolved" && entry.partition === "default",
              )?.result,
              browserProxy: events.find(
                (entry) =>
                  entry.event === "proxy-resolved" && entry.partition === BROWSER_SESSION_PARTITION,
              )?.result,
            };
          },
          { timeout: 10_000 },
        )
        .toEqual({
          desktopMain: true,
          backend: true,
          defaultGuard: true,
          browserGuard: true,
          defaultProxy: "DIRECT",
          browserProxy: "DIRECT",
        });
      const page = await electronApp.firstWindow({ timeout: 60_000 });
      const desktopMainPid = await electronApp.evaluate(() => process.pid);
      await expect
        .poll(async () =>
          (await this.readJsonLines(this.networkLogPath))
            .slice(networkEventBaseline)
            .some(
              (entry) =>
                entry.event === "guard-installed" &&
                entry.role === "desktop-main" &&
                entry.pid === desktopMainPid,
            ),
        )
        .toBe(true);
      await FS.promises.appendFile(
        this.desktopLogPath,
        `[e2e] wrapper-pid=${child.pid ?? "none"} desktop-main-pid=${desktopMainPid}\n`,
        "utf8",
      );
      this.pageValue = page;
      page.on("console", (message) => {
        appendLog(this.desktopLogPath, `renderer:${message.type()}`, `${message.text()}\n`);
      });
      page.on("pageerror", (error) => {
        appendLog(this.desktopLogPath, "renderer:pageerror", `${error.stack ?? error.message}\n`);
      });
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("body")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByLabel("Loading projects")).toBeHidden({ timeout: 60_000 });
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
      const rendererReadiness = await page.evaluate(async () => {
        const harness = (
          window as typeof window & {
            __synaraE2e?: { probeReadiness: () => Promise<RendererReadinessResult> };
          }
        ).__synaraE2e;
        if (!harness) {
          throw new Error("Desktop E2E renderer readiness probe is unavailable.");
        }
        return harness.probeReadiness();
      });
      expect(rendererReadiness.snapshotSequence).toBeGreaterThanOrEqual(0);
      const codexReadiness = rendererReadiness.providers.find(
        (provider) => provider.provider === "codex",
      );
      if (!codexReadiness) {
        throw new Error(
          `Desktop E2E renderer readiness omitted Codex: ${JSON.stringify(rendererReadiness.providers)}`,
        );
      }
      expect(codexReadiness).toMatchObject({
        status: "ready",
        available: true,
        authStatus: "authenticated",
      });

      const invocations = (await this.readJsonLines(this.invocationLogPath)).slice(
        rendererRpcInvocationBaseline,
      );
      const networkEvents = (await this.readJsonLines(this.networkLogPath)).slice(
        networkEventBaseline,
      );
      const guardedProcesses = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "guard-installed" &&
          entry.role === "fake-codex" &&
          typeof entry.pid === "number" &&
          Array.isArray(entry.args)
            ? [JSON.stringify([entry.pid, entry.args])]
            : [],
        ),
      );
      const healthInvocations = invocations.filter(
        (entry) =>
          typeof entry.pid === "number" &&
          Array.isArray(entry.args) &&
          (JSON.stringify(entry.args) === JSON.stringify(["--version"]) ||
            JSON.stringify(entry.args) === JSON.stringify(["login", "status"])),
      );
      expect({
        version: healthInvocations.some(
          (entry) => JSON.stringify(entry.args) === JSON.stringify(["--version"]),
        ),
        auth: healthInvocations.some(
          (entry) => JSON.stringify(entry.args) === JSON.stringify(["login", "status"]),
        ),
        guarded:
          healthInvocations.length >= 2 &&
          healthInvocations.every((entry) =>
            guardedProcesses.has(JSON.stringify([entry.pid, entry.args])),
          ),
      }).toEqual({ version: true, auth: true, guarded: true });
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Desktop E2E readiness failed and the launched process did not cleanly stop.",
        );
      }
      throw error;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.launch();
  }

  async stop(): Promise<void> {
    const electronApp = this.electronAppValue;
    this.pageValue = null;
    this.electronAppValue = null;
    if (electronApp) await closeElectronApplication(electronApp);
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const errors: unknown[] = [];
    try {
      await this.stop();
    } catch (error) {
      errors.push(error);
    }
    const backendLogsPath = Path.join(this.homeDir, "userdata", "logs");
    const preservedBackendLogsPath = Path.join(this.runtimeDir, "backend-logs");
    const stateDatabasePath = Path.join(this.homeDir, "userdata", "state.sqlite");
    const preservedStateDatabasePath = Path.join(this.runtimeDir, "state.sqlite");
    const stateDatabaseArtifacts = [
      { source: stateDatabasePath, destination: preservedStateDatabasePath },
      { source: `${stateDatabasePath}-wal`, destination: `${preservedStateDatabasePath}-wal` },
      { source: `${stateDatabasePath}-shm`, destination: `${preservedStateDatabasePath}-shm` },
    ] as const;
    try {
      if (FS.existsSync(backendLogsPath)) {
        await FS.promises.cp(backendLogsPath, preservedBackendLogsPath, { recursive: true });
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      for (const artifact of stateDatabaseArtifacts) {
        if (FS.existsSync(artifact.source)) {
          await FS.promises.copyFile(artifact.source, artifact.destination);
        }
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.removeOperationalRoot();
    } catch (error) {
      errors.push(error);
    }
    const attachments = [
      { name: "desktop-log", path: this.desktopLogPath, contentType: "text/plain" },
      {
        name: "codex-invocation-log",
        path: this.invocationLogPath,
        contentType: "application/x-ndjson",
      },
      {
        name: "codex-protocol-log",
        path: this.protocolLogPath,
        contentType: "application/x-ndjson",
      },
      { name: "network-log", path: this.networkLogPath, contentType: "application/x-ndjson" },
      {
        name: "server-log",
        path: Path.join(preservedBackendLogsPath, "server.log"),
        contentType: "text/plain",
      },
      {
        name: "desktop-main-log",
        path: Path.join(preservedBackendLogsPath, "desktop-main.log"),
        contentType: "text/plain",
      },
      {
        name: "provider-event-log",
        path: Path.join(preservedBackendLogsPath, "provider", "events.log"),
        contentType: "text/plain",
      },
      {
        name: "state-database",
        path: preservedStateDatabasePath,
        contentType: "application/vnd.sqlite3",
      },
      {
        name: "state-database-wal",
        path: `${preservedStateDatabasePath}-wal`,
        contentType: "application/octet-stream",
      },
      {
        name: "state-database-shm",
        path: `${preservedStateDatabasePath}-shm`,
        contentType: "application/octet-stream",
      },
    ];
    for (const attachment of attachments) {
      try {
        if (FS.existsSync(attachment.path)) await this.testInfo.attach(attachment.name, attachment);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      const networkEvents = await this.readJsonLines(this.networkLogPath);
      const installedLayers = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "guard-installed" && typeof entry.layer === "string" ? [entry.layer] : [],
        ),
      );
      const missingLayers = ["node", "chromium"].filter((layer) => !installedLayers.has(layer));
      if (missingLayers.length > 0) {
        errors.push(
          new Error(`Desktop network guard did not install for: ${missingLayers.join(", ")}.`),
        );
      }
      const installedNodeRoles = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "guard-installed" &&
          entry.layer === "node" &&
          typeof entry.role === "string"
            ? [entry.role]
            : [],
        ),
      );
      const missingNodeRoles = ["desktop-main", "backend", "fake-codex"].filter(
        (role) => !installedNodeRoles.has(role),
      );
      if (missingNodeRoles.length > 0) {
        errors.push(
          new Error(
            `Desktop Node network guard did not install for: ${missingNodeRoles.join(", ")}.`,
          ),
        );
      }
      const installedChromiumPartitions = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "guard-installed" &&
          entry.layer === "chromium" &&
          typeof entry.partition === "string"
            ? [entry.partition]
            : [],
        ),
      );
      const missingChromiumPartitions = ["default", BROWSER_SESSION_PARTITION].filter(
        (partition) => !installedChromiumPartitions.has(partition),
      );
      if (missingChromiumPartitions.length > 0) {
        errors.push(
          new Error(
            `Desktop Chromium network guard did not install for: ${missingChromiumPartitions.join(", ")}.`,
          ),
        );
      }
      const directProxyPartitions = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "proxy-resolved" &&
          entry.result === "DIRECT" &&
          typeof entry.partition === "string"
            ? [entry.partition]
            : [],
        ),
      );
      const nonDirectProxyPartitions = ["default", BROWSER_SESSION_PARTITION].filter(
        (partition) => !directProxyPartitions.has(partition),
      );
      if (nonDirectProxyPartitions.length > 0) {
        errors.push(
          new Error(
            `Desktop Chromium loopback proxy did not resolve DIRECT for: ${nonDirectProxyPartitions.join(", ")}.`,
          ),
        );
      }
      const protocolEvents = await this.readJsonLines(this.protocolLogPath);
      const invocationEvents = await this.readJsonLines(this.invocationLogPath);
      const invocationProcessKeys = new Set(
        invocationEvents.flatMap((entry) =>
          typeof entry.pid === "number" && Array.isArray(entry.args)
            ? [JSON.stringify([entry.pid, entry.args])]
            : [],
        ),
      );
      const guardedFakeProcessKeys = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "guard-installed" &&
          entry.layer === "node" &&
          entry.role === "fake-codex" &&
          typeof entry.pid === "number" &&
          Array.isArray(entry.args)
            ? [JSON.stringify([entry.pid, entry.args])]
            : [],
        ),
      );
      const unguardedInvocationProcesses = [...invocationProcessKeys].filter(
        (processKey) => !guardedFakeProcessKeys.has(processKey),
      );
      if (unguardedInvocationProcesses.length > 0) {
        errors.push(
          new Error(
            `Fake Codex process guard evidence is missing for invocation(s): ${unguardedInvocationProcesses.join(", ")}.`,
          ),
        );
      }
      const nonNodeInvocationPids = invocationEvents.flatMap((entry) => {
        const runtime =
          entry.runtime && typeof entry.runtime === "object"
            ? (entry.runtime as { bun?: unknown; executable?: unknown })
            : null;
        return typeof entry.pid === "number" &&
          (runtime?.bun !== false ||
            typeof runtime.executable !== "string" ||
            !/^node(?:\.exe)?$/iu.test(Path.basename(runtime.executable)))
          ? [entry.pid]
          : [];
      });
      if (nonNodeInvocationPids.length > 0) {
        errors.push(
          new Error(
            `Fake Codex invocation(s) did not run in the guarded Node runtime: ${nonNodeInvocationPids.join(", ")}.`,
          ),
        );
      }
      const protocolPids = new Set(
        protocolEvents.flatMap((entry) => (typeof entry.pid === "number" ? [entry.pid] : [])),
      );
      const guardedFakeCodexPids = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "guard-installed" &&
          entry.layer === "node" &&
          entry.role === "fake-codex" &&
          typeof entry.pid === "number"
            ? [entry.pid]
            : [],
        ),
      );
      const unguardedProtocolPids = [...protocolPids].filter(
        (pid) => !guardedFakeCodexPids.has(pid),
      );
      if (unguardedProtocolPids.length > 0) {
        errors.push(
          new Error(
            `Fake Codex protocol process(es) lacked the Node network guard: ${unguardedProtocolPids.join(", ")}.`,
          ),
        );
      }
      const appServerInvocationKeys = new Set(
        invocationEvents.flatMap((entry) =>
          typeof entry.pid === "number" &&
          Array.isArray(entry.args) &&
          entry.args.includes("app-server")
            ? [JSON.stringify([entry.pid, entry.args])]
            : [],
        ),
      );
      const appServerProtocolKeys = new Set(
        protocolEvents.flatMap((entry) => {
          const payload =
            entry.payload !== null && typeof entry.payload === "object"
              ? (entry.payload as { event?: unknown; args?: unknown })
              : null;
          return entry.direction === "fixture" &&
            payload?.event === "process-started" &&
            typeof entry.pid === "number" &&
            Array.isArray(payload.args)
            ? [JSON.stringify([entry.pid, payload.args])]
            : [];
        }),
      );
      const missingAppServerProtocol = [...appServerInvocationKeys].filter(
        (processKey) => !appServerProtocolKeys.has(processKey),
      );
      const orphanedAppServerProtocol = [...appServerProtocolKeys].filter(
        (processKey) => !appServerInvocationKeys.has(processKey),
      );
      if (missingAppServerProtocol.length > 0 || orphanedAppServerProtocol.length > 0) {
        errors.push(
          new Error(
            `Fake Codex app-server evidence mismatch: missing=${JSON.stringify(missingAppServerProtocol)}, orphaned=${JSON.stringify(orphanedAppServerProtocol)}.`,
          ),
        );
      }
      const turnStarted = protocolEvents.some(
        (entry) =>
          entry.direction === "in" &&
          entry.payload !== null &&
          typeof entry.payload === "object" &&
          (entry.payload as { method?: unknown }).method === "turn/start",
      );
      const textGenerationInvocations = invocationEvents.filter(
        (entry) => Array.isArray(entry.args) && entry.args[0] === "exec",
      );
      if (turnStarted && textGenerationInvocations.length === 0) {
        errors.push(
          new Error("A provider turn started without an observed title-generation exec."),
        );
      }
      const malformedTextGenerationPids = textGenerationInvocations.flatMap((entry) => {
        const args = entry.args as unknown[];
        const schemaIndex = args.indexOf("--output-schema");
        const outputIndex = args.indexOf("--output-last-message");
        const valid =
          schemaIndex >= 0 &&
          typeof args[schemaIndex + 1] === "string" &&
          outputIndex >= 0 &&
          typeof args[outputIndex + 1] === "string";
        return !valid && typeof entry.pid === "number" ? [entry.pid] : [];
      });
      if (malformedTextGenerationPids.length > 0) {
        errors.push(
          new Error(
            `Fake Codex title-generation invocation(s) lacked required output arguments: ${malformedTextGenerationPids.join(", ")}.`,
          ),
        );
      }
      const approvalRequested = protocolEvents.some(
        (entry) =>
          entry.direction === "out" &&
          entry.payload !== null &&
          typeof entry.payload === "object" &&
          (entry.payload as { method?: unknown }).method ===
            "item/commandExecution/requestApproval",
      );
      const approvalChildPids = protocolEvents.flatMap((entry) => {
        const payload =
          entry.payload !== null && typeof entry.payload === "object"
            ? (entry.payload as { event?: unknown; pid?: unknown })
            : null;
        return entry.direction === "fixture" &&
          payload?.event === "approval-command-completed" &&
          typeof payload.pid === "number"
          ? [payload.pid]
          : [];
      });
      const guardedApprovalChildPids = new Set(
        networkEvents.flatMap((entry) =>
          entry.event === "guard-installed" &&
          entry.layer === "node" &&
          entry.role === "approval-child" &&
          typeof entry.pid === "number"
            ? [entry.pid]
            : [],
        ),
      );
      const unguardedApprovalChildPids = approvalChildPids.filter(
        (pid) => !guardedApprovalChildPids.has(pid),
      );
      if (approvalRequested && approvalChildPids.length === 0) {
        errors.push(new Error("An approved command ran without child-process evidence."));
      }
      if (unguardedApprovalChildPids.length > 0) {
        errors.push(
          new Error(
            `Approval command child process(es) lacked the Node network guard: ${unguardedApprovalChildPids.join(", ")}.`,
          ),
        );
      }
      const malformedProtocolEvents = protocolEvents.filter(
        (entry) =>
          entry.direction === "invalid-json" ||
          (entry.direction === "fixture" &&
            entry.payload !== null &&
            typeof entry.payload === "object" &&
            ((entry.payload as { event?: unknown }).event === "unexpected-notification" ||
              (entry.payload as { event?: unknown }).event === "unexpected-response")),
      );
      if (malformedProtocolEvents.length > 0) {
        errors.push(
          new Error(
            `Fake Codex observed ${malformedProtocolEvents.length} malformed or unexpected protocol message(s); inspect codex-protocol-log.`,
          ),
        );
      }
      const methodNotFoundResponses = protocolEvents.filter((entry) => {
        if (entry.direction !== "out" || !entry.payload || typeof entry.payload !== "object") {
          return false;
        }
        const error = (entry.payload as { error?: unknown }).error;
        return (
          error !== null &&
          typeof error === "object" &&
          (error as { code?: unknown }).code === -32601
        );
      });
      if (methodNotFoundResponses.length > 0) {
        errors.push(
          new Error(
            `Fake Codex rejected ${methodNotFoundResponses.length} unknown JSON-RPC request(s); inspect codex-protocol-log.`,
          ),
        );
      }
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      const errorSummary = errors
        .map((error, index) => `[${index + 1}] ${formatAggregateError(error)}`)
        .join("\n");
      throw new AggregateError(
        errors,
        `Desktop E2E teardown or isolation validation failed:\n${errorSummary}`,
      );
    }
  }

  private async removeOperationalRoot(): Promise<void> {
    const resolvedOperationalBase = Path.resolve(this.operationalBase);
    const resolvedOperationalDir = Path.resolve(this.operationalDir);
    if (
      !resolvedOperationalDir.startsWith(`${resolvedOperationalBase}${Path.sep}`) ||
      !Path.basename(resolvedOperationalDir).startsWith("synara-e2e-")
    ) {
      throw new Error(`Refusing to remove unverified desktop E2E root: ${resolvedOperationalDir}`);
    }
    await FS.promises.rm(resolvedOperationalDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    if (FS.existsSync(resolvedOperationalDir)) {
      throw new Error(`Desktop E2E root still exists after removal: ${resolvedOperationalDir}`);
    }
  }

  private async readJsonLines(filePath: string): Promise<readonly JsonRecord[]> {
    if (!FS.existsSync(filePath)) return [];
    const raw = await FS.promises.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
  }

  async readProtocolLog(): Promise<readonly JsonRecord[]> {
    return this.readJsonLines(this.protocolLogPath);
  }

  async readNetworkLog(): Promise<readonly JsonRecord[]> {
    return this.readJsonLines(this.networkLogPath);
  }
}

interface DesktopFixtures {
  readonly desktop: DesktopHarness;
}

export const test = base.extend<DesktopFixtures>({
  desktop: async ({}, use, testInfo) => {
    const desktop = await DesktopHarness.create(testInfo);
    try {
      await use(desktop);
    } finally {
      await desktop.finish();
    }
  },
});

export { expect };
