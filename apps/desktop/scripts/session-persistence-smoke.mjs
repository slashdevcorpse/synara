import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_PERSISTENCE_SMOKE_READINESS_MS,
  DESKTOP_PERSISTENCE_SMOKE_TREE_CONFIRMATION_MS,
  DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV,
  DESKTOP_SMOKE_FATAL_PATTERNS,
  createDesktopPersistenceSmokeEnvironment,
  desktopPersistenceSmokeUserDataEvidence,
  ensureDesktopPersistenceSmokeHome,
  forceStopDesktopSmokeProcessTree,
  runDesktopPersistenceSmokeSequence,
  validateDesktopPersistenceSmokeEnvironment,
  validateDesktopPersistenceSmokeProfileIsolation,
  waitForDesktopSmokeReadiness,
} from "./smoke-test-lifecycle.mjs";

const FIXTURE_TIMEOUT_MS = 60_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const repositoryRoot = resolve(desktopDir, "../..");
const mainJs = resolve(desktopDir, "dist-electron/main.js");
const fixturePath = resolve(
  repositoryRoot,
  "apps/server/integration/desktopPersistenceSmokeFixture.ts",
);

function requireFile(path, description) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new Error(`${description} is missing at '${path}': ${error.message}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${description} must be a file at '${path}'.`);
  }
}

function appendCommandOutput(state, chunk) {
  state.output += chunk.toString();
}

function commandFailureMessage(description, detail, output) {
  return `${description} ${detail}.${output.length === 0 ? "" : `\nCaptured output:\n${output}`}`;
}

function runBoundedCommand({ command, args, cwd, env, description, timeoutMs }) {
  return new Promise((resolveCommand, rejectCommand) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      rejectCommand(new Error(`${description} could not launch: ${error.message}`));
      return;
    }

    const state = { output: "" };
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The bounded command failure remains authoritative; cleanup is best-effort.
      }
      rejectCommand(
        new Error(
          commandFailureMessage(description, `timed out after ${timeoutMs}ms`, state.output),
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => appendCommandOutput(state, chunk));
    child.stderr?.on("data", (chunk) => appendCommandOutput(state, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCommand(
        new Error(
          commandFailureMessage(
            description,
            `failed to run: ${error.message}`,
            state.output,
          ),
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0 || signal !== null) {
        rejectCommand(
          new Error(
            commandFailureMessage(
              description,
              `failed (code=${code ?? "null"}, signal=${signal ?? "null"})`,
              state.output,
            ),
          ),
        );
        return;
      }
      resolveCommand(state.output);
    });
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function capturedProcessFailure(launch) {
  if (launch.processError !== null) {
    return `${launch.description} process error: ${launch.processError.message}`;
  }
  const fatalPattern = DESKTOP_SMOKE_FATAL_PATTERNS.find((pattern) =>
    launch.output.includes(pattern),
  );
  return fatalPattern === undefined
    ? null
    : `${launch.description} emitted fatal output '${fatalPattern}'.`;
}

function assertHealthyOutput(launch) {
  const failure = capturedProcessFailure(launch);
  if (failure === null) return;
  throw new Error(
    `${failure}${launch.output.length === 0 ? "" : `\nCaptured output:\n${launch.output}`}`,
  );
}

function formatFailure(error) {
  if (error instanceof AggregateError) {
    return [error.stack ?? error.message, ...error.errors.map(formatFailure)].join("\n");
  }
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

async function main() {
  const configuredSynaraHome = validateDesktopPersistenceSmokeEnvironment();
  requireFile(mainJs, "Built desktop main entry");
  requireFile(fixturePath, "Desktop persistence fixture");

  const require = createRequire(import.meta.url);
  const electronBin = require("electron");
  const homePreparation = ensureDesktopPersistenceSmokeHome(configuredSynaraHome);
  const synaraHome = realpathSync(configuredSynaraHome);
  validateDesktopPersistenceSmokeEnvironment({
    environment: { ...process.env, SYNARA_HOME: synaraHome },
  });
  console.log(
    homePreparation.created
      ? `Created isolated persistence-smoke home at ${synaraHome}.`
      : `Using existing isolated persistence-smoke home at ${synaraHome}.`,
  );
  const profileIsolation = createDesktopPersistenceSmokeEnvironment({
    environment: process.env,
    synaraHome,
  });
  const desktopEnvironment = profileIsolation.environment;
  const profileEvidence = desktopPersistenceSmokeUserDataEvidence(profileIsolation.userDataPath);
  const profilePreparation = ensureDesktopPersistenceSmokeHome(profileIsolation.userDataPath);
  const canonicalUserDataPath = realpathSync(profileIsolation.userDataPath);
  validateDesktopPersistenceSmokeProfileIsolation({
    environment: {
      [DESKTOP_PERSISTENCE_SMOKE_USER_DATA_ENV]: canonicalUserDataPath,
    },
    synaraHome,
  });
  console.log(
    profilePreparation.created
      ? `Created isolated Electron userData at ${profileIsolation.userDataPath}.`
      : `Using isolated Electron userData at ${profileIsolation.userDataPath}.`,
  );

  const runFixture = async (mode) => {
    const description = `Desktop persistence fixture ${mode}`;
    const output = await runBoundedCommand({
      command: "bun",
      args: [
        "run",
        "apps/server/integration/desktopPersistenceSmokeFixture.ts",
        mode,
        "--home-dir",
        synaraHome,
      ],
      cwd: repositoryRoot,
      env: desktopEnvironment,
      description,
      timeoutMs: FIXTURE_TIMEOUT_MS,
    });
    const summary = output.trim();
    console.log(summary.length === 0 ? `${description} passed.` : summary);
  };

  const launchDesktop = (description) => {
    console.log(`Launching Electron ${description}...`);
    const child = spawn(electronBin, [mainJs], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: desktopEnvironment,
    });
    const launch = {
      child,
      description,
      output: "",
      processError: null,
    };
    const appendOutput = (chunk) => {
      launch.output += chunk.toString();
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (error) => {
      launch.processError ??= error;
    });
    return launch;
  };

  const waitForReadiness = async (launch) => {
    const readiness = await waitForDesktopSmokeReadiness({
      child: launch.child,
      description: launch.description,
      timeoutMs: DESKTOP_PERSISTENCE_SMOKE_READINESS_MS,
      initialOutput: launch.output,
    });
    if (!launch.output.includes(profileEvidence)) {
      throw new Error(
        `${launch.description} did not prove isolated Electron userData '${profileIsolation.userDataPath}'.`,
      );
    }
    assertHealthyOutput(launch);
    console.log(`${launch.description} startup ready (${readiness.evidence}).`);
  };

  const forceStopDesktop = async (launch) => {
    assertHealthyOutput(launch);
    let result;
    try {
      result = await forceStopDesktopSmokeProcessTree({
        child: launch.child,
        description: launch.description,
        timeoutMs: DESKTOP_PERSISTENCE_SMOKE_TREE_CONFIRMATION_MS,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}${launch.output.length === 0 ? "" : `\nCaptured output:\n${launch.output}`}`,
      );
    }
    assertHealthyOutput(launch);
    console.log(`${launch.description} process tree force-stopped and confirmed (pid=${result.pid}).`);
  };

  const cleanupDesktop = async (launch) => {
    if (!Number.isInteger(launch.child.pid) || launch.child.pid <= 0 || hasExited(launch.child)) {
      return;
    }
    await forceStopDesktopSmokeProcessTree({
      child: launch.child,
      description: `${launch.description} cleanup`,
      timeoutMs: DESKTOP_PERSISTENCE_SMOKE_TREE_CONFIRMATION_MS,
    });
  };

  await runDesktopPersistenceSmokeSequence({
    seedFixture: () => runFixture("seed"),
    armFixture: () => runFixture("arm"),
    launchDesktop,
    waitForReadiness,
    forceStopDesktop,
    assertFixture: () => runFixture("assert"),
    cleanupDesktop,
  });

  console.log("Desktop two-launch session persistence smoke passed.");
}

try {
  await main();
} catch (error) {
  console.error("\nDesktop two-launch session persistence smoke failed:");
  console.error(formatFailure(error));
  process.exitCode = 1;
}
