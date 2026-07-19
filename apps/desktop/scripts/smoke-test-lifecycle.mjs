import { spawn } from "node:child_process";

export const DESKTOP_SMOKE_OBSERVATION_MS = 8_000;
export const DESKTOP_SMOKE_GRACEFUL_SHUTDOWN_MS = 5_000;
export const DESKTOP_SMOKE_EXIT_PROOF_MS = 2_000;

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
]);

export function createDesktopSmokeEnvironment(environment = process.env) {
  const smokeEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() !== "vite_dev_server_url") smokeEnvironment[key] = value;
  }
  smokeEnvironment.ELECTRON_ENABLE_LOGGING = "1";
  return smokeEnvironment;
}

function processDescription(code, signal) {
  return `code=${code ?? "null"}, signal=${signal ?? "null"}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultSignalProcess(pid, signal) {
  process.kill(pid, signal);
}

function defaultKillWindowsTree(pid, { timeoutMs }) {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", "/F"];

    let taskkill;
    try {
      taskkill = spawn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, diagnostic: `Windows taskkill launch failed: ${formatError(error)}` });
      return;
    }

    let settled = false;
    let closeObserved = false;
    let timeout;
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
      if (timeout !== undefined) clearTimeout(timeout);
      taskkill.off("error", onError);
      taskkill.off("close", onClose);
      guardLateErrorsUntilClose();
      resolve(result);
    };
    const onError = (error) => {
      finish({ ok: false, diagnostic: `Windows taskkill failed: ${formatError(error)}` });
    };
    const onClose = (code, signal) => {
      closeObserved = true;
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        diagnostic: `Windows taskkill did not confirm teardown (${processDescription(code, signal)}).`,
      });
    };

    taskkill.on("error", onError);
    taskkill.on("close", onClose);
    timeout = setTimeout(() => {
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The timeout itself is the persistent failure; cleanup is best-effort.
      }
      finish({
        ok: false,
        diagnostic: `Windows taskkill exceeded its ${timeoutMs}ms timeout.`,
      });
    }, timeoutMs);
  });
}

function stageTaskkillTimeout(stageMs) {
  const deadlineMarginMs = Math.min(100, Math.max(1, Math.floor(stageMs / 10)));
  return Math.max(1, stageMs - deadlineMarginMs);
}

export function superviseDesktopSmokeProcess({
  child,
  platform = process.platform,
  observationMs = DESKTOP_SMOKE_OBSERVATION_MS,
  gracefulShutdownMs = DESKTOP_SMOKE_GRACEFUL_SHUTDOWN_MS,
  exitProofMs = DESKTOP_SMOKE_EXIT_PROOF_MS,
  fatalPatterns = DESKTOP_SMOKE_FATAL_PATTERNS,
  signalProcess = defaultSignalProcess,
  killWindowsTree = defaultKillWindowsTree,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  return new Promise((resolve) => {
    const hardDeadlineMs = observationMs + gracefulShutdownMs + exitProofMs;
    const failures = [];
    const teardownDiagnostics = [];
    let output = "";
    let observationComplete = false;
    let teardownStarted = false;
    let forceStarted = false;
    let posixForceAttemptComplete = false;
    let windowsTreeAttemptStarted = false;
    let windowsTreeAttemptComplete = false;
    let windowsTreeConfirmed = false;
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
        if (!accepted) addTeardownDiagnostic(`Direct ${signal} was not accepted.`);
        return accepted;
      } catch (error) {
        addTeardownDiagnostic(`Direct ${signal} failed: ${formatError(error)}`);
        return false;
      }
    };

    const signalPosixTree = (signal) => {
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        addTeardownDiagnostic(`Cannot signal process group without a valid pid (${child.pid}).`);
        directKill(signal);
        return false;
      }

      try {
        signalProcess(-child.pid, signal);
        return true;
      } catch (error) {
        if (signal === "SIGKILL" && error?.code === "ESRCH") {
          return true;
        }
        addTeardownDiagnostic(`Process-group ${signal} failed: ${formatError(error)}`);
        directKill(signal);
        return false;
      }
    };

    const maybeFinishAfterClose = () => {
      if (!closeObserved || settled) return;
      if (platform === "win32") {
        if (windowsTreeConfirmed || windowsTreeAttemptComplete) finish();
        return;
      }
      if (posixForceAttemptComplete) finish();
    };

    const startWindowsTreeKill = () => {
      if (settled || windowsTreeAttemptStarted) return;
      windowsTreeAttemptStarted = true;

      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        addTeardownDiagnostic(`Cannot run taskkill without a valid pid (${child.pid}).`);
        windowsTreeAttemptComplete = true;
        directKill("SIGKILL");
        maybeFinishAfterClose();
        return;
      }

      const timeoutMs = stageTaskkillTimeout(exitProofMs);
      let taskkillResult;
      try {
        taskkillResult = killWindowsTree(child.pid, { timeoutMs });
      } catch (error) {
        taskkillResult = {
          ok: false,
          diagnostic: `Windows taskkill failed: ${formatError(error)}`,
        };
      }

      void Promise.resolve(taskkillResult)
        .then((result) => {
          if (settled) return;
          windowsTreeAttemptComplete = true;
          const normalizedResult =
            typeof result === "boolean"
              ? {
                  ok: result,
                  diagnostic: result
                    ? undefined
                    : "Windows taskkill did not confirm process-tree teardown.",
                }
              : result;

          if (normalizedResult?.ok) {
            windowsTreeConfirmed = true;
            maybeFinishAfterClose();
            return;
          }

          addTeardownDiagnostic(
            normalizedResult?.diagnostic ?? "Windows taskkill returned no teardown confirmation.",
          );
          directKill("SIGKILL");
          maybeFinishAfterClose();
        })
        .catch((error) => {
          if (settled) return;
          windowsTreeAttemptComplete = true;
          addTeardownDiagnostic(`Windows taskkill failed: ${formatError(error)}`);
          directKill("SIGKILL");
          maybeFinishAfterClose();
        });
    };

    const beginGracefulShutdown = () => {
      if (platform === "win32") {
        forceShutdown();
      } else {
        signalPosixTree("SIGTERM");
      }
    };

    const forceShutdown = () => {
      if (forceStarted) return;
      forceStarted = true;

      if (platform !== "win32") {
        signalPosixTree("SIGKILL");
        posixForceAttemptComplete = true;
        maybeFinishAfterClose();
        return;
      }
      startWindowsTreeKill();
    };

    const beginTeardown = () => {
      if (teardownStarted || settled) return;
      teardownStarted = true;
      if (observationTimer !== undefined) clearTimer(observationTimer);

      beginGracefulShutdown();
      if (settled) return;
      if (platform === "win32") return;

      forceTimer = setTimer(() => {
        forceShutdown();
      }, gracefulShutdownMs);
    };

    function onError(error) {
      addFailure(`Desktop process error: ${formatError(error)}`);
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
          `Desktop exited before the ${observationMs}ms observation window completed (${processDescription(code, signal)}).`,
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
          `Desktop exited before the ${observationMs}ms observation window completed (${processDescription(exitCode, exitSignal)}).`,
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
        `Desktop process did not close within the ${hardDeadlineMs}ms supervision deadline.`,
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
