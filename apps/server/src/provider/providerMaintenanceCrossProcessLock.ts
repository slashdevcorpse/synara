import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  acquireDatabaseLifecycleLock,
  type DatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "../persistence/DatabaseLifecycleLock.ts";
import { PRIVATE_DIRECTORY_MODE } from "../privatePathPermissions.ts";
import { isLexicallyContainedPath } from "../workspace/realPathContainment.ts";

export const PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME = ".super-synara-provider-maintenance-locks";
const WINDOWS_PROVIDER_MAINTENANCE_APPLICATION_DIRECTORY_NAME = "Synara";

type PlatformPath = typeof NodePath.posix | typeof NodePath.win32;

interface WindowsDirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface PreparedLockDirectory {
  readonly canonicalPath: string;
  readonly windowsIdentity: WindowsDirectoryIdentity | null;
}

/** Internal synchronization seam used by deterministic path-swap tests. */
interface ProviderMaintenanceCrossProcessLockDependencies {
  readonly beforeLifecycleLockAcquire?: () => Promise<void>;
}

export interface ProviderMaintenanceCrossProcessLock {
  readonly lockKey: string;
  readonly lockPath: string;
  readonly lifecycleLock: DatabaseLifecycleLock;
  readonly preparedDirectory: PreparedLockDirectory;
  readonly acquiredWindowsIdentity: WindowsDirectoryIdentity | null;
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

function pathImplementation(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function normalizedCanonicalInstallRoot(
  canonicalInstallRoot: string,
  platform: NodeJS.Platform,
): string {
  const pathApi = pathImplementation(platform);
  if (!pathApi.isAbsolute(canonicalInstallRoot)) {
    throw new Error(`Provider maintenance install root must be absolute: ${canonicalInstallRoot}`);
  }
  const normalized = pathApi.resolve(canonicalInstallRoot).normalize("NFC");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function maintenanceLockTargetPath(
  lockKey: string,
  canonicalInstallRoot: string,
  directoryPath: string,
  platform: NodeJS.Platform,
): string {
  const rootIdentity = normalizedCanonicalInstallRoot(canonicalInstallRoot, platform);
  const digest = createHash("sha256")
    .update(JSON.stringify([rootIdentity, lockKey]), "utf8")
    .digest("hex");
  return pathImplementation(platform).join(directoryPath, digest);
}

export function providerMaintenanceCrossProcessLockPath(
  lockKey: string,
  canonicalInstallRoot: string,
  directoryPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${maintenanceLockTargetPath(
    lockKey,
    canonicalInstallRoot,
    directoryPath,
    platform,
  )}.lifecycle-lock`;
}

export function providerMaintenanceCrossProcessLockDirectory(
  canonicalInstallRoot: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly localAppDataDirectory?: string;
    readonly homeDirectory?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const pathApi = pathImplementation(platform);
  normalizedCanonicalInstallRoot(canonicalInstallRoot, platform);

  if (platform !== "win32") {
    return pathApi.join(canonicalInstallRoot, PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME);
  }

  const configuredLocalAppData = options.localAppDataDirectory ?? process.env.LOCALAPPDATA?.trim();
  const localAppData =
    configuredLocalAppData ||
    NodePath.win32.join(options.homeDirectory ?? NodeOs.homedir(), "AppData", "Local");
  if (!NodePath.win32.isAbsolute(localAppData)) {
    throw new Error(`Windows LocalAppData directory must be absolute: ${localAppData}`);
  }
  return NodePath.win32.join(
    localAppData,
    WINDOWS_PROVIDER_MAINTENANCE_APPLICATION_DIRECTORY_NAME,
    PROVIDER_MAINTENANCE_LOCK_DIRECTORY_NAME,
  );
}

function errnoCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

function normalizeWindowsIdentityPath(pathValue: string): string {
  // Bun's Windows realpath currently spells a drive root as `C:`. Treat that
  // runtime spelling as the same identity as the absolute `C:\\` root.
  const absolutePath = /^[a-z]:$/iu.test(pathValue) ? `${pathValue}\\` : pathValue;
  return NodePath.win32.resolve(absolutePath).normalize("NFC").toLowerCase();
}

function windowsPathComponents(directoryPath: string): ReadonlyArray<string> {
  const resolvedDirectory = NodePath.win32.resolve(directoryPath);
  const root = NodePath.win32.parse(resolvedDirectory).root;
  const relativeDirectory = NodePath.win32.relative(root, resolvedDirectory);
  const components = relativeDirectory === "" ? [] : relativeDirectory.split(NodePath.win32.sep);
  const paths = [root];
  let currentPath = root;
  for (const component of components) {
    currentPath = NodePath.win32.join(currentPath, component);
    paths.push(currentPath);
  }
  return paths;
}

async function inspectWindowsDirectoryComponent(directoryPath: string): Promise<void> {
  const pathStat = await NodeFs.lstat(directoryPath, { bigint: true });
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(
      `Lock root contains a junction, reparse point, or non-directory: ${directoryPath}`,
    );
  }

  const canonicalPath = await NodeFs.realpath(directoryPath);
  if (normalizeWindowsIdentityPath(canonicalPath) !== normalizeWindowsIdentityPath(directoryPath)) {
    throw new Error(`Lock root contains a resolved path alias or reparse point: ${directoryPath}`);
  }
}

async function inspectWindowsDirectoryIdentity(
  directoryPath: string,
): Promise<WindowsDirectoryIdentity> {
  const canonicalPath = await NodeFs.realpath(directoryPath);
  const handle = await NodeFs.open(directoryPath, fsConstants.O_RDONLY);
  try {
    const [openedStat, pathStat, verifiedCanonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      NodeFs.lstat(directoryPath, { bigint: true }),
      NodeFs.realpath(directoryPath),
    ]);
    if (
      !openedStat.isDirectory() ||
      !pathStat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      normalizeWindowsIdentityPath(canonicalPath) !==
        normalizeWindowsIdentityPath(verifiedCanonicalPath) ||
      normalizeWindowsIdentityPath(canonicalPath) !== normalizeWindowsIdentityPath(directoryPath)
    ) {
      throw new Error(`Lock root identity changed while it was inspected: ${directoryPath}`);
    }
    return {
      canonicalPath,
      device: openedStat.dev,
      inode: openedStat.ino,
    };
  } finally {
    await handle.close();
  }
}

async function prepareWindowsLockDirectory(
  directoryPath: string,
): Promise<WindowsDirectoryIdentity> {
  if (!NodePath.win32.isAbsolute(directoryPath)) {
    throw new Error(`Windows provider maintenance lock root must be absolute: ${directoryPath}`);
  }

  for (const componentPath of windowsPathComponents(directoryPath)) {
    try {
      await inspectWindowsDirectoryComponent(componentPath);
      continue;
    } catch (cause) {
      if (
        errnoCode(cause) !== "ENOENT" ||
        componentPath === NodePath.win32.parse(componentPath).root
      ) {
        throw cause;
      }
    }

    try {
      await NodeFs.mkdir(componentPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (cause) {
      if (errnoCode(cause) !== "EEXIST") throw cause;
    }
    await inspectWindowsDirectoryComponent(componentPath);
  }

  return inspectWindowsDirectoryIdentity(directoryPath);
}

async function verifyWindowsLockDirectory(expected: WindowsDirectoryIdentity): Promise<void> {
  for (const componentPath of windowsPathComponents(expected.canonicalPath)) {
    await inspectWindowsDirectoryComponent(componentPath);
  }
  const current = await inspectWindowsDirectoryIdentity(expected.canonicalPath);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    normalizeWindowsIdentityPath(current.canonicalPath) !==
      normalizeWindowsIdentityPath(expected.canonicalPath)
  ) {
    throw new Error(`Lock root identity changed after validation: ${expected.canonicalPath}`);
  }
}

function assertWindowsLockDirectoryOutsideInstallRoot(
  directoryPath: string,
  canonicalInstallRoot: string,
): void {
  if (isLexicallyContainedPath(canonicalInstallRoot, directoryPath, NodePath.win32)) {
    throw new Error(
      `Windows provider maintenance lock root must be outside the CLI install root: ${directoryPath}`,
    );
  }
}

async function prepareLockDirectory(
  directoryPath: string,
  canonicalInstallRoot: string,
): Promise<PreparedLockDirectory> {
  if (process.platform === "win32") {
    assertWindowsLockDirectoryOutsideInstallRoot(directoryPath, canonicalInstallRoot);
    const windowsIdentity = await prepareWindowsLockDirectory(directoryPath);
    return { canonicalPath: windowsIdentity.canonicalPath, windowsIdentity };
  }

  await NodeFs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const handle = await NodeFs.open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory()) {
      throw new Error(`Lock root is not a real directory: ${directoryPath}`);
    }
    await handle.chmod(PRIVATE_DIRECTORY_MODE);

    const canonicalDirectory = await NodeFs.realpath(directoryPath);
    const canonicalStat = await NodeFs.lstat(canonicalDirectory);
    if (
      !canonicalStat.isDirectory() ||
      canonicalStat.isSymbolicLink() ||
      canonicalStat.dev !== openedStat.dev ||
      canonicalStat.ino !== openedStat.ino
    ) {
      throw new Error(`Lock root identity changed while it was prepared: ${directoryPath}`);
    }
    return { canonicalPath: canonicalDirectory, windowsIdentity: null };
  } finally {
    await handle.close();
  }
}

async function verifyPreparedDirectory(preparedDirectory: PreparedLockDirectory): Promise<void> {
  if (preparedDirectory.windowsIdentity) {
    await verifyWindowsLockDirectory(preparedDirectory.windowsIdentity);
  }
}

async function verifyExistingWindowsLockTarget(
  lockPath: string,
  preparedDirectory: PreparedLockDirectory,
): Promise<void> {
  if (!preparedDirectory.windowsIdentity) return;
  await verifyWindowsLockDirectory(preparedDirectory.windowsIdentity);

  try {
    await NodeFs.lstat(lockPath);
  } catch (cause) {
    if (errnoCode(cause) === "ENOENT") return;
    throw cause;
  }

  for (const componentPath of windowsPathComponents(lockPath)) {
    await inspectWindowsDirectoryComponent(componentPath);
  }
}

function assertSameWindowsDirectoryIdentity(
  current: WindowsDirectoryIdentity,
  expected: WindowsDirectoryIdentity,
  detail: string,
): void {
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    normalizeWindowsIdentityPath(current.canonicalPath) !==
      normalizeWindowsIdentityPath(expected.canonicalPath)
  ) {
    throw new Error(detail);
  }
}

async function verifyAcquiredWindowsLock(
  lifecycleLock: DatabaseLifecycleLock,
  preparedDirectory: PreparedLockDirectory,
  expectedTargetPath: string,
  expectedIdentity?: WindowsDirectoryIdentity,
): Promise<WindowsDirectoryIdentity | null> {
  if (!preparedDirectory.windowsIdentity) return null;
  await verifyWindowsLockDirectory(preparedDirectory.windowsIdentity);

  const expectedLockPath = `${expectedTargetPath}.lifecycle-lock`;
  if (
    normalizeWindowsIdentityPath(lifecycleLock.lockPath) !==
      normalizeWindowsIdentityPath(expectedLockPath) ||
    !isLexicallyContainedPath(
      preparedDirectory.canonicalPath,
      lifecycleLock.lockPath,
      NodePath.win32,
    )
  ) {
    throw new Error(`Acquired lock escaped its trusted root: ${lifecycleLock.lockPath}`);
  }

  for (const componentPath of windowsPathComponents(lifecycleLock.lockPath)) {
    await inspectWindowsDirectoryComponent(componentPath);
  }

  const currentIdentity = await inspectWindowsDirectoryIdentity(lifecycleLock.lockPath);
  if (expectedIdentity) {
    assertSameWindowsDirectoryIdentity(
      currentIdentity,
      expectedIdentity,
      `Acquired lock identity changed before release: ${lifecycleLock.lockPath}`,
    );
  }
  return currentIdentity;
}

async function safelyReleaseRejectedAcquisition(
  lifecycleLock: DatabaseLifecycleLock,
  preparedDirectory: PreparedLockDirectory,
  expectedTargetPath: string,
): Promise<void> {
  try {
    await verifyAcquiredWindowsLock(lifecycleLock, preparedDirectory, expectedTargetPath);
  } catch {
    // A changed namespace cannot be cleaned up safely through a path-based API.
    return;
  }
  await Effect.runPromise(releaseDatabaseLifecycleLock(lifecycleLock)).catch(() => undefined);
}

const releasedProviderMaintenanceLocks = new WeakSet<ProviderMaintenanceCrossProcessLock>();

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function acquireProviderMaintenanceCrossProcessLock(
  lockKey: string,
  options: {
    readonly canonicalInstallRoot: string;
    readonly directoryPath?: string;
    readonly localAppDataDirectory?: string;
    readonly dependencies?: ProviderMaintenanceCrossProcessLockDependencies;
  },
) {
  const requestedDirectory =
    options.directoryPath ??
    providerMaintenanceCrossProcessLockDirectory(
      options.canonicalInstallRoot,
      options.localAppDataDirectory ? { localAppDataDirectory: options.localAppDataDirectory } : {},
    );
  const requestedLockPath = providerMaintenanceCrossProcessLockPath(
    lockKey,
    options.canonicalInstallRoot,
    requestedDirectory,
  );

  return Effect.tryPromise({
    try: async (): Promise<ProviderMaintenanceCrossProcessLock> => {
      const preparedDirectory = await prepareLockDirectory(
        requestedDirectory,
        options.canonicalInstallRoot,
      );
      await options.dependencies?.beforeLifecycleLockAcquire?.();

      // Node does not expose Windows handle-relative mkdir/rename. Revalidate immediately
      // before the existing lifecycle-lock acquisition and again after it so a detected
      // same-user namespace swap fails closed instead of starting provider maintenance.
      await verifyPreparedDirectory(preparedDirectory);
      const targetPath = maintenanceLockTargetPath(
        lockKey,
        options.canonicalInstallRoot,
        preparedDirectory.canonicalPath,
        process.platform,
      );
      await verifyExistingWindowsLockTarget(`${targetPath}.lifecycle-lock`, preparedDirectory);
      const lifecycleLock = await Effect.runPromise(acquireDatabaseLifecycleLock(targetPath));
      let acquiredWindowsIdentity: WindowsDirectoryIdentity | null;
      try {
        acquiredWindowsIdentity = await verifyAcquiredWindowsLock(
          lifecycleLock,
          preparedDirectory,
          targetPath,
        );
      } catch (cause) {
        await safelyReleaseRejectedAcquisition(lifecycleLock, preparedDirectory, targetPath);
        throw cause;
      }

      return {
        lockKey,
        lockPath: lifecycleLock.lockPath,
        lifecycleLock,
        preparedDirectory,
        acquiredWindowsIdentity,
      };
    },
    catch: (cause) =>
      new ProviderMaintenanceCrossProcessLockError(lockKey, requestedLockPath, errorDetail(cause)),
  });
}

export function releaseProviderMaintenanceCrossProcessLock(
  lock: ProviderMaintenanceCrossProcessLock,
) {
  return Effect.tryPromise({
    try: async () => {
      if (releasedProviderMaintenanceLocks.has(lock)) return;
      await Effect.runPromise(
        releaseDatabaseLifecycleLock(lock.lifecycleLock, {
          beforeRelease: async () => {
            if (!lock.acquiredWindowsIdentity) return;
            await verifyAcquiredWindowsLock(
              lock.lifecycleLock,
              lock.preparedDirectory,
              lock.lifecycleLock.dbPath,
              lock.acquiredWindowsIdentity,
            );
          },
        }),
      );
      releasedProviderMaintenanceLocks.add(lock);
    },
    catch: (cause) =>
      new ProviderMaintenanceCrossProcessLockError(lock.lockKey, lock.lockPath, errorDetail(cause)),
  });
}

export function withProviderMaintenanceCrossProcessLock<A, E, R>(
  lockKey: string,
  use: Effect.Effect<A, E, R>,
  options: {
    readonly canonicalInstallRoot: string;
    readonly directoryPath?: string;
    readonly localAppDataDirectory?: string;
    readonly dependencies?: ProviderMaintenanceCrossProcessLockDependencies;
  },
) {
  return Effect.acquireUseRelease(
    acquireProviderMaintenanceCrossProcessLock(lockKey, options),
    () => use,
    releaseProviderMaintenanceCrossProcessLock,
  );
}
