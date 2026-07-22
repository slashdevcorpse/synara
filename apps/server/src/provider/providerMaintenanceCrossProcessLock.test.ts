import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireProviderMaintenanceCrossProcessLock,
  PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME,
  ProviderMaintenanceCrossProcessLockError,
  providerMaintenanceCrossProcessLockDirectory,
  providerMaintenanceCrossProcessLockPath,
  releaseProviderMaintenanceCrossProcessLock,
} from "./providerMaintenanceCrossProcessLock.ts";

const tempDirectories: string[] = [];
const reparsePaths: string[] = [];
const childProcesses = new Set<ChildProcessWithoutNullStreams>();

const childLockOwnerSource = String.raw`
import * as Effect from "effect/Effect";
import {
  acquireProviderMaintenanceCrossProcessLock,
  releaseProviderMaintenanceCrossProcessLock,
} from "./src/provider/providerMaintenanceCrossProcessLock.ts";

const lock = await Effect.runPromise(
  acquireProviderMaintenanceCrossProcessLock(process.env.SYNARA_TEST_LOCK_KEY, {
    canonicalInstallRoot: process.env.SYNARA_TEST_INSTALL_ROOT,
    directoryPath: process.env.SYNARA_TEST_LOCK_DIRECTORY,
  }),
);
process.stdout.write("READY\n");
process.stdin.resume();
await new Promise((resolve) => process.stdin.once("data", resolve));
await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(lock));
`;

interface LockFixture {
  readonly parent: string;
  readonly installRoot: string;
  readonly lockDirectory: string;
}

interface ChildLockOwner {
  readonly child: ChildProcessWithoutNullStreams;
  readonly release: () => Promise<void>;
}

async function makeTempDirectory(prefix = "synara-provider-maintenance-lock-"): Promise<string> {
  const created = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), prefix));
  const directory = await NodeFs.realpath(created);
  tempDirectories.push(directory);
  return directory;
}

async function makeLockFixture(): Promise<LockFixture> {
  const parent = await makeTempDirectory();
  const installRoot = NodePath.join(parent, "cli-install");
  const lockDirectory = NodePath.join(parent, "maintenance-locks");
  await NodeFs.mkdir(installRoot);
  return { parent, installRoot, lockDirectory };
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  childProcesses.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function startChildLockOwner(input: {
  readonly lockKey: string;
  readonly installRoot: string;
  readonly lockDirectory: string;
}): Promise<ChildLockOwner> {
  const child = spawn("bun", ["--eval", childLockOwnerSource], {
    cwd: NodePath.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      SYNARA_TEST_LOCK_KEY: input.lockKey,
      SYNARA_TEST_INSTALL_ROOT: input.installRoot,
      SYNARA_TEST_LOCK_DIRECTORY: input.lockDirectory,
    },
    stdio: "pipe",
    windowsHide: true,
  });
  childProcesses.add(child);
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");

  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Child lock owner did not become ready: ${stderr || stdout}`));
    }, 15_000);
    const onData = (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes("READY\n")) return;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Child lock owner exited before ready (code ${String(code)}, signal ${String(signal)}): ${stderr}`,
        ),
      );
    });
  });

  return {
    child,
    release: async () => {
      const exited = once(child, "exit");
      child.stdin.end("release\n");
      const [code, signal] = await exited;
      childProcesses.delete(child);
      if (code !== 0) {
        throw new Error(
          `Child lock owner failed to release (code ${String(code)}, signal ${String(signal)}): ${stderr}`,
        );
      }
    },
  };
}

afterEach(async () => {
  await Promise.all([...childProcesses].map(terminateChild));
  await Promise.all(
    reparsePaths.splice(0).map((reparsePath) => NodeFs.unlink(reparsePath).catch(() => undefined)),
  );
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFs.rm(directory, { recursive: true, force: true })),
  );
});

describe("provider maintenance cross-process lock", () => {
  it("maps casing-equivalent Windows install roots to the same SHA-256 lock filename", () => {
    const lockDirectory =
      "C:\\Users\\Tester\\AppData\\Local\\Synara\\.super-synara-provider-maintenance-locks";
    const lockKey = "native-codex:update";
    const lowerCasePath = providerMaintenanceCrossProcessLockPath(
      lockKey,
      "c:\\programs\\openai\\codex",
      lockDirectory,
      "win32",
    );
    const mixedCasePath = providerMaintenanceCrossProcessLockPath(
      lockKey,
      "C:\\Programs\\OpenAI\\Codex",
      lockDirectory,
      "win32",
    );

    expect(mixedCasePath).toBe(lowerCasePath);
    expect(NodePath.win32.basename(mixedCasePath)).toMatch(/^[0-9a-f]{64}\.lifecycle-lock$/u);
  });

  it("maps different canonical roots or maintenance keys to different lock filenames", () => {
    const lockDirectory =
      "C:\\Users\\Tester\\AppData\\Local\\Synara\\.super-synara-provider-maintenance-locks";
    const first = providerMaintenanceCrossProcessLockPath(
      "native-codex:update",
      "C:\\Programs\\OpenAI\\Codex",
      lockDirectory,
      "win32",
    );
    const differentRoot = providerMaintenanceCrossProcessLockPath(
      "native-codex:update",
      "D:\\Programs\\OpenAI\\Codex",
      lockDirectory,
      "win32",
    );
    const differentKey = providerMaintenanceCrossProcessLockPath(
      "native-codex:repair",
      "C:\\Programs\\OpenAI\\Codex",
      lockDirectory,
      "win32",
    );

    expect(differentRoot).not.toBe(first);
    expect(differentKey).not.toBe(first);
  });

  it.skipIf(process.platform !== "win32")(
    "stores the default Windows lock outside the install root in stable per-user LocalAppData",
    async () => {
      const parent = await makeTempDirectory();
      const installRoot = NodePath.join(parent, "cli-install");
      const localAppData = NodePath.join(parent, "local-app-data");
      await NodeFs.mkdir(installRoot);
      const directory = providerMaintenanceCrossProcessLockDirectory(installRoot, {
        localAppDataDirectory: localAppData,
      });

      expect(directory).toBe(
        NodePath.join(localAppData, "Synara", PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME),
      );
      expect(NodePath.relative(installRoot, directory)).toMatch(/^\.\./u);

      const acquired = await Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock("native-codex:update", {
          canonicalInstallRoot: installRoot,
          localAppDataDirectory: localAppData,
        }),
      );
      expect(NodePath.dirname(acquired.lockPath)).toBe(await NodeFs.realpath(directory));
      await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(acquired));
    },
  );

  it("excludes a second owner of the same canonical root and releases by token", async () => {
    const { installRoot, lockDirectory } = await makeLockFixture();
    const lockKey = "npm-global:c:/users/test/appdata/roaming/npm";
    const first = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: installRoot,
        directoryPath: lockDirectory,
      }),
    );

    await expect(
      Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock(lockKey, {
          canonicalInstallRoot: installRoot,
          directoryPath: lockDirectory,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(first));
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(first));

    const next = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: installRoot,
        directoryPath: lockDirectory,
      }),
    );
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(next));
    await expect(NodeFs.stat(first.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows the same maintenance key for distinct canonical roots", async () => {
    const { parent, installRoot, lockDirectory } = await makeLockFixture();
    const secondInstallRoot = NodePath.join(parent, "second-cli-install");
    await NodeFs.mkdir(secondInstallRoot);
    const lockKey = "npm-global:update";
    const first = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: installRoot,
        directoryPath: lockDirectory,
      }),
    );
    const second = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: secondInstallRoot,
        directoryPath: lockDirectory,
      }),
    );

    expect(second.lockPath).not.toBe(first.lockPath);
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(second));
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(first));
  });

  it("recovers a well-formed lock whose owner process is dead", async () => {
    const { installRoot, lockDirectory } = await makeLockFixture();
    const lockKey = "homebrew:/opt/homebrew";
    await NodeFs.mkdir(lockDirectory);
    const lockPath = providerMaintenanceCrossProcessLockPath(lockKey, installRoot, lockDirectory);
    await NodeFs.mkdir(lockPath, { mode: 0o700 });
    await NodeFs.writeFile(
      NodePath.join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const acquired = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: installRoot,
        directoryPath: lockDirectory,
      }),
    );
    expect(NodePath.basename(acquired.lockPath)).toBe(NodePath.basename(lockPath));
    expect(acquired.lifecycleLock.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(acquired));
  });

  it("fails closed for an unprovable owner or a potentially reused live PID", async () => {
    const { installRoot, lockDirectory } = await makeLockFixture();
    await NodeFs.mkdir(lockDirectory);

    const malformedLockPath = providerMaintenanceCrossProcessLockPath(
      "native-codex:malformed-owner",
      installRoot,
      lockDirectory,
    );
    await NodeFs.mkdir(malformedLockPath);
    await NodeFs.writeFile(NodePath.join(malformedLockPath, "owner.json"), "{}\n");
    await expect(
      Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock("native-codex:malformed-owner", {
          canonicalInstallRoot: installRoot,
          directoryPath: lockDirectory,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);

    const reusedPidLockPath = providerMaintenanceCrossProcessLockPath(
      "native-codex:potential-pid-reuse",
      installRoot,
      lockDirectory,
    );
    await NodeFs.mkdir(reusedPidLockPath);
    await NodeFs.writeFile(
      NodePath.join(reusedPidLockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token: randomUUID(),
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
    );
    await expect(
      Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock("native-codex:potential-pid-reuse", {
          canonicalInstallRoot: installRoot,
          directoryPath: lockDirectory,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);

    expect(await NodeFs.readFile(NodePath.join(reusedPidLockPath, "owner.json"), "utf8")).toContain(
      '"pid"',
    );
  });

  it.skipIf(process.platform === "win32")(
    "keeps the default POSIX namespace under the canonical target",
    async () => {
      const installRoot = await makeTempDirectory();
      const directory = providerMaintenanceCrossProcessLockDirectory(installRoot);

      expect(directory).toBe(NodePath.join(installRoot, PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME));
      const acquired = await Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock("npm-global:/stable-target", {
          canonicalInstallRoot: installRoot,
        }),
      );
      const canonicalDirectory = await NodeFs.realpath(directory);
      expect(NodePath.dirname(acquired.lockPath)).toBe(canonicalDirectory);
      await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(acquired));
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked POSIX lock root without changing the target permissions",
    async () => {
      const parent = await makeTempDirectory();
      const installRoot = NodePath.join(parent, "cli-install");
      const target = NodePath.join(parent, "unrelated-target");
      const symlink = NodePath.join(parent, "lock-root-link");
      await NodeFs.mkdir(installRoot);
      await NodeFs.mkdir(target, { mode: 0o755 });
      await NodeFs.chmod(target, 0o755);
      await NodeFs.symlink(target, symlink, "dir");

      await expect(
        Effect.runPromise(
          acquireProviderMaintenanceCrossProcessLock("npm-global:/symlink", {
            canonicalInstallRoot: installRoot,
            directoryPath: symlink,
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
      expect((await NodeFs.stat(target)).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a junction in any component or at the final trusted root",
    async () => {
      for (const placement of ["component", "final"] as const) {
        const parent = await makeTempDirectory(`synara-provider-reparse-${placement}-`);
        const installRoot = NodePath.join(parent, "cli-install");
        const target = NodePath.join(parent, "unrelated-target");
        const junction = NodePath.join(parent, "lock-root-link");
        await NodeFs.mkdir(installRoot);
        await NodeFs.mkdir(target);
        await NodeFs.symlink(target, junction, "junction");
        reparsePaths.push(junction);
        const directoryPath =
          placement === "component" ? NodePath.join(junction, "nested") : junction;

        await expect(
          Effect.runPromise(
            acquireProviderMaintenanceCrossProcessLock(`native-codex:${placement}`, {
              canonicalInstallRoot: installRoot,
              directoryPath,
            }),
          ),
        ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
        expect(await NodeFs.readdir(target)).toEqual([]);
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "fails closed when the trusted root is swapped before lifecycle acquisition",
    async () => {
      const { parent, installRoot, lockDirectory } = await makeLockFixture();
      const retiredDirectory = NodePath.join(parent, "retired-lock-root");
      const outsideDirectory = NodePath.join(parent, "outside-target");
      await NodeFs.mkdir(outsideDirectory);

      await expect(
        Effect.runPromise(
          acquireProviderMaintenanceCrossProcessLock("native-codex:swap", {
            canonicalInstallRoot: installRoot,
            directoryPath: lockDirectory,
            dependencies: {
              beforeLifecycleLockAcquire: async () => {
                await NodeFs.rename(lockDirectory, retiredDirectory);
                await NodeFs.symlink(outsideDirectory, lockDirectory, "junction");
                reparsePaths.push(lockDirectory);
              },
            },
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
      expect(await NodeFs.readdir(outsideDirectory)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "fails closed when the final lock target is swapped before lifecycle acquisition",
    async () => {
      const { parent, installRoot, lockDirectory } = await makeLockFixture();
      const lockKey = "native-codex:acquire-target-swap";
      const lockPath = providerMaintenanceCrossProcessLockPath(lockKey, installRoot, lockDirectory);
      const outsideDirectory = NodePath.join(parent, "outside-acquire-target");
      await NodeFs.mkdir(outsideDirectory);

      await expect(
        Effect.runPromise(
          acquireProviderMaintenanceCrossProcessLock(lockKey, {
            canonicalInstallRoot: installRoot,
            directoryPath: lockDirectory,
            dependencies: {
              beforeLifecycleLockAcquire: async () => {
                await NodeFs.symlink(outsideDirectory, lockPath, "junction");
                reparsePaths.push(lockPath);
              },
            },
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
      expect(await NodeFs.readdir(outsideDirectory)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "fails closed when a trusted-root component is swapped before release",
    async () => {
      const { parent, installRoot, lockDirectory } = await makeLockFixture();
      const lock = await Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock("native-codex:release-root-swap", {
          canonicalInstallRoot: installRoot,
          directoryPath: lockDirectory,
        }),
      );
      const retiredDirectory = NodePath.join(parent, "retired-lock-root");
      const outsideDirectory = NodePath.join(parent, "outside-release-root");
      await NodeFs.mkdir(outsideDirectory);
      await NodeFs.rename(lockDirectory, retiredDirectory);
      await NodeFs.symlink(outsideDirectory, lockDirectory, "junction");
      reparsePaths.push(lockDirectory);

      await expect(
        Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(lock)),
      ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
      expect(await NodeFs.readdir(outsideDirectory)).toEqual([]);

      await NodeFs.unlink(lockDirectory);
      await NodeFs.rename(retiredDirectory, lockDirectory);
      await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(lock));
    },
  );

  it.skipIf(process.platform !== "win32")(
    "fails closed when the acquired lock target becomes a junction before release",
    async () => {
      const { parent, installRoot, lockDirectory } = await makeLockFixture();
      const lock = await Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock("native-codex:release-target-junction", {
          canonicalInstallRoot: installRoot,
          directoryPath: lockDirectory,
        }),
      );
      const retiredLockPath = `${lock.lockPath}.retired-test`;
      const outsideDirectory = NodePath.join(parent, "outside-release-target");
      await NodeFs.mkdir(outsideDirectory);
      await NodeFs.rename(lock.lockPath, retiredLockPath);
      await NodeFs.symlink(outsideDirectory, lock.lockPath, "junction");
      reparsePaths.push(lock.lockPath);

      await expect(
        Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(lock)),
      ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
      expect(await NodeFs.readdir(outsideDirectory)).toEqual([]);

      await NodeFs.unlink(lock.lockPath);
      await NodeFs.rename(retiredLockPath, lock.lockPath);
      await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(lock));
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a same-path lock-directory replacement even with copied owner metadata",
    async () => {
      const { installRoot, lockDirectory } = await makeLockFixture();
      const lock = await Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock("native-codex:release-identity-swap", {
          canonicalInstallRoot: installRoot,
          directoryPath: lockDirectory,
        }),
      );
      const retiredLockPath = `${lock.lockPath}.retired-test`;
      await NodeFs.rename(lock.lockPath, retiredLockPath);
      await NodeFs.mkdir(lock.lockPath);
      await NodeFs.copyFile(
        NodePath.join(retiredLockPath, "owner.json"),
        NodePath.join(lock.lockPath, "owner.json"),
      );

      await expect(
        Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(lock)),
      ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
      expect(await NodeFs.readFile(NodePath.join(lock.lockPath, "owner.json"), "utf8")).toContain(
        lock.lifecycleLock.owner.token,
      );

      await NodeFs.rm(lock.lockPath, { recursive: true });
      await NodeFs.rename(retiredLockPath, lock.lockPath);
      await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(lock));
    },
  );

  it("admits only one owner across operating-system processes", async () => {
    const { installRoot, lockDirectory } = await makeLockFixture();
    const lockKey = "native-codex:cross-process";
    const owner = await startChildLockOwner({ lockKey, installRoot, lockDirectory });

    await expect(
      Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock(lockKey, {
          canonicalInstallRoot: installRoot,
          directoryPath: lockDirectory,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
    await owner.release();

    const acquired = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: installRoot,
        directoryPath: lockDirectory,
      }),
    );
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(acquired));
  }, 30_000);

  it("recovers a lock abandoned by a terminated operating-system process", async () => {
    const { installRoot, lockDirectory } = await makeLockFixture();
    const lockKey = "native-codex:abandoned-process";
    const owner = await startChildLockOwner({ lockKey, installRoot, lockDirectory });
    await terminateChild(owner.child);

    const acquired = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: installRoot,
        directoryPath: lockDirectory,
      }),
    );
    expect(acquired.lifecycleLock.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(acquired));
  }, 30_000);
});
