import { randomUUID } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireProviderMaintenanceCrossProcessLock,
  ProviderMaintenanceCrossProcessLockError,
  providerMaintenanceCrossProcessLockDirectory,
  providerMaintenanceCrossProcessLockPath,
  releaseProviderMaintenanceCrossProcessLock,
} from "./providerMaintenanceCrossProcessLock.ts";

const tempDirectories: string[] = [];

async function makeLockDirectory(): Promise<string> {
  const directory = await NodeFs.mkdtemp(
    NodePath.join(NodeOs.tmpdir(), "synara-provider-maintenance-lock-"),
  );
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFs.rm(directory, { recursive: true, force: true })),
  );
});

describe("provider maintenance cross-process lock", () => {
  it("excludes a second owner of the same canonical root and releases by token", async () => {
    const directoryPath = await makeLockDirectory();
    const lockKey = "npm-global:c:/users/test/appdata/roaming/npm";
    const first = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: directoryPath,
        directoryPath,
      }),
    );

    await expect(
      Effect.runPromise(
        acquireProviderMaintenanceCrossProcessLock(lockKey, {
          canonicalInstallRoot: directoryPath,
          directoryPath,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(first));

    const next = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock(lockKey, {
        canonicalInstallRoot: directoryPath,
        directoryPath,
      }),
    );
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(next));
    await expect(NodeFs.stat(first.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows distinct canonical roots to proceed independently", async () => {
    const directoryPath = await makeLockDirectory();
    const first = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock("npm-global:/first", {
        canonicalInstallRoot: directoryPath,
        directoryPath,
      }),
    );
    const second = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock("npm-global:/second", {
        canonicalInstallRoot: directoryPath,
        directoryPath,
      }),
    );

    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(second));
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(first));
  });

  it("recovers a well-formed lock whose owner process is dead", async () => {
    const directoryPath = await makeLockDirectory();
    const lockKey = "homebrew:/opt/homebrew";
    const lockPath = providerMaintenanceCrossProcessLockPath(lockKey, directoryPath);
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
        canonicalInstallRoot: directoryPath,
        directoryPath,
      }),
    );
    expect(NodePath.basename(acquired.lockPath)).toBe(NodePath.basename(lockPath));
    expect(acquired.lifecycleLock.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(acquired));
  });

  it("creates the default namespace under the canonical target instead of TEMP", async () => {
    const installRoot = await makeLockDirectory();
    const directory = providerMaintenanceCrossProcessLockDirectory(installRoot);

    expect(directory).toBe(NodePath.join(installRoot, ".super-synara-provider-maintenance-locks"));
    const acquired = await Effect.runPromise(
      acquireProviderMaintenanceCrossProcessLock("npm-global:/stable-target", {
        canonicalInstallRoot: installRoot,
      }),
    );
    const canonicalDirectory = await NodeFs.realpath(directory);
    expect(NodePath.dirname(acquired.lockPath)).toBe(canonicalDirectory);
    await Effect.runPromise(releaseProviderMaintenanceCrossProcessLock(acquired));
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked lock root without changing the target permissions",
    async () => {
      const parent = await makeLockDirectory();
      const target = NodePath.join(parent, "unrelated-target");
      const symlink = NodePath.join(parent, "lock-root-link");
      await NodeFs.mkdir(target, { mode: 0o755 });
      await NodeFs.chmod(target, 0o755);
      await NodeFs.symlink(target, symlink, "dir");

      await expect(
        Effect.runPromise(
          acquireProviderMaintenanceCrossProcessLock("npm-global:/symlink", {
            canonicalInstallRoot: parent,
            directoryPath: symlink,
          }),
        ),
      ).rejects.toBeInstanceOf(ProviderMaintenanceCrossProcessLockError);
      expect((await NodeFs.stat(target)).mode & 0o777).toBe(0o755);
    },
  );
});
