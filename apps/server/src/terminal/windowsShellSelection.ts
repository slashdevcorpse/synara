// FILE: windowsShellSelection.ts
// Purpose: Selects a Windows terminal shell without profiles, shell parsing, or unbounded probes.
// Layer: Terminal infrastructure
// Depends on: Node child-process and filesystem primitives.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs, { type Stats } from "node:fs";
import path from "node:path";

const POWERSHELL_PROBE_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$null = $PSVersionTable.PSVersion; exit 0",
] as const;
const POWERSHELL_INTERACTIVE_ARGS = ["-NoLogo"] as const;
const POWERSHELL_PROBE_TIMEOUT_MS = 1_500;
const POWERSHELL_PROBE_OUTPUT_LIMIT_BYTES = 32 * 1024;
const POWERSHELL_PROBE_TERMINATION_GRACE_MS = 250;
const POWERSHELL_PROBE_REAP_TIMEOUT_MS = 250;
const WINDOWS_EXECUTABLE_VALIDATION_TIMEOUT_MS = 500;
const WINDOWS_EXECUTABLE_EXTENSION_PATTERN = /\.(?:com|exe)$/i;

export interface WindowsExplicitShellChoice {
  readonly executable: string;
  readonly args: readonly string[];
}

export type WindowsTerminalShellResolver = () => WindowsExplicitShellChoice | null | undefined;
export type PosixTerminalShellResolver = () => string | null | undefined;

export type WindowsShellCandidateLabel =
  | "explicit shell"
  | "PowerShell 7"
  | "Windows PowerShell"
  | "configured command shell"
  | "system command shell";

export type WindowsShellFailureCategory =
  | "environment missing"
  | "environment ambiguous"
  | "environment invalid"
  | "invalid path"
  | "not found"
  | "not a regular executable"
  | "validation timed out"
  | "unavailable"
  | "probe timed out"
  | "probe output limit exceeded"
  | "probe failed"
  | "launch target disappeared";

export interface WindowsSelectedShell {
  readonly shell: string;
  readonly args: string[];
  readonly label: WindowsShellCandidateLabel;
  readonly source: "explicit" | "automatic";
}

type ProbeSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type ProbeForceTerminate = (child: ChildProcess) => boolean;

interface PowerShellProbeInput {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnProcess?: ProbeSpawn;
  readonly forceTerminateProcess?: ProbeForceTerminate;
}

interface ExecutableValidationInput {
  readonly executable: string;
  readonly statPath?: (filePath: string) => Promise<Stats>;
}

type PowerShellProbe = (
  executable: string,
  env: NodeJS.ProcessEnv,
) => Promise<WindowsShellFailureCategory | null>;

type ExecutableValidator = (executable: string) => Promise<WindowsShellFailureCategory | null>;

export interface WindowsShellSelectionDependencies {
  readonly probePowerShell?: PowerShellProbe;
  readonly validateExecutable?: ExecutableValidator;
}

export interface WindowsShellSelectionInput {
  readonly resolveExplicit: WindowsTerminalShellResolver;
  readonly env?: NodeJS.ProcessEnv;
  readonly dependencies?: WindowsShellSelectionDependencies;
}

export interface WindowsShellSelectionPlan {
  readonly explicit: boolean;
  next(): Promise<WindowsSelectedShell | null>;
  noteLaunchTargetDisappeared(candidate: WindowsSelectedShell): void;
  exhaustedError(): WindowsShellSelectionError;
}

interface EnvironmentLookupMissing {
  readonly kind: "missing";
}

interface EnvironmentLookupInvalid {
  readonly kind: "ambiguous" | "invalid";
}

interface EnvironmentLookupValue {
  readonly kind: "value";
  readonly value: string;
}

type EnvironmentLookup =
  | EnvironmentLookupMissing
  | EnvironmentLookupInvalid
  | EnvironmentLookupValue;

interface AutomaticCandidate {
  readonly label: Exclude<WindowsShellCandidateLabel, "explicit shell">;
  readonly shell?: string;
  readonly args: readonly string[];
  readonly powerShell: boolean;
  readonly validate: boolean;
  readonly unavailable?: WindowsShellFailureCategory;
}

interface CandidateFailure {
  readonly label: WindowsShellCandidateLabel;
  readonly category: WindowsShellFailureCategory;
}

export class WindowsShellSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsShellSelectionError";
  }
}

function byteLength(chunk: Buffer | string): number {
  return typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
}

function ignoreLateProbeError(): void {}

function probeHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function forceTerminatePowerShellProbe(child: ChildProcess): boolean {
  try {
    return child.kill("SIGKILL");
  } catch {
    return probeHasExited(child);
  }
}

function probeSpawnFailureCategory(error: unknown): WindowsShellFailureCategory {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT"
    ? "not found"
    : "probe failed";
}

async function runPowerShellProbe({
  executable,
  env,
  spawnProcess = spawn,
  forceTerminateProcess = forceTerminatePowerShellProbe,
}: PowerShellProbeInput): Promise<WindowsShellFailureCategory | null> {
  const startedAt = performance.now();

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, POWERSHELL_PROBE_ARGS, {
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(probeSpawnFailureCategory(error));
      return;
    }

    let aggregateOutputBytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onOutput);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const terminate = (): boolean => {
      let signalSent = false;
      try {
        signalSent = child.kill();
      } catch {
        // The process may already have exited between the deadline and cleanup.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      return signalSent || probeHasExited(child);
    };

    const guardLateErrorsUntilClose = (): void => {
      if (probeHasExited(child)) return;
      const releaseLateErrorGuard = (): void => {
        child.off("error", ignoreLateProbeError);
      };
      child.on("error", ignoreLateProbeError);
      child.once("close", releaseLateErrorGuard);
    };

    const finish = (
      category: WindowsShellFailureCategory | null,
      shouldTerminate = false,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();

      if (!shouldTerminate) {
        resolve(category);
        return;
      }

      let completed = false;
      const completeTermination = (): void => {
        if (completed) return;
        completed = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        child.off("close", completeTermination);
        resolve(category);
      };

      const forceTerminateAndReap = (): void => {
        if (completed) return;
        timeout = null;
        try {
          forceTerminateProcess(child);
        } catch {
          // The bounded reap window below still prevents probe selection from hanging.
        }
        if (completed) return;
        timeout = setTimeout(completeTermination, POWERSHELL_PROBE_REAP_TIMEOUT_MS);
      };

      guardLateErrorsUntilClose();
      child.once("close", completeTermination);
      const terminationAccepted = terminate();
      if (completed) return;

      if (!terminationAccepted) {
        forceTerminateAndReap();
        return;
      }

      timeout = setTimeout(forceTerminateAndReap, POWERSHELL_PROBE_TERMINATION_GRACE_MS);
    };

    const onOutput = (chunk: Buffer | string): void => {
      aggregateOutputBytes += byteLength(chunk);
      if (aggregateOutputBytes > POWERSHELL_PROBE_OUTPUT_LIMIT_BYTES) {
        finish("probe output limit exceeded", true);
      }
    };

    const onError = (error: Error): void => {
      finish(probeSpawnFailureCategory(error), true);
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(code === 0 && signal === null ? null : "probe failed");
    };

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", onError);
    child.once("close", onClose);

    const elapsedMs = performance.now() - startedAt;
    timeout = setTimeout(
      () => finish("probe timed out", true),
      Math.max(0, POWERSHELL_PROBE_TIMEOUT_MS - elapsedMs),
    );
  });
}

function isSyntacticallyValidAutomaticExecutable(executable: string): boolean {
  return (
    executable.length > 0 &&
    !executable.includes("\0") &&
    path.win32.isAbsolute(executable) &&
    WINDOWS_EXECUTABLE_EXTENSION_PATTERN.test(executable)
  );
}

async function validateWindowsExecutable({
  executable,
  statPath = fs.promises.stat,
}: ExecutableValidationInput): Promise<WindowsShellFailureCategory | null> {
  if (!isSyntacticallyValidAutomaticExecutable(executable)) {
    return "invalid path";
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const validation = Promise.resolve()
    .then(() => statPath(executable))
    .then<WindowsShellFailureCategory | null>((stats) =>
      stats.isFile() ? null : "not a regular executable",
    )
    .catch<WindowsShellFailureCategory>((error: unknown) =>
      (error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT"
        ? "not found"
        : "unavailable",
    );

  const deadline = new Promise<WindowsShellFailureCategory>((resolve) => {
    timeout = setTimeout(
      () => resolve("validation timed out"),
      WINDOWS_EXECUTABLE_VALIDATION_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([validation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function lookupWindowsEnvironment(env: NodeJS.ProcessEnv, key: string): EnvironmentLookup {
  const matches = Object.entries(env).filter(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
  );
  if (matches.length === 0) return { kind: "missing" };

  const values = new Set(matches.map(([, value]) => value));
  if (values.size > 1) return { kind: "ambiguous" };

  const value = matches[0]?.[1];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return { kind: "invalid" };
  }
  return { kind: "value", value };
}

function environmentFailure(lookup: EnvironmentLookup): WindowsShellFailureCategory {
  switch (lookup.kind) {
    case "missing":
      return "environment missing";
    case "ambiguous":
      return "environment ambiguous";
    case "invalid":
      return "environment invalid";
    case "value":
      throw new Error("Environment value does not represent a failure.");
  }
}

function automaticAbsoluteCandidate(
  label: AutomaticCandidate["label"],
  lookup: EnvironmentLookup,
  append: readonly string[],
  powerShell: boolean,
): AutomaticCandidate {
  if (lookup.kind !== "value") {
    return {
      label,
      args: powerShell ? POWERSHELL_INTERACTIVE_ARGS : [],
      powerShell,
      validate: true,
      unavailable: environmentFailure(lookup),
    };
  }

  if (!path.win32.isAbsolute(lookup.value)) {
    return {
      label,
      args: powerShell ? POWERSHELL_INTERACTIVE_ARGS : [],
      powerShell,
      validate: true,
      unavailable: "environment invalid",
    };
  }

  return {
    label,
    shell: append.length > 0 ? path.win32.join(lookup.value, ...append) : lookup.value,
    args: powerShell ? POWERSHELL_INTERACTIVE_ARGS : [],
    powerShell,
    validate: true,
  };
}

function deduplicateAutomaticAbsoluteCandidates(
  candidates: readonly AutomaticCandidate[],
): AutomaticCandidate[] {
  const seen = new Set<string>();
  const result: AutomaticCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.shell || !path.win32.isAbsolute(candidate.shell)) {
      result.push(candidate);
      continue;
    }
    const key = path.win32.normalize(candidate.shell).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function buildAutomaticCandidates(env: NodeJS.ProcessEnv): AutomaticCandidate[] {
  const systemRoot = lookupWindowsEnvironment(env, "SystemRoot");
  const comSpec = lookupWindowsEnvironment(env, "ComSpec");

  return deduplicateAutomaticAbsoluteCandidates([
    {
      label: "PowerShell 7",
      shell: "pwsh",
      args: POWERSHELL_INTERACTIVE_ARGS,
      powerShell: true,
      validate: false,
    },
    automaticAbsoluteCandidate(
      "Windows PowerShell",
      systemRoot,
      ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
      true,
    ),
    automaticAbsoluteCandidate("configured command shell", comSpec, [], false),
    automaticAbsoluteCandidate("system command shell", systemRoot, ["System32", "cmd.exe"], false),
  ]);
}

function validateExplicitChoice(value: unknown): WindowsSelectedShell {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid");
    }
    const candidate = value as Partial<WindowsExplicitShellChoice>;
    if (
      typeof candidate.executable !== "string" ||
      candidate.executable.length === 0 ||
      candidate.executable.trim().length === 0 ||
      candidate.executable.includes("\0") ||
      !Array.isArray(candidate.args) ||
      !candidate.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
    ) {
      throw new Error("invalid");
    }
    return {
      shell: candidate.executable,
      args: [...candidate.args],
      label: "explicit shell",
      source: "explicit",
    };
  } catch {
    throw new WindowsShellSelectionError("Explicit Windows terminal shell is invalid.");
  }
}

function formatFailures(failures: readonly CandidateFailure[]): string {
  if (failures.length === 0) return "no candidates available";
  return failures.map(({ label, category }) => `${label}: ${category}`).join("; ");
}

class WindowsShellSelectionPlanImpl implements WindowsShellSelectionPlan {
  readonly explicit: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly candidates: readonly AutomaticCandidate[];
  private readonly probePowerShell: PowerShellProbe;
  private readonly validateExecutable: ExecutableValidator;
  private readonly explicitCandidate: WindowsSelectedShell | null;
  private readonly failures: CandidateFailure[] = [];
  private nextIndex = 0;
  private explicitConsumed = false;

  constructor(
    env: NodeJS.ProcessEnv,
    explicitCandidate: WindowsSelectedShell | null,
    dependencies: WindowsShellSelectionDependencies,
  ) {
    this.env = env;
    this.explicitCandidate = explicitCandidate;
    this.explicit = explicitCandidate !== null;
    this.candidates = explicitCandidate ? [] : buildAutomaticCandidates(env);
    this.probePowerShell =
      dependencies.probePowerShell ??
      ((executable, probeEnv) => runPowerShellProbe({ executable, env: probeEnv }));
    this.validateExecutable =
      dependencies.validateExecutable ??
      ((executable) => validateWindowsExecutable({ executable }));
  }

  async next(): Promise<WindowsSelectedShell | null> {
    if (this.explicitCandidate) {
      if (this.explicitConsumed) return null;
      this.explicitConsumed = true;
      return this.explicitCandidate;
    }

    while (this.nextIndex < this.candidates.length) {
      const candidate = this.candidates[this.nextIndex++];
      if (!candidate) continue;
      if (candidate.unavailable || !candidate.shell) {
        this.failures.push({
          label: candidate.label,
          category: candidate.unavailable ?? "unavailable",
        });
        continue;
      }

      if (candidate.validate) {
        let validation: WindowsShellFailureCategory | null;
        try {
          validation = await this.validateExecutable(candidate.shell);
        } catch {
          validation = "unavailable";
        }
        if (validation) {
          this.failures.push({ label: candidate.label, category: validation });
          continue;
        }
      }

      if (candidate.powerShell) {
        let probe: WindowsShellFailureCategory | null;
        try {
          probe = await this.probePowerShell(candidate.shell, this.env);
        } catch {
          probe = "probe failed";
        }
        if (probe) {
          this.failures.push({ label: candidate.label, category: probe });
          continue;
        }
      }

      return {
        shell: candidate.shell,
        args: [...candidate.args],
        label: candidate.label,
        source: "automatic",
      };
    }

    return null;
  }

  noteLaunchTargetDisappeared(candidate: WindowsSelectedShell): void {
    if (candidate.source !== "automatic") return;
    this.failures.push({ label: candidate.label, category: "launch target disappeared" });
  }

  exhaustedError(): WindowsShellSelectionError {
    if (this.explicit) {
      return new WindowsShellSelectionError("Explicit Windows terminal shell failed to start.");
    }
    return new WindowsShellSelectionError(
      `No usable Windows terminal shell was found (${formatFailures(this.failures)}).`,
    );
  }
}

export function createWindowsShellSelection(
  input: WindowsShellSelectionInput,
): WindowsShellSelectionPlan {
  let resolved: ReturnType<WindowsTerminalShellResolver>;
  try {
    resolved = input.resolveExplicit();
  } catch {
    throw new WindowsShellSelectionError("Explicit Windows terminal shell could not be resolved.");
  }

  const explicitCandidate =
    resolved === null || resolved === undefined ? null : validateExplicitChoice(resolved);
  return new WindowsShellSelectionPlanImpl(
    input.env ?? process.env,
    explicitCandidate,
    input.dependencies ?? {},
  );
}

export function explicitWindowsShellLaunchError(): WindowsShellSelectionError {
  return new WindowsShellSelectionError("Explicit Windows terminal shell failed to start.");
}

export function automaticWindowsShellLaunchError(
  candidate: WindowsSelectedShell,
): WindowsShellSelectionError {
  return new WindowsShellSelectionError(
    `Windows terminal shell failed to start (${candidate.label}: launch failed).`,
  );
}

export const __windowsShellSelectionTesting = {
  buildAutomaticCandidates,
  lookupWindowsEnvironment,
  powerShellInteractiveArgs: POWERSHELL_INTERACTIVE_ARGS,
  powerShellProbeArgs: POWERSHELL_PROBE_ARGS,
  powerShellProbeOutputLimitBytes: POWERSHELL_PROBE_OUTPUT_LIMIT_BYTES,
  powerShellProbeReapTimeoutMs: POWERSHELL_PROBE_REAP_TIMEOUT_MS,
  powerShellProbeTerminationGraceMs: POWERSHELL_PROBE_TERMINATION_GRACE_MS,
  powerShellProbeTimeoutMs: POWERSHELL_PROBE_TIMEOUT_MS,
  runPowerShellProbe,
  validateWindowsExecutable,
  windowsExecutableValidationTimeoutMs: WINDOWS_EXECUTABLE_VALIDATION_TIMEOUT_MS,
};
