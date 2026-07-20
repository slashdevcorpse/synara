import { spawn } from "node:child_process";
import { win32 } from "node:path";

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

function resolveWindowsSystemRoot(environment) {
  const systemRoot =
    environmentValueCaseInsensitive(environment, "SystemRoot") ||
    environmentValueCaseInsensitive(environment, "WINDIR");
  if (
    typeof systemRoot !== "string" ||
    systemRoot === "" ||
    systemRoot.trim() !== systemRoot ||
    /[\0\r\n]/.test(systemRoot) ||
    !win32.isAbsolute(systemRoot)
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
  if (!win32.isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
    throw new Error("Windows smoke executable path must be absolute and clean.");
  }
  if (!win32.isAbsolute(helperPath) || /[\0\r\n]/.test(helperPath)) {
    throw new Error("Windows smoke Job Object helper path must be absolute and clean.");
  }
  if (!win32.isAbsolute(workingDirectory) || /[\0\r\n]/.test(workingDirectory)) {
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

function defaultSignalProcess(pid, signal) {
  process.kill(pid, signal);
}

function defaultKillWindowsTree(pid, { timeoutMs }) {
  return new Promise((resolve) => {
    let taskkillPath;
    try {
      taskkillPath = win32.join(resolveWindowsSystemRoot(process.env), "System32", "taskkill.exe");
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
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, diagnostic: "Windows taskkill launch failed: " + formatError(error) });
      return;
    }

    let settled = false;
    let closeObserved = false;
    let operationTimeout;
    let closeProofTimeout;
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
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        diagnostic:
          "Windows taskkill did not confirm cleanup (" + processDescription(code, signal) + ").",
      });
    };

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
