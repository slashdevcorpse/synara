import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __windowsShellSelectionTesting,
  automaticWindowsShellLaunchError,
  createWindowsShellSelection,
  explicitWindowsShellLaunchError,
  WindowsShellSelectionError,
  type WindowsExplicitShellChoice,
  type WindowsSelectedShell,
  type WindowsShellFailureCategory,
  type WindowsShellSelectionDependencies,
} from "./windowsShellSelection";

class FakeProbeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function fakeStats(file: boolean): Stats {
  return { isFile: () => file } as Stats;
}

function successfulDependencies(calls?: {
  probes?: string[];
  validations?: string[];
}): WindowsShellSelectionDependencies {
  return {
    probePowerShell: async (executable) => {
      calls?.probes?.push(executable);
      return null;
    },
    validateExecutable: async (executable) => {
      calls?.validations?.push(executable);
      return null;
    },
  };
}

async function collectCandidates(
  plan: ReturnType<typeof createWindowsShellSelection>,
): Promise<WindowsSelectedShell[]> {
  const candidates: WindowsSelectedShell[] = [];
  for (;;) {
    const candidate = await plan.next();
    if (!candidate) return candidates;
    candidates.push(candidate);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Windows explicit terminal shell selection", () => {
  it("evaluates the structured resolver once and copies the executable and exact arguments", async () => {
    const args = ["", "two words", '"quoted"', "&|<>^%", "日本語"];
    const choice: WindowsExplicitShellChoice = {
      executable: "C:\\Program Files\\Éditeur & Tools\\shell.exe",
      args,
    };
    const resolveExplicit = vi.fn(() => choice);
    const probePowerShell = vi.fn(async () => null);
    const validateExecutable = vi.fn(async () => null);
    const plan = createWindowsShellSelection({
      resolveExplicit,
      dependencies: { probePowerShell, validateExecutable },
    });

    const candidate = await plan.next();

    expect(resolveExplicit).toHaveBeenCalledTimes(1);
    expect(plan.explicit).toBe(true);
    expect(candidate).toEqual({
      shell: choice.executable,
      args,
      label: "explicit shell",
      source: "explicit",
    });
    expect(candidate?.args).not.toBe(args);
    expect(await plan.next()).toBeNull();
    expect(probePowerShell).not.toHaveBeenCalled();
    expect(validateExecutable).not.toHaveBeenCalled();
  });

  it("preserves an explicit command name without resolving or appending arguments", async () => {
    const plan = createWindowsShellSelection({
      resolveExplicit: () => ({ executable: "custom-shell", args: ["--user-flag"] }),
      dependencies: {
        probePowerShell: async () => {
          throw new Error("must not probe");
        },
        validateExecutable: async () => {
          throw new Error("must not validate");
        },
      },
    });

    await expect(plan.next()).resolves.toEqual({
      shell: "custom-shell",
      args: ["--user-flag"],
      label: "explicit shell",
      source: "explicit",
    });
  });

  it("fails closed and sanitizes a throwing resolver", () => {
    const secret = "C:\\Users\\secret\\profile-output";

    expect(() =>
      createWindowsShellSelection({
        resolveExplicit: () => {
          throw new Error(secret);
        },
      }),
    ).toThrowError("Explicit Windows terminal shell could not be resolved.");

    try {
      createWindowsShellSelection({
        resolveExplicit: () => {
          throw new Error(secret);
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsShellSelectionError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([
    ["legacy string", "pwsh"],
    ["empty executable", { executable: "", args: [] }],
    ["blank executable", { executable: "   ", args: [] }],
    ["NUL executable", { executable: "pw\0sh", args: [] }],
    ["missing arguments", { executable: "pwsh" }],
    ["non-array arguments", { executable: "pwsh", args: "-NoLogo" }],
    ["non-string argument", { executable: "pwsh", args: [42] }],
    ["NUL argument", { executable: "pwsh", args: ["bad\0arg"] }],
    ["array value", ["pwsh", []]],
  ])("rejects an invalid explicit choice: %s", (_label, value) => {
    expect(() =>
      createWindowsShellSelection({
        resolveExplicit: () => value as never,
      }),
    ).toThrowError("Explicit Windows terminal shell is invalid.");
  });

  it("uses fixed sanitized launch errors", () => {
    const explicit = explicitWindowsShellLaunchError();
    const automatic = automaticWindowsShellLaunchError({
      shell: "C:\\secret\\powershell.exe",
      args: ["secret-argument"],
      label: "Windows PowerShell",
      source: "automatic",
    });

    expect(explicit.message).toBe("Explicit Windows terminal shell failed to start.");
    expect(automatic.message).toBe(
      "Windows terminal shell failed to start (Windows PowerShell: launch failed).",
    );
    expect(automatic.message).not.toContain("secret");
  });
});

describe("Windows automatic terminal shell selection", () => {
  it("uses the exact lazy order and separates probe arguments from interactive arguments", async () => {
    const calls = { probes: [] as string[], validations: [] as string[] };
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env: {
        SystemRoot: "C:\\Windows",
        ComSpec: "D:\\Command Tools\\custom-cmd.exe",
      },
      dependencies: successfulDependencies(calls),
    });

    const first = await plan.next();
    expect(first).toEqual({
      shell: "pwsh",
      args: ["-NoLogo"],
      label: "PowerShell 7",
      source: "automatic",
    });
    expect(calls).toEqual({ probes: ["pwsh"], validations: [] });

    const remaining = await collectCandidates(plan);
    expect([first, ...remaining]).toEqual([
      {
        shell: "pwsh",
        args: ["-NoLogo"],
        label: "PowerShell 7",
        source: "automatic",
      },
      {
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-NoLogo"],
        label: "Windows PowerShell",
        source: "automatic",
      },
      {
        shell: "D:\\Command Tools\\custom-cmd.exe",
        args: [],
        label: "configured command shell",
        source: "automatic",
      },
      {
        shell: "C:\\Windows\\System32\\cmd.exe",
        args: [],
        label: "system command shell",
        source: "automatic",
      },
    ]);
    expect(calls.probes).toEqual([
      "pwsh",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
    expect(calls.validations).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "D:\\Command Tools\\custom-cmd.exe",
      "C:\\Windows\\System32\\cmd.exe",
    ]);
  });

  it("deduplicates equal absolute command-shell candidates case-insensitively", async () => {
    const plan = createWindowsShellSelection({
      resolveExplicit: () => undefined,
      env: {
        SystemRoot: "C:\\Windows",
        ComSpec: "c:\\WINDOWS\\system32\\CMD.EXE",
      },
      dependencies: successfulDependencies(),
    });

    const candidates = await collectCandidates(plan);

    expect(candidates.map(({ label }) => label)).toEqual([
      "PowerShell 7",
      "Windows PowerShell",
      "configured command shell",
    ]);
  });

  it("records missing environment without inventing absolute fallbacks", async () => {
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env: { PATH: "C:\\secret-path" },
      dependencies: {
        ...successfulDependencies(),
        probePowerShell: async () => "not found",
      },
    });

    expect(await plan.next()).toBeNull();
    const error = plan.exhaustedError();

    expect(error.message).toBe(
      "No usable Windows terminal shell was found (PowerShell 7: not found; Windows PowerShell: environment missing; configured command shell: environment missing; system command shell: environment missing).",
    );
    expect(error.message).not.toContain("secret-path");
  });

  it("rejects conflicting case variants as ambiguous without exposing their values", async () => {
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env: {
        SystemRoot: "C:\\SecretA",
        SYSTEMROOT: "D:\\SecretB",
        ComSpec: "C:\\SecretA\\cmd.exe",
        COMSPEC: "D:\\SecretB\\cmd.exe",
      },
      dependencies: {
        ...successfulDependencies(),
        probePowerShell: async () => "not found",
      },
    });

    expect(await plan.next()).toBeNull();
    const message = plan.exhaustedError().message;
    expect(message).toContain("Windows PowerShell: environment ambiguous");
    expect(message).toContain("configured command shell: environment ambiguous");
    expect(message).toContain("system command shell: environment ambiguous");
    expect(message).not.toMatch(/SecretA|SecretB/);
  });

  it("accepts equivalent case variants deterministically", async () => {
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env: {
        SystemRoot: "C:\\Windows",
        SYSTEMROOT: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      dependencies: successfulDependencies(),
    });

    expect((await collectCandidates(plan)).map(({ label }) => label)).toEqual([
      "PowerShell 7",
      "Windows PowerShell",
      "configured command shell",
    ]);
  });

  it.each([
    ["relative SystemRoot", { SystemRoot: "Windows", ComSpec: "C:\\Windows\\cmd.exe" }],
    ["quoted SystemRoot", { SystemRoot: '"C:\\Windows"', ComSpec: "C:\\Windows\\cmd.exe" }],
    ["empty SystemRoot", { SystemRoot: "", ComSpec: "C:\\Windows\\cmd.exe" }],
    ["NUL SystemRoot", { SystemRoot: "C:\\Win\0dows", ComSpec: "C:\\cmd.exe" }],
    ["relative ComSpec", { SystemRoot: "C:\\Windows", ComSpec: "cmd.exe" }],
    ["non-executable ComSpec", { SystemRoot: "C:\\Windows", ComSpec: "C:\\cmd.txt" }],
  ])("classifies an invalid automatic environment value: %s", async (_label, env) => {
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env,
      dependencies: {
        probePowerShell: async () => "not found",
        validateExecutable: async (executable) =>
          /cmd\.txt$/i.test(executable) ? "invalid path" : "not found",
      },
    });

    expect(await plan.next()).toBeNull();
    expect(plan.exhaustedError().message).not.toContain(Object.values(env).join(""));
  });

  it("preserves spaces, non-ASCII characters, and metacharacters in automatic absolute paths", async () => {
    const calls = { probes: [] as string[], validations: [] as string[] };
    const systemRoot = "C:\\Røøt & ^ (構築)";
    const comSpec = "D:\\Program Files\\命令 & ^\\cmd.exe";
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env: { SystemRoot: systemRoot, ComSpec: comSpec },
      dependencies: successfulDependencies(calls),
    });

    const candidates = await collectCandidates(plan);

    expect(candidates.map(({ shell }) => shell)).toEqual([
      "pwsh",
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      comSpec,
      `${systemRoot}\\System32\\cmd.exe`,
    ]);
    expect(calls.validations).toEqual(candidates.slice(1).map(({ shell }) => shell));
  });

  it("continues after bounded discovery failures and reports only labels and categories", async () => {
    const secret = "C:\\private\\profile.ps1 output SECRET";
    const probeResults: WindowsShellFailureCategory[] = ["probe failed", "probe timed out"];
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env: {
        SystemRoot: "C:\\private-root",
        ComSpec: "D:\\private-command\\cmd.exe",
        SECRET_VALUE: secret,
      },
      dependencies: {
        probePowerShell: async () => {
          const result = probeResults.shift();
          if (!result) throw new Error(secret);
          return result;
        },
        validateExecutable: async (executable) => {
          if (executable.includes("private-command")) throw new Error(secret);
          return "not found";
        },
      },
    });

    expect(await plan.next()).toBeNull();
    const message = plan.exhaustedError().message;

    expect(message).toContain("PowerShell 7: probe failed");
    expect(message).toContain("Windows PowerShell: not found");
    expect(message).toContain("configured command shell: unavailable");
    expect(message).toContain("system command shell: not found");
    expect(message).not.toMatch(/private|profile|SECRET|cmd\.exe/i);
  });

  it("records a PTY disappearance without revealing the selected path", async () => {
    const plan = createWindowsShellSelection({
      resolveExplicit: () => null,
      env: {},
      dependencies: successfulDependencies(),
    });
    const candidate = await plan.next();
    expect(candidate).not.toBeNull();
    if (!candidate) return;

    plan.noteLaunchTargetDisappeared(candidate);
    expect(await plan.next()).toBeNull();

    const message = plan.exhaustedError().message;
    expect(message).toContain("PowerShell 7: launch target disappeared");
    expect(message).not.toContain(candidate.shell);
  });
});

describe("bounded Windows executable validation", () => {
  it("accepts only an absolute existing regular executable", async () => {
    const statPath = vi.fn(async () => fakeStats(true));

    await expect(
      __windowsShellSelectionTesting.validateWindowsExecutable({
        executable: "C:\\Program Files\\工具\\shell.exe",
        statPath,
      }),
    ).resolves.toBeNull();
    expect(statPath).toHaveBeenCalledWith("C:\\Program Files\\工具\\shell.exe");
  });

  it.each([
    ["", "invalid path"],
    ["pwsh", "invalid path"],
    ["C:\\shell.cmd", "invalid path"],
    ["C:\\shell.exe\0secret", "invalid path"],
  ])("rejects %j before touching the filesystem", async (executable, category) => {
    const statPath = vi.fn(async () => fakeStats(true));

    await expect(
      __windowsShellSelectionTesting.validateWindowsExecutable({ executable, statPath }),
    ).resolves.toBe(category);
    expect(statPath).not.toHaveBeenCalled();
  });

  it("distinguishes a directory, a missing file, and an unavailable file", async () => {
    await expect(
      __windowsShellSelectionTesting.validateWindowsExecutable({
        executable: "C:\\directory.exe",
        statPath: async () => fakeStats(false),
      }),
    ).resolves.toBe("not a regular executable");
    await expect(
      __windowsShellSelectionTesting.validateWindowsExecutable({
        executable: "C:\\missing.exe",
        statPath: async () => {
          throw Object.assign(new Error("secret path"), { code: "ENOENT" });
        },
      }),
    ).resolves.toBe("not found");
    await expect(
      __windowsShellSelectionTesting.validateWindowsExecutable({
        executable: "C:\\denied.exe",
        statPath: async () => {
          throw Object.assign(new Error("secret path"), { code: "EACCES" });
        },
      }),
    ).resolves.toBe("unavailable");
  });

  it("bounds a never-settling filesystem validation to 500 ms", async () => {
    vi.useFakeTimers();
    const result = __windowsShellSelectionTesting.validateWindowsExecutable({
      executable: "C:\\hung.exe",
      statPath: async () => new Promise<Stats>(() => undefined),
    });

    await vi.advanceTimersByTimeAsync(
      __windowsShellSelectionTesting.windowsExecutableValidationTimeoutMs,
    );

    await expect(result).resolves.toBe("validation timed out");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounded profile-free PowerShell probes", () => {
  it("uses the exact profile-free command, hidden shell-free launch, ignored stdin, and aggregate cap", async () => {
    const child = new FakeProbeChild();
    let received: { command: string; args: readonly string[]; options: SpawnOptions } | undefined;
    const result = __windowsShellSelectionTesting.runPowerShellProbe({
      executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      env: { PATH: "C:\\safe" },
      spawnProcess: (command, args, options) => {
        received = { command, args, options };
        queueMicrotask(() => child.close(0));
        return child.asChildProcess();
      },
    });

    await expect(result).resolves.toBeNull();
    expect(received).toEqual({
      command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$null = $PSVersionTable.PSVersion; exit 0",
      ],
      options: {
        env: { PATH: "C:\\safe" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });
    expect(received?.args).not.toContain("-File");
    expect(child.killCalls).toBe(0);
  });

  it("enforces the 32 KiB stdout-plus-stderr cap and terminates the child", async () => {
    const child = new FakeProbeChild();
    const result = __windowsShellSelectionTesting.runPowerShellProbe({
      executable: "pwsh",
      env: {},
      spawnProcess: () => child.asChildProcess(),
    });
    const half = __windowsShellSelectionTesting.powerShellProbeOutputLimitBytes / 2;

    child.stdout.write(Buffer.alloc(half));
    child.stderr.write(Buffer.alloc(half + 1));

    await expect(result).resolves.toBe("probe output limit exceeded");
    expect(child.killCalls).toBe(1);
    expect(child.listenerCount("close")).toBe(1);
    expect(child.listenerCount("error")).toBe(1);
    child.close(null, "SIGTERM");
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("enforces the 1,500 ms deadline and terminates the child", async () => {
    vi.useFakeTimers();
    const child = new FakeProbeChild();
    const result = __windowsShellSelectionTesting.runPowerShellProbe({
      executable: "pwsh",
      env: {},
      spawnProcess: () => child.asChildProcess(),
    });

    await vi.advanceTimersByTimeAsync(__windowsShellSelectionTesting.powerShellProbeTimeoutMs);

    await expect(result).resolves.toBe("probe timed out");
    expect(child.killCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    child.close(null, "SIGTERM");
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it.each(["throws", "returns false"] as const)(
    "force-terminates and reaps the child when direct termination %s",
    async (failureMode) => {
      const child = new FakeProbeChild();
      child.kill = () => {
        child.killCalls += 1;
        if (failureMode === "throws") throw new Error("direct termination failed");
        return false;
      };
      let forceTerminationCalls = 0;
      const result = __windowsShellSelectionTesting.runPowerShellProbe({
        executable: "pwsh",
        env: {},
        spawnProcess: () => child.asChildProcess(),
        forceTerminateProcess: () => {
          forceTerminationCalls += 1;
          queueMicrotask(() => child.close(null, "SIGKILL"));
          return true;
        },
      });

      child.stdout.write(
        Buffer.alloc(__windowsShellSelectionTesting.powerShellProbeOutputLimitBytes + 1),
      );

      await expect(result).resolves.toBe("probe output limit exceeded");
      expect(child.killCalls).toBe(1);
      expect(forceTerminationCalls).toBe(1);
      expect(child.signalCode).toBe("SIGKILL");
      expect(child.listenerCount("close")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
    },
  );

  it("bounds fallback reaping when neither termination attempt closes the child", async () => {
    vi.useFakeTimers();
    const child = new FakeProbeChild();
    child.kill = () => {
      child.killCalls += 1;
      return false;
    };
    let forceTerminationCalls = 0;
    const result = __windowsShellSelectionTesting.runPowerShellProbe({
      executable: "pwsh",
      env: {},
      spawnProcess: () => child.asChildProcess(),
      forceTerminateProcess: () => {
        forceTerminationCalls += 1;
        return false;
      },
    });

    child.stderr.write(
      Buffer.alloc(__windowsShellSelectionTesting.powerShellProbeOutputLimitBytes + 1),
    );
    await vi.advanceTimersByTimeAsync(__windowsShellSelectionTesting.powerShellProbeReapTimeoutMs);

    await expect(result).resolves.toBe("probe output limit exceeded");
    expect(child.killCalls).toBe(1);
    expect(forceTerminationCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("close")).toBe(1);
    expect(child.listenerCount("error")).toBe(1);
    child.close(null, "SIGKILL");
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("classifies synchronous and asynchronous spawn failures without leaking messages", async () => {
    await expect(
      __windowsShellSelectionTesting.runPowerShellProbe({
        executable: "pwsh",
        env: {},
        spawnProcess: () => {
          throw Object.assign(new Error("C:\\secret"), { code: "ENOENT" });
        },
      }),
    ).resolves.toBe("not found");

    const child = new FakeProbeChild();
    const result = __windowsShellSelectionTesting.runPowerShellProbe({
      executable: "pwsh",
      env: {},
      spawnProcess: () => child.asChildProcess(),
    });
    child.fail(new Error("C:\\secret-profile-output"));
    child.close(0);

    await expect(result).resolves.toBe("probe failed");
    expect(child.killCalls).toBe(1);
  });

  it.each([
    [1, null],
    [null, "SIGTERM"],
    [null, null],
  ] as const)("rejects abnormal close code=%s signal=%s", async (code, signal) => {
    const child = new FakeProbeChild();
    const result = __windowsShellSelectionTesting.runPowerShellProbe({
      executable: "pwsh",
      env: {},
      spawnProcess: () => child.asChildProcess(),
    });

    child.close(code, signal);

    await expect(result).resolves.toBe("probe failed");
  });

  it.runIf(process.platform === "win32")(
    "selects a real installed Windows shell through a native clean probe",
    async () => {
      const plan = createWindowsShellSelection({
        resolveExplicit: () => null,
        env: process.env,
      });

      const candidate = await plan.next();

      expect(candidate).not.toBeNull();
      expect(candidate?.source).toBe("automatic");
      expect(["PowerShell 7", "Windows PowerShell", "configured command shell"]).toContain(
        candidate?.label,
      );
      if (candidate?.label.includes("PowerShell")) {
        expect(candidate.args).toEqual(["-NoLogo"]);
      } else {
        expect(candidate?.args).toEqual([]);
      }
    },
    10_000,
  );

  it.runIf(process.platform === "win32")(
    "does not execute native PowerShell profile files during discovery",
    async () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-shell-profile-"));
      const markerPath = path.join(homeDir, "profile-loaded.txt");
      const profileBody = "[System.IO.File]::WriteAllText($env:SYNARA_PROFILE_MARKER, 'loaded')";
      for (const profileDirectory of ["PowerShell", "WindowsPowerShell"]) {
        const directory = path.join(homeDir, "Documents", profileDirectory);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "Microsoft.PowerShell_profile.ps1"), profileBody);
      }

      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!["home", "userprofile", "synara_profile_marker"].includes(key.toLowerCase())) {
          env[key] = value;
        }
      }
      env.HOME = homeDir;
      env.USERPROFILE = homeDir;
      env.SYNARA_PROFILE_MARKER = markerPath;

      try {
        const plan = createWindowsShellSelection({
          resolveExplicit: () => null,
          env,
        });

        const candidate = await plan.next();

        expect(candidate?.label).toMatch(/PowerShell/);
        expect(fs.existsSync(markerPath)).toBe(false);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
