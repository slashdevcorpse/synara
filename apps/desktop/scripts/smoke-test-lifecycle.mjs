import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, win32 } from "node:path";

export const DESKTOP_SMOKE_OBSERVATION_MS = 8_000;
export const DESKTOP_SMOKE_GRACEFUL_SHUTDOWN_MS = 5_000;
export const DESKTOP_SMOKE_EXIT_PROOF_MS = 2_000;
export const DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS = 30_000;
export const DESKTOP_SMOKE_WINDOWS_TEARDOWN_MS = 13_000;
export const DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS = 2_000;
export const WINDOWS_SMOKE_JOB_READY_PREFIX = "SYNARA_SMOKE_JOB_READY ";
export const WINDOWS_SMOKE_JOB_TERMINATE_PREFIX = "SYNARA_SMOKE_JOB_TERMINATE ";
export const WINDOWS_SMOKE_JOB_RUN_ID_ENV = "SYNARA_SMOKE_JOB_RUN_ID";

const WINDOWS_SMOKE_FALLBACK_DELAY_MS = 5_000;
const WINDOWS_SMOKE_FINAL_CLEANUP_RESERVE_MS = 2_000;
const WINDOWS_SMOKE_TASKKILL_CLOSE_PROOF_MS = 500;
const WINDOWS_SMOKE_TASKKILL_MARGIN_MS = 100;
const WINDOWS_SMOKE_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DESKTOP_PERSISTENCE_SMOKE_READINESS_MS = 30_000;
export const DESKTOP_PERSISTENCE_SMOKE_TREE_CONFIRMATION_MS = 8_000;
export const DESKTOP_PERSISTENCE_SMOKE_TREE_POLL_MS = 100;
export const DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV = "SYNARA_DESKTOP_PERSISTENCE_SMOKE_USER_DATA";
export const DESKTOP_PERSISTENCE_SMOKE_USER_DATA_DIRECTORY = "electron-user-data";
export const DESKTOP_PERSISTENCE_SMOKE_USER_DATA_LOG_PREFIX =
  "[desktop] persistence-smoke userData=";

export const DESKTOP_PERSISTENCE_SMOKE_READINESS_PATTERNS = Object.freeze(["Synara running"]);

export const DESKTOP_SMOKE_FATAL_PATTERNS = Object.freeze([
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "Failed to read environment configuration",
  "backend readiness check timed out",
  "UnhandledPromiseRejectionWarning",
  "SYNARA_SMOKE_JOB_ERROR",
]);

export function createDesktopSmokeEnvironment(environment = process.env) {
  const smokeEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() !== "vite_dev_server_url") smokeEnvironment[key] = value;
  }
  smokeEnvironment.ELECTRON_ENABLE_LOGGING = "1";
  return smokeEnvironment;
}

function environmentValueCaseInsensitive(environment, name) {
  const expectedName = name.toLowerCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === expectedName) return value;
  }
  return undefined;
}

function isWindowsDriveAbsoluteOrUncPath(value) {
  if (typeof value !== "string") return false;
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\/:*?"<>|]+[\\/][^\\/:*?"<>|]+(?:[\\/].*)?$/.test(value)
  );
}

function resolveWindowsSystemRoot(environment) {
  const systemRoot =
    environmentValueCaseInsensitive(environment, "SystemRoot") ||
    environmentValueCaseInsensitive(environment, "WINDIR");
  if (
    typeof systemRoot !== "string" ||
    systemRoot === "" ||
    systemRoot.trim() !== systemRoot ||
    /[\0\r\n]/.test(systemRoot) ||
    !isWindowsDriveAbsoluteOrUncPath(systemRoot)
  ) {
    throw new Error("Windows smoke test requires an absolute, clean SystemRoot.");
  }
  return win32.normalize(systemRoot);
}

export function resolveWindowsPowerShellPath(environment = process.env) {
  return win32.join(
    resolveWindowsSystemRoot(environment),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function validateWindowsSmokeLaunchInput({ executable, helperPath, runId, workingDirectory }) {
  if (!isWindowsDriveAbsoluteOrUncPath(executable) || /[\0\r\n]/.test(executable)) {
    throw new Error("Windows smoke executable path must be absolute and clean.");
  }
  if (!isWindowsDriveAbsoluteOrUncPath(helperPath) || /[\0\r\n]/.test(helperPath)) {
    throw new Error("Windows smoke Job Object helper path must be absolute and clean.");
  }
  if (!isWindowsDriveAbsoluteOrUncPath(workingDirectory) || /[\0\r\n]/.test(workingDirectory)) {
    throw new Error("Windows smoke working directory must be absolute and clean.");
  }
  if (!WINDOWS_SMOKE_RUN_ID_PATTERN.test(runId)) {
    throw new Error("Windows smoke Job Object run id must be a UUID.");
  }
}

export function createDesktopSmokeSpawnSpec({
  platform = process.platform,
  executable,
  args = [],
  environment = createDesktopSmokeEnvironment(),
  windowsHelperPath,
  windowsJobRunId,
  workingDirectory,
}) {
  if (platform !== "win32") {
    return {
      command: executable,
      args: [...args],
      options: {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: environment,
      },
    };
  }

  validateWindowsSmokeLaunchInput({
    executable,
    helperPath: windowsHelperPath,
    runId: windowsJobRunId,
    workingDirectory,
  });
  return {
    command: resolveWindowsPowerShellPath(environment),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsHelperPath,
      "--",
      executable,
      ...args,
    ],
    options: {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      cwd: workingDirectory,
      env: {
        ...environment,
        [WINDOWS_SMOKE_JOB_RUN_ID_ENV]: windowsJobRunId,
      },
    },
  };
}

function processDescription(code, signal) {
  return "code=" + (code ?? "null") + ", signal=" + (signal ?? "null");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPosixProcessGroupSignalRace(error) {
  // Neither code is teardown proof: ESRCH can race with root exit, while EPERM can persist until
  // the group disappears. The caller must still prove both root exit and process-group absence.
  return error?.code === "EPERM" || error?.code === "ESRCH";
}

function defaultSignalProcess(pid, signal) {
  process.kill(pid, signal);
}

function windowsTaskkillVerificationPids(output) {
  const pids = new Set();
  for (const match of output.matchAll(/\b(?:SUCCESS|ERROR): The process with PID\s+(\d+)\b/giu)) {
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function isUnsupportedWindowsTaskkillRace(output) {
  const lines = output
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let unsupportedTerminationCount = 0;
  let unsupportedReasonCount = 0;

  for (const line of lines) {
    if (line.startsWith("SUCCESS:")) continue;
    if (/^ERROR: The process with PID \d+\b.* could not be terminated\.$/u.test(line)) {
      unsupportedTerminationCount += 1;
      continue;
    }
    if (line === "Reason: The operation attempted is not supported.") {
      unsupportedReasonCount += 1;
      continue;
    }
    return false;
  }

  return unsupportedTerminationCount > 0 && unsupportedTerminationCount === unsupportedReasonCount;
}

export function classifyWindowsTaskkillClose({ code, signal, output }) {
  if (code === 0) return { ok: true };

  const diagnostic = `Windows taskkill did not confirm teardown (${processDescription(
    code,
    signal,
  )})${output.trim().length === 0 ? "." : `: ${output.trim()}`}`;
  const verificationPids = windowsTaskkillVerificationPids(output);
  if (verificationPids.length > 0 && isUnsupportedWindowsTaskkillRace(output)) {
    return { ok: false, diagnostic, verificationPids };
  }
  return { ok: false, diagnostic };
}

function defaultKillWindowsTree(pid, { timeoutMs, environment = process.env }) {
  return new Promise((resolve) => {
    let taskkillPath;
    try {
      taskkillPath = win32.join(resolveWindowsSystemRoot(environment), "System32", "taskkill.exe");
    } catch (error) {
      resolve({
        ok: false,
        diagnostic: "Windows taskkill path resolution failed: " + formatError(error),
      });
      return;
    }

    let taskkill;
    try {
      taskkill = spawn(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: environment,
      });
    } catch (error) {
      resolve({ ok: false, diagnostic: "Windows taskkill launch failed: " + formatError(error) });
      return;
    }

    let settled = false;
    let closeObserved = false;
    let operationTimeout;
    let closeProofTimeout;
    let output = "";
    const guardLateErrorsUntilClose = () => {
      if (closeObserved) return;
      const ignoreLateError = () => {};
      const removeLateErrorGuard = () => {
        taskkill.off("error", ignoreLateError);
      };
      taskkill.on("error", ignoreLateError);
      taskkill.once("close", removeLateErrorGuard);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (operationTimeout !== undefined) clearTimeout(operationTimeout);
      if (closeProofTimeout !== undefined) clearTimeout(closeProofTimeout);
      taskkill.off("error", onError);
      taskkill.off("close", onClose);
      guardLateErrorsUntilClose();
      resolve(result);
    };
    const onError = (error) => {
      finish({ ok: false, diagnostic: "Windows taskkill failed: " + formatError(error) });
    };
    const onClose = (code, signal) => {
      closeObserved = true;
      finish(classifyWindowsTaskkillClose({ code, signal, output }));
    };

    const appendOutput = (chunk) => {
      output += chunk.toString();
      if (output.length > 8_192) output = output.slice(-8_192);
    };
    taskkill.stdout?.on("data", appendOutput);
    taskkill.stderr?.on("data", appendOutput);
    taskkill.on("error", onError);
    taskkill.on("close", onClose);
    const closeProofMs = Math.min(
      WINDOWS_SMOKE_TASKKILL_CLOSE_PROOF_MS,
      Math.max(1, Math.floor(timeoutMs / 5)),
    );
    const operationTimeoutMs = Math.max(1, timeoutMs - closeProofMs);
    operationTimeout = setTimeout(() => {
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The timeout result remains authoritative.
      }
      if (settled || closeObserved) return;
      closeProofTimeout = setTimeout(() => {
        finish({
          ok: false,
          diagnostic:
            "Windows taskkill exceeded its " +
            timeoutMs +
            "ms cleanup timeout without close proof.",
        });
      }, closeProofMs);
    }, operationTimeoutMs);
  });
}

function stageTaskkillTimeout(stageMs) {
  const deadlineMarginMs = Math.min(
    WINDOWS_SMOKE_TASKKILL_MARGIN_MS,
    Math.max(1, Math.floor(stageMs / 10)),
  );
  return Math.max(1, stageMs - deadlineMarginMs);
}

function comparablePath(path, platform) {
  return platform === "win32" ? path.toLowerCase() : path;
}

function isSameOrContainedPath(parent, candidate, platform) {
  const comparableParent = comparablePath(parent, platform);
  const comparableCandidate = comparablePath(candidate, platform);
  const pathFromParent = relative(comparableParent, comparableCandidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

export function validateDesktopPersistenceSmokeEnvironment({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
} = {}) {
  const flavor = environment.SYNARA_DESKTOP_FLAVOR?.trim().toLowerCase();
  if (flavor !== "super") {
    throw new Error("Desktop persistence smoke requires SYNARA_DESKTOP_FLAVOR=super.");
  }

  const configuredHome = environment.SYNARA_HOME?.trim();
  if (!configuredHome) {
    throw new Error("Desktop persistence smoke requires an explicit absolute SYNARA_HOME.");
  }
  if (!isAbsolute(configuredHome)) {
    throw new Error(
      `Desktop persistence smoke requires an absolute SYNARA_HOME; received '${configuredHome}'.`,
    );
  }

  const resolvedHome = resolve(configuredHome);
  if (resolvedHome === parse(resolvedHome).root) {
    throw new Error("Desktop persistence smoke refuses to use a filesystem root as SYNARA_HOME.");
  }

  for (const liveHomeName of [".synara", ".synara-canary", ".super-synara"]) {
    const liveHome = resolve(homeDirectory, liveHomeName);
    if (isSameOrContainedPath(liveHome, resolvedHome, platform)) {
      throw new Error(
        `Desktop persistence smoke refuses to use live desktop state at '${resolvedHome}'.`,
      );
    }
  }

  if (environment.SYNARA_DESKTOP_DISABLE_UPDATES !== "1") {
    throw new Error('Desktop persistence smoke requires SYNARA_DESKTOP_DISABLE_UPDATES="1".');
  }

  return resolvedHome;
}

export function validateDesktopPersistenceSmokeProfileIsolation({
  environment,
  synaraHome,
  platform = process.platform,
}) {
  const configuredUserData = environment[DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV]?.trim();
  if (!configuredUserData) {
    throw new Error(
      `Desktop persistence smoke requires ${DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV}.`,
    );
  }
  if (!isAbsolute(configuredUserData)) {
    throw new Error(
      `Desktop persistence smoke requires ${DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV} to be absolute.`,
    );
  }

  const resolvedHome = resolve(synaraHome);
  const resolvedUserData = resolve(configuredUserData);
  if (
    resolvedUserData === resolvedHome ||
    !isSameOrContainedPath(resolvedHome, resolvedUserData, platform)
  ) {
    throw new Error(
      `Desktop persistence smoke requires ${DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV} to remain inside SYNARA_HOME.`,
    );
  }
  return resolvedUserData;
}

export function createDesktopPersistenceSmokeEnvironment({
  environment = process.env,
  synaraHome,
  platform = process.platform,
}) {
  const resolvedHome = resolve(synaraHome);
  const smokeEnvironment = createDesktopSmokeEnvironment(environment);
  for (const key of Object.keys(smokeEnvironment)) {
    if (key.toLowerCase() === DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV.toLowerCase()) {
      delete smokeEnvironment[key];
    }
  }
  smokeEnvironment[DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV] = resolve(
    resolvedHome,
    DESKTOP_PERSISTENCE_SMOKE_USER_DATA_DIRECTORY,
  );
  const userDataPath = validateDesktopPersistenceSmokeProfileIsolation({
    environment: smokeEnvironment,
    synaraHome: resolvedHome,
    platform,
  });
  return { environment: smokeEnvironment, userDataPath };
}

export function desktopPersistenceSmokeUserDataEvidence(userDataPath) {
  return `${DESKTOP_PERSISTENCE_SMOKE_USER_DATA_LOG_PREFIX}${resolve(userDataPath)}`;
}

export function ensureDesktopPersistenceSmokeHome(
  homePath,
  { statPath = statSync, makeDirectory = mkdirSync } = {},
) {
  let homeStat;
  try {
    homeStat = statPath(homePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(
        `Desktop persistence smoke could not inspect SYNARA_HOME '${homePath}': ${formatError(error)}`,
      );
    }

    makeDirectory(homePath, { recursive: true });
    homeStat = statPath(homePath);
    if (!homeStat.isDirectory()) {
      throw new Error(
        `Desktop persistence smoke created SYNARA_HOME '${homePath}', but it is not a directory.`,
      );
    }
    return { homePath, created: true };
  }

  if (!homeStat.isDirectory()) {
    throw new Error(
      `Desktop persistence smoke requires SYNARA_HOME '${homePath}' to be a directory.`,
    );
  }
  return { homePath, created: false };
}

function outputDiagnostic(output) {
  return output.length === 0 ? "" : `\nCaptured output:\n${output}`;
}

export function waitForDesktopSmokeReadiness({
  child,
  description = "Desktop",
  timeoutMs = DESKTOP_PERSISTENCE_SMOKE_READINESS_MS,
  readinessPatterns = DESKTOP_PERSISTENCE_SMOKE_READINESS_PATTERNS,
  fatalPatterns = DESKTOP_SMOKE_FATAL_PATTERNS,
  initialOutput = "",
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (readinessPatterns.length === 0) {
    throw new Error("Desktop readiness requires at least one semantic evidence pattern.");
  }

  return new Promise((resolveReadiness, rejectReadiness) => {
    let output = initialOutput;
    let settled = false;
    let timeout;

    const cleanup = () => {
      if (timeout !== undefined) clearTimer(timeout);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onOutput);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReadiness(new Error(`${message}${outputDiagnostic(output)}`));
    };

    const inspectOutput = () => {
      const fatalPattern = fatalPatterns.find((pattern) => output.includes(pattern));
      if (fatalPattern !== undefined) {
        fail(`${description} emitted fatal startup output '${fatalPattern}'.`);
        return;
      }

      const evidence = readinessPatterns.find((pattern) => output.includes(pattern));
      if (evidence === undefined || settled) return;
      settled = true;
      cleanup();
      resolveReadiness({ evidence, output });
    };

    function onOutput(chunk) {
      output += chunk.toString();
      inspectOutput();
    }

    function onError(error) {
      fail(`${description} process error before startup readiness: ${formatError(error)}.`);
    }

    function onExit(code, signal) {
      fail(
        `${description} exited before semantic startup readiness (${processDescription(code, signal)}).`,
      );
    }

    function onClose(code, signal) {
      fail(
        `${description} closed before semantic startup readiness (${processDescription(code, signal)}).`,
      );
    }

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);

    if (child.exitCode !== null || child.signalCode !== null) {
      fail(
        `${description} had already exited before semantic startup readiness (${processDescription(
          child.exitCode,
          child.signalCode,
        )}).`,
      );
      return;
    }

    inspectOutput();
    if (settled) return;
    timeout = setTimer(() => {
      fail(`${description} semantic startup readiness timed out after ${timeoutMs}ms.`);
    }, timeoutMs);
  });
}

function waitForDesktopProcessExit(
  child,
  timeoutMs,
  { setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolveExit) => {
    let timeout;
    const finish = (exited) => {
      if (timeout !== undefined) clearTimer(timeout);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);

    child.once("exit", onExit);
    child.once("close", onExit);
    timeout = setTimer(() => finish(false), timeoutMs);
  });
}

function defaultIsPosixTreeAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM proves the group cannot currently be signaled, not that it is absent.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function defaultIsWindowsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function waitForDesktopProcessTreeGone({
  isTreeAlive,
  timeoutMs,
  pollIntervalMs = DESKTOP_PERSISTENCE_SMOKE_TREE_POLL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  return new Promise((resolveGone, rejectGone) => {
    let remainingMs = timeoutMs;
    let timer;
    let settled = false;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      if (error !== undefined) {
        rejectGone(error);
        return;
      }
      resolveGone(result);
    };

    const check = () => {
      let treeAlive;
      try {
        treeAlive = isTreeAlive();
      } catch (error) {
        finish(false, error);
        return;
      }

      if (!treeAlive) {
        finish(true);
        return;
      }
      if (remainingMs <= 0) {
        finish(false);
        return;
      }

      const delayMs = Math.min(pollIntervalMs, remainingMs);
      remainingMs -= delayMs;
      timer = setTimer(check, delayMs);
    };

    check();
  });
}

function normalizeWindowsTreeKillResult(result) {
  if (typeof result === "boolean") {
    return {
      ok: result,
      diagnostic: result ? undefined : "Windows taskkill did not confirm process-tree teardown.",
    };
  }
  return result;
}

export async function forceStopDesktopSmokeProcessTree({
  child,
  description = "Desktop",
  platform = process.platform,
  timeoutMs = DESKTOP_PERSISTENCE_SMOKE_TREE_CONFIRMATION_MS,
  signalProcess = defaultSignalProcess,
  killWindowsTree = defaultKillWindowsTree,
  isWindowsProcessAlive = defaultIsWindowsProcessAlive,
  isPosixTreeAlive = defaultIsPosixTreeAlive,
  waitForExit = waitForDesktopProcessExit,
  waitForTreeGone = waitForDesktopProcessTreeGone,
}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error(`${description} cannot prove process-tree teardown without a valid pid.`);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `${description} exited before forced process-tree teardown began (${processDescription(
        child.exitCode,
        child.signalCode,
      )}).`,
    );
  }

  const pid = child.pid;
  if (platform === "win32") {
    const exitProof = waitForExit(child, timeoutMs);
    let treeKillResult;
    try {
      treeKillResult = normalizeWindowsTreeKillResult(await killWindowsTree(pid, { timeoutMs }));
    } catch (error) {
      treeKillResult = {
        ok: false,
        diagnostic: `Windows taskkill failed: ${formatError(error)}`,
      };
    }
    const exitConfirmed = await exitProof;

    let nonzeroTaskkillTreeGone = false;
    if (
      !treeKillResult?.ok &&
      Array.isArray(treeKillResult?.verificationPids) &&
      treeKillResult.verificationPids.length > 0
    ) {
      const verificationPids = [...new Set([pid, ...treeKillResult.verificationPids])];
      nonzeroTaskkillTreeGone = await waitForTreeGone({
        isTreeAlive: () =>
          verificationPids.some((verificationPid) => isWindowsProcessAlive(verificationPid)),
        timeoutMs,
      });
    }

    if (!treeKillResult?.ok && !nonzeroTaskkillTreeGone) {
      throw new Error(
        `${description} forced process-tree teardown was not confirmed: ${
          treeKillResult?.diagnostic ?? "Windows taskkill returned no confirmation."
        }`,
      );
    }
    if (!exitConfirmed) {
      throw new Error(
        `${description} Windows process-tree exit confirmation timed out after ${timeoutMs}ms.`,
      );
    }
    return { mode: "force", platform, pid };
  }

  try {
    signalProcess(-pid, "SIGKILL");
  } catch (error) {
    if (!isPosixProcessGroupSignalRace(error)) {
      throw new Error(
        `${description} process-group SIGKILL failed before teardown proof: ${formatError(error)}.`,
      );
    }
  }

  const [exitConfirmed, treeGone] = await Promise.all([
    waitForExit(child, timeoutMs),
    waitForTreeGone({
      isTreeAlive: () => isPosixTreeAlive(pid),
      timeoutMs,
    }),
  ]);

  if (!treeGone) {
    throw new Error(
      `${description} POSIX process-tree confirmation timed out after ${timeoutMs}ms.`,
    );
  }
  if (!exitConfirmed) {
    throw new Error(
      `${description} root process exit confirmation timed out after ${timeoutMs}ms.`,
    );
  }
  return { mode: "force", platform, pid };
}

export async function runDesktopPersistenceSmokeSequence({
  seedFixture,
  armFixture,
  launchDesktop,
  waitForReadiness,
  forceStopDesktop,
  assertFixture,
  cleanupDesktop,
}) {
  let activeLaunch = null;
  let activeLabel = null;
  let primaryFailure = null;

  try {
    await seedFixture();

    for (const label of ["launch A", "launch B"]) {
      activeLabel = label;
      activeLaunch = await launchDesktop(label);
      await waitForReadiness(activeLaunch, label);
      if (label === "launch A") {
        await armFixture();
      }
      await forceStopDesktop(activeLaunch, label);
      activeLaunch = null;
      activeLabel = null;
    }

    await assertFixture();
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure = null;
  if (activeLaunch !== null) {
    try {
      await cleanupDesktop(activeLaunch, activeLabel);
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure !== null && cleanupFailure !== null) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "Desktop persistence smoke failed and active process cleanup also failed.",
    );
  }
  if (primaryFailure !== null) throw primaryFailure;
  if (cleanupFailure !== null) throw cleanupFailure;
}

function supervisePosixDesktopSmokeProcess({
  child,
  observationMs,
  gracefulShutdownMs,
  exitProofMs,
  fatalPatterns,
  signalProcess,
  setTimer,
  clearTimer,
}) {
  return new Promise((resolve) => {
    const hardDeadlineMs = observationMs + gracefulShutdownMs + exitProofMs;
    const failures = [];
    const teardownDiagnostics = [];
    let output = "";
    let observationComplete = false;
    let teardownStarted = false;
    let forceStarted = false;
    let forceAttemptComplete = false;
    let exitObserved = false;
    let closeObserved = false;
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    let observationTimer;
    let forceTimer;
    let hardDeadlineTimer;

    const addFailure = (failure) => {
      if (!failures.includes(failure)) failures.push(failure);
    };
    const addTeardownDiagnostic = (diagnostic) => {
      if (!teardownDiagnostics.includes(diagnostic)) teardownDiagnostics.push(diagnostic);
    };
    const appendOutput = (chunk) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const clearTimers = () => {
      if (observationTimer !== undefined) clearTimer(observationTimer);
      if (forceTimer !== undefined) clearTimer(forceTimer);
      if (hardDeadlineTimer !== undefined) clearTimer(hardDeadlineTimer);
    };
    const guardLateErrorsUntilClose = () => {
      if (closeObserved) return;
      const ignoreLateError = () => {};
      const removeLateErrorGuard = () => {
        child.off("error", ignoreLateError);
      };
      child.on("error", ignoreLateError);
      child.once("close", removeLateErrorGuard);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.stdout?.off("data", appendOutput);
      child.stderr?.off("data", appendOutput);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      guardLateErrorsUntilClose();
      for (const pattern of fatalPatterns) {
        if (output.includes(pattern)) addFailure(pattern);
      }
      resolve({
        ok: failures.length === 0 && teardownDiagnostics.length === 0,
        failures: [...failures],
        output,
        teardownDiagnostics: [...teardownDiagnostics],
      });
    };
    const directKill = (signal) => {
      try {
        const accepted = child.kill(signal);
        if (!accepted) addTeardownDiagnostic("Direct " + signal + " was not accepted.");
        return accepted;
      } catch (error) {
        addTeardownDiagnostic("Direct " + signal + " failed: " + formatError(error));
        return false;
      }
    };
    const signalPosixTree = (signal) => {
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        addTeardownDiagnostic(
          "Cannot signal process group without a valid pid (" + child.pid + ").",
        );
        directKill(signal);
        return false;
      }
      try {
        signalProcess(-child.pid, signal);
        return true;
      } catch (error) {
        if (signal === "SIGKILL" && error?.code === "ESRCH") return true;
        addTeardownDiagnostic("Process-group " + signal + " failed: " + formatError(error));
        directKill(signal);
        return false;
      }
    };
    const maybeFinishAfterClose = () => {
      if (closeObserved && forceAttemptComplete) finish();
    };
    const forceShutdown = () => {
      if (forceStarted) return;
      forceStarted = true;
      signalPosixTree("SIGKILL");
      forceAttemptComplete = true;
      maybeFinishAfterClose();
    };
    const beginTeardown = () => {
      if (teardownStarted || settled) return;
      teardownStarted = true;
      if (observationTimer !== undefined) clearTimer(observationTimer);
      signalPosixTree("SIGTERM");
      forceTimer = setTimer(forceShutdown, gracefulShutdownMs);
    };

    function onError(error) {
      addFailure("Desktop process error: " + formatError(error));
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        finish();
        return;
      }
      beginTeardown();
    }
    function onExit(code, signal) {
      if (exitObserved || settled) return;
      exitObserved = true;
      exitCode = code;
      exitSignal = signal;
      if (!observationComplete && !teardownStarted) {
        addFailure(
          "Desktop exited before the " +
            observationMs +
            "ms observation window completed (" +
            processDescription(code, signal) +
            ").",
        );
        beginTeardown();
      }
    }
    function onClose(code, signal) {
      if (closeObserved || settled) return;
      closeObserved = true;
      if (!exitObserved) {
        exitObserved = true;
        exitCode = code;
        exitSignal = signal;
      }
      if (!observationComplete && !teardownStarted) {
        addFailure(
          "Desktop exited before the " +
            observationMs +
            "ms observation window completed (" +
            processDescription(exitCode, exitSignal) +
            ").",
        );
        beginTeardown();
      }
      maybeFinishAfterClose();
    }

    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    hardDeadlineTimer = setTimer(() => {
      addFailure(
        "Desktop process did not close within the " + hardDeadlineMs + "ms supervision deadline.",
      );
      forceShutdown();
      finish();
    }, hardDeadlineMs);
    observationTimer = setTimer(() => {
      observationComplete = true;
      beginTeardown();
    }, observationMs);
  });
}

function superviseWindowsJobDesktopSmokeProcess({
  child,
  observationMs,
  startupMs,
  teardownMs,
  settlementMs,
  fallbackDelayMs,
  windowsEnvironment,
  windowsJobRunId,
  fatalPatterns,
  killWindowsTree,
  setTimer,
  clearTimer,
  now,
}) {
  return new Promise((resolve) => {
    const failures = [];
    const teardownDiagnostics = [];
    const expectedReadyMarker = WINDOWS_SMOKE_JOB_READY_PREFIX + windowsJobRunId;
    const shutdownToken = WINDOWS_SMOKE_JOB_TERMINATE_PREFIX + windowsJobRunId;
    let output = "";
    let stdoutLineBuffer = "";
    let jobReady = false;
    let observationComplete = false;
    let shutdownRequested = false;
    let shutdownControlSent = false;
    let fallbackStarted = false;
    let fallbackComplete = false;
    let fallbackAbandoned = false;
    let closeObserved = false;
    let closeSettlementComplete = false;
    let forcedCleanupStarted = false;
    let exitObserved = false;
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    let teardownDeadlineAt = null;
    let startupTimer;
    let observationTimer;
    let fallbackTimer;
    let teardownDeadlineTimer;
    let forceCloseProofTimer;
    let closeSettlementTimer;

    const addFailure = (failure) => {
      if (!failures.includes(failure)) failures.push(failure);
    };
    const addTeardownDiagnostic = (diagnostic) => {
      if (!teardownDiagnostics.includes(diagnostic)) teardownDiagnostics.push(diagnostic);
    };
    const clearTimers = () => {
      if (startupTimer !== undefined) clearTimer(startupTimer);
      if (observationTimer !== undefined) clearTimer(observationTimer);
      if (fallbackTimer !== undefined) clearTimer(fallbackTimer);
      if (teardownDeadlineTimer !== undefined) clearTimer(teardownDeadlineTimer);
      if (forceCloseProofTimer !== undefined) clearTimer(forceCloseProofTimer);
      if (closeSettlementTimer !== undefined) clearTimer(closeSettlementTimer);
    };
    const guardLateErrorsUntilClose = () => {
      if (closeObserved) return;
      const ignoreLateError = () => {};
      const removeLateErrorGuard = () => {
        child.off("error", ignoreLateError);
      };
      child.on("error", ignoreLateError);
      child.once("close", removeLateErrorGuard);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.stdin?.off?.("error", onStdinError);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      guardLateErrorsUntilClose();
      for (const pattern of fatalPatterns) {
        if (output.includes(pattern)) addFailure(pattern);
      }
      resolve({
        ok: failures.length === 0 && teardownDiagnostics.length === 0,
        failures: [...failures],
        output,
        teardownDiagnostics: [...teardownDiagnostics],
      });
    };
    const directKill = () => {
      try {
        const accepted = child.kill("SIGKILL");
        if (!accepted) addTeardownDiagnostic("Direct SIGKILL cleanup was not accepted.");
      } catch (error) {
        addTeardownDiagnostic("Direct SIGKILL cleanup failed: " + formatError(error));
      }
    };
    const maybeFinishAfterClose = () => {
      if (!closeObserved || !closeSettlementComplete || settled) return;
      if (fallbackStarted && !fallbackComplete) return;
      finish();
    };
    const startTaskkillFallback = (reason) => {
      if (fallbackStarted || closeObserved || settled) return;
      fallbackStarted = true;
      addTeardownDiagnostic(reason);
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        fallbackComplete = true;
        addTeardownDiagnostic(
          "Cannot run taskkill cleanup without a valid pid (" + child.pid + ").",
        );
        directKill();
        maybeFinishAfterClose();
        return;
      }

      const remainingMs =
        teardownDeadlineAt === null ? teardownMs : Math.max(1, teardownDeadlineAt - now());
      const cleanupBudgetMs = Math.max(1, remainingMs - WINDOWS_SMOKE_FINAL_CLEANUP_RESERVE_MS);
      let cleanupResult;
      try {
        cleanupResult = killWindowsTree(child.pid, {
          timeoutMs: stageTaskkillTimeout(cleanupBudgetMs),
          environment: windowsEnvironment,
        });
      } catch (error) {
        cleanupResult = {
          ok: false,
          diagnostic: "Windows taskkill cleanup failed: " + formatError(error),
        };
      }
      void Promise.resolve(cleanupResult)
        .then((result) => {
          if (settled || fallbackAbandoned) return;
          fallbackComplete = true;
          const normalizedResult =
            typeof result === "boolean"
              ? {
                  ok: result,
                  diagnostic: result ? undefined : "Windows taskkill did not confirm cleanup.",
                }
              : result;
          if (!normalizedResult?.ok) {
            addTeardownDiagnostic(
              normalizedResult?.diagnostic ?? "Windows taskkill returned no cleanup result.",
            );
            directKill();
          }
          maybeFinishAfterClose();
        })
        .catch((error) => {
          if (settled || fallbackAbandoned) return;
          fallbackComplete = true;
          addTeardownDiagnostic("Windows taskkill cleanup failed: " + formatError(error));
          directKill();
          maybeFinishAfterClose();
        });
    };
    const requestJobShutdown = ({ immediateFallback = false, fallbackReason } = {}) => {
      if (shutdownRequested) {
        if (immediateFallback) {
          startTaskkillFallback(
            fallbackReason ?? "Windows Job Object control failed; taskkill cleanup was required.",
          );
        }
        return;
      }
      shutdownRequested = true;
      if (startupTimer !== undefined) clearTimer(startupTimer);
      if (observationTimer !== undefined) clearTimer(observationTimer);
      teardownDeadlineAt = now() + teardownMs;
      teardownDeadlineTimer = setTimer(
        () => {
          forcedCleanupStarted = true;
          addFailure(
            "Windows Job Object wrapper required forced cleanup before the " +
              teardownMs +
              "ms teardown deadline.",
          );
          if (!fallbackStarted) {
            addTeardownDiagnostic(
              "Windows Job Object teardown deadline expired before taskkill cleanup could start.",
            );
          } else if (!fallbackComplete) {
            addTeardownDiagnostic(
              "Windows taskkill cleanup did not settle before the final cleanup reserve expired.",
            );
            fallbackAbandoned = true;
            fallbackComplete = true;
          }
          directKill();
          if (closeObserved && closeSettlementComplete) {
            finish();
            return;
          }
          forceCloseProofTimer = setTimer(() => {
            if (!closeObserved) {
              addTeardownDiagnostic(
                "Direct SIGKILL cleanup did not produce wrapper close proof within the " +
                  WINDOWS_SMOKE_FINAL_CLEANUP_RESERVE_MS +
                  "ms reserve.",
              );
            } else if (!closeSettlementComplete) {
              addTeardownDiagnostic(
                "Windows Job Object wrapper close did not complete the " +
                  settlementMs +
                  "ms descendant settlement interval within the final reserve.",
              );
            }
            finish();
          }, WINDOWS_SMOKE_FINAL_CLEANUP_RESERVE_MS);
        },
        Math.max(1, teardownMs - WINDOWS_SMOKE_FINAL_CLEANUP_RESERVE_MS),
      );

      try {
        if (jobReady) {
          if (typeof child.stdin?.write !== "function") {
            throw new Error("helper stdin is unavailable");
          }
          child.stdin.write(shutdownToken + "\n");
          shutdownControlSent = true;
        }
        if (typeof child.stdin?.end !== "function") {
          throw new Error("helper stdin cannot be closed");
        }
        child.stdin.end();
      } catch (error) {
        addTeardownDiagnostic("Windows Job Object shutdown control failed: " + formatError(error));
        immediateFallback = true;
        fallbackReason =
          "Windows Job Object shutdown control failed; taskkill cleanup was required.";
      }

      if (immediateFallback) {
        startTaskkillFallback(
          fallbackReason ??
            "Windows Job Object initialization failed; taskkill cleanup was required.",
        );
        return;
      }
      fallbackTimer = setTimer(
        () => {
          startTaskkillFallback(
            "Windows Job Object wrapper did not close after the shutdown token; taskkill cleanup was required.",
          );
        },
        Math.min(fallbackDelayMs, Math.max(1, teardownMs - 1)),
      );
    };
    const armObservation = () => {
      if (jobReady || shutdownRequested || settled) return;
      jobReady = true;
      if (startupTimer !== undefined) clearTimer(startupTimer);
      observationTimer = setTimer(() => {
        observationComplete = true;
        requestJobShutdown();
      }, observationMs);
    };
    const inspectStdoutLine = (rawLine) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === expectedReadyMarker) {
        if (jobReady) {
          addFailure("Windows Job Object helper emitted its ready marker more than once.");
          requestJobShutdown({
            immediateFallback: true,
            fallbackReason:
              "Windows Job Object protocol was invalid; taskkill cleanup was required.",
          });
          return;
        }
        armObservation();
        return;
      }
      if (line.startsWith(WINDOWS_SMOKE_JOB_READY_PREFIX)) {
        addFailure("Windows Job Object helper emitted an unexpected ready marker.");
        requestJobShutdown({
          immediateFallback: true,
          fallbackReason: "Windows Job Object protocol was invalid; taskkill cleanup was required.",
        });
      }
    };
    function onStdout(chunk) {
      const text = chunk.toString();
      output += text;
      stdoutLineBuffer += text;
      let newlineIndex = stdoutLineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        inspectStdoutLine(stdoutLineBuffer.slice(0, newlineIndex));
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutLineBuffer.indexOf("\n");
      }
    }
    function onStderr(chunk) {
      output += chunk.toString();
    }
    function onStdinError(error) {
      if (settled) return;
      addTeardownDiagnostic("Windows Job Object shutdown control failed: " + formatError(error));
      requestJobShutdown({
        immediateFallback: true,
        fallbackReason:
          "Windows Job Object shutdown control failed; taskkill cleanup was required.",
      });
    }
    function onError(error) {
      addFailure("Desktop process error: " + formatError(error));
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        finish();
        return;
      }
      requestJobShutdown({
        immediateFallback: true,
        fallbackReason: "Windows Job Object wrapper errored; taskkill cleanup was required.",
      });
    }
    function onExit(code, signal) {
      if (exitObserved || settled) return;
      exitObserved = true;
      exitCode = code;
      exitSignal = signal;
      if (!shutdownRequested) {
        if (!jobReady) {
          addFailure(
            "Windows Job Object helper exited before its ready marker (" +
              processDescription(code, signal) +
              ").",
          );
        } else if (!observationComplete) {
          addFailure(
            "Desktop exited before the " +
              observationMs +
              "ms observation window completed (" +
              processDescription(code, signal) +
              ").",
          );
        }
      }
    }
    function onClose(code, signal) {
      if (closeObserved || settled) return;
      closeObserved = true;
      if (fallbackTimer !== undefined) clearTimer(fallbackTimer);
      if (
        !forcedCleanupStarted &&
        teardownDeadlineTimer !== undefined &&
        (!fallbackStarted || fallbackComplete)
      ) {
        clearTimer(teardownDeadlineTimer);
      }
      if (stdoutLineBuffer !== "") {
        inspectStdoutLine(stdoutLineBuffer);
        stdoutLineBuffer = "";
      }
      if (!exitObserved) {
        exitObserved = true;
        exitCode = code;
        exitSignal = signal;
      }
      if (!jobReady) {
        addFailure(
          "Windows Job Object helper closed before its ready marker (" +
            processDescription(exitCode, exitSignal) +
            ").",
        );
      } else if (!shutdownRequested) {
        addFailure(
          "Desktop exited before the " +
            observationMs +
            "ms observation window completed (" +
            processDescription(exitCode, exitSignal) +
            ").",
        );
      } else if (!shutdownControlSent && observationComplete) {
        addFailure("Windows Job Object helper closed without the shutdown token being sent.");
      }
      closeSettlementTimer = setTimer(() => {
        closeSettlementComplete = true;
        maybeFinishAfterClose();
      }, settlementMs);
      maybeFinishAfterClose();
    }

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdin?.on?.("error", onStdinError);
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);

    if (!WINDOWS_SMOKE_RUN_ID_PATTERN.test(windowsJobRunId ?? "")) {
      addFailure("Windows Job Object supervision requires a UUID run id.");
      requestJobShutdown({
        immediateFallback: true,
        fallbackReason: "Windows Job Object run id was invalid; taskkill cleanup was required.",
      });
      return;
    }
    startupTimer = setTimer(() => {
      addFailure(
        "Windows Job Object helper did not emit its ready marker within the " +
          startupMs +
          "ms startup deadline.",
      );
      requestJobShutdown({
        immediateFallback: true,
        fallbackReason:
          "Windows Job Object helper startup was unconfirmed; taskkill cleanup was required.",
      });
    }, startupMs);
  });
}

export function superviseDesktopSmokeProcess({
  child,
  platform = process.platform,
  observationMs = DESKTOP_SMOKE_OBSERVATION_MS,
  gracefulShutdownMs = DESKTOP_SMOKE_GRACEFUL_SHUTDOWN_MS,
  exitProofMs = DESKTOP_SMOKE_EXIT_PROOF_MS,
  windowsJobStartupMs = DESKTOP_SMOKE_WINDOWS_JOB_STARTUP_MS,
  windowsTeardownMs = DESKTOP_SMOKE_WINDOWS_TEARDOWN_MS,
  windowsSettlementMs = DESKTOP_SMOKE_WINDOWS_SETTLEMENT_MS,
  windowsFallbackDelayMs = WINDOWS_SMOKE_FALLBACK_DELAY_MS,
  windowsEnvironment = process.env,
  windowsJobRunId,
  fatalPatterns = DESKTOP_SMOKE_FATAL_PATTERNS,
  signalProcess = defaultSignalProcess,
  killWindowsTree = defaultKillWindowsTree,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
}) {
  if (platform === "win32") {
    return superviseWindowsJobDesktopSmokeProcess({
      child,
      observationMs,
      startupMs: windowsJobStartupMs,
      teardownMs: windowsTeardownMs,
      settlementMs: windowsSettlementMs,
      fallbackDelayMs: windowsFallbackDelayMs,
      windowsEnvironment,
      windowsJobRunId,
      fatalPatterns,
      killWindowsTree,
      setTimer,
      clearTimer,
      now,
    });
  }
  return supervisePosixDesktopSmokeProcess({
    child,
    observationMs,
    gracefulShutdownMs,
    exitProofMs,
    fatalPatterns,
    signalProcess,
    setTimer,
    clearTimer,
  });
}
