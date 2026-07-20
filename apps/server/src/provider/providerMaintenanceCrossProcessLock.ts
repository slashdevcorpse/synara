import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  acquireDatabaseLifecycleLock,
  type DatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "../persistence/DatabaseLifecycleLock.ts";
import { PRIVATE_DIRECTORY_MODE } from "../privatePathPermissions.ts";

export const PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME =
  ".super-synara-provider-maintenance-locks";

export interface ProviderMaintenanceCrossProcessLock {
  readonly lockKey: string;
  readonly lockPath: string;
  readonly lifecycleLock: DatabaseLifecycleLock;
}

export class ProviderMaintenanceCrossProcessLockError extends Error {
  readonly _tag = "ProviderMaintenanceCrossProcessLockError";

  constructor(
    readonly lockKey: string,
    readonly lockPath: string,
    detail: string,
  ) {
    super(`Provider maintenance target is locked for ${lockKey}: ${detail} (${lockPath})`);
    this.name = "ProviderMaintenanceCrossProcessLockError";
  }
}

function maintenanceLockTargetPath(lockKey: string, directoryPath: string): string {
  const digest = createHash("sha256").update(lockKey, "utf8").digest("hex");
  return NodePath.join(directoryPath, digest);
}

export function providerMaintenanceCrossProcessLockPath(
  lockKey: string,
  directoryPath: string,
): string {
  return `${maintenanceLockTargetPath(lockKey, directoryPath)}.lifecycle-lock`;
}

export function providerMaintenanceCrossProcessLockDirectory(
  canonicalInstallRoot: string,
): string {
  if (!NodePath.isAbsolute(canonicalInstallRoot)) {
    throw new Error(`Provider maintenance install root must be absolute: ${canonicalInstallRoot}`);
  }
  return NodePath.join(canonicalInstallRoot, PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME);
}

async function prepareLockDirectory(directoryPath: string): Promise<string> {
  await NodeFs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = await NodeFs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Lock root is not a real directory: ${directoryPath}`);
  }
  if (process.platform !== "win32") {
    await NodeFs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
  return NodeFs.realpath(directoryPath);
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function acquireProviderMaintenanceCrossProcessLock(
  lockKey: string,
  options: {
    readonly canonicalInstallRoot: string;
    readonly directoryPath?: string;
  },
) {
  const requestedDirectory =
    options.directoryPath ??
    providerMaintenanceCrossProcessLockDirectory(options.canonicalInstallRoot);
  return Effect.tryPromise({
    try: () => prepareLockDirectory(requestedDirectory),
    catch: (cause) =>
      new ProviderMaintenanceCrossProcessLockError(
        lockKey,
        providerMaintenanceCrossProcessLockPath(lockKey, requestedDirectory),
        errorDetail(cause),
      ),
  }).pipe(
    Effect.flatMap((canonicalDirectory) => {
      const targetPath = maintenanceLockTargetPath(lockKey, canonicalDirectory);
      return acquireDatabaseLifecycleLock(targetPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderMaintenanceCrossProcessLockError(
              lockKey,
              `${targetPath}.lifecycle-lock`,
              errorDetail(cause),
            ),
        ),
        Effect.map(
          (lifecycleLock): ProviderMaintenanceCrossProcessLock => ({
            lockKey,
            lockPath: lifecycleLock.lockPath,
            lifecycleLock,
          }),
        ),
      );
    }),
  );
}

export function releaseProviderMaintenanceCrossProcessLock(
  lock: ProviderMaintenanceCrossProcessLock,
) {
  return releaseDatabaseLifecycleLock(lock.lifecycleLock).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderMaintenanceCrossProcessLockError(
          lock.lockKey,
          lock.lockPath,
          errorDetail(cause),
        ),
    ),
  );
}

export function withProviderMaintenanceCrossProcessLock<A, E, R>(
  lockKey: string,
  use: Effect.Effect<A, E, R>,
  options: {
    readonly canonicalInstallRoot: string;
    readonly directoryPath?: string;
  },
) {
  return Effect.acquireUseRelease(
    acquireProviderMaintenanceCrossProcessLock(lockKey, options),
    () => use,
    releaseProviderMaintenanceCrossProcessLock,
  );
}
