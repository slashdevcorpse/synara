import * as NodePath from "node:path";

import type {
  ProviderKind,
  ServerProviderStatus,
  ServerProviderVersionAdvisory,
} from "@synara/contracts";
import {
  readEffectiveWindowsEnvironmentValue,
  resolveWindowsCommandCandidatesAsync as resolveRuntimeWindowsCommandCandidatesAsync,
  resolveWindowsCommandPathAsync as resolveRuntimeWindowsCommandPathAsync,
  type WindowsAsyncCommandDiscoveryInput,
} from "@synara/shared/windowsProcess";
import { parseCanonicalWindowsNpmNodeShim } from "@synara/shared/windowsNpmShim";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROVIDER_UPDATE_ACTION_MESSAGE = "Install the update now or review provider settings.";

export type ProviderInstallSource = "npm" | "bun" | "pnpm" | "homebrew" | "native" | "unknown";

export type ActionableProviderInstallSource = Exclude<ProviderInstallSource, "unknown">;

export interface ProviderPackageChannelEvidence {
  readonly kind: "package-dist-tag";
  readonly tag: "latest";
  readonly installedVersion: string;
  /** Canonical local manager metadata used to prove the requested tag. */
  readonly metadataPath: string;
}

export type ProviderMaintenanceChannelIdentity =
  | ProviderPackageChannelEvidence
  | {
      readonly kind: "homebrew";
      readonly name: string;
      readonly packageKind: "formula" | "cask";
    }
  | {
      readonly kind: "native-self-update";
      readonly provider: ProviderKind;
    };

export interface ProviderMaintenanceManagerCommandIdentity {
  /** Canonical executable launched for the package-manager operation. */
  readonly executablePath: string;
  /** Canonical arguments required before the package-manager operation arguments. */
  readonly argsPrefix: ReadonlyArray<string>;
}

export interface ProviderMaintenanceTargetIdentity {
  readonly platform: NodeJS.Platform;
  readonly installSource: ActionableProviderInstallSource;
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly canonicalInstallRoot: string;
  readonly managerExecutablePath: string;
  readonly canonicalManagerExecutablePath: string;
  readonly managerCommand: ProviderMaintenanceManagerCommandIdentity;
  readonly channel: ProviderMaintenanceChannelIdentity;
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

export interface ProviderLatestVersionSource {
  readonly kind: "npm" | "homebrew";
  readonly name: string;
  readonly homebrewKind?: "formula" | "cask";
}

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderKind;
  readonly packageName: string | null;
  readonly latestVersionSource: ProviderLatestVersionSource | null;
  readonly advisoryLatestVersionSource: ProviderLatestVersionSource | null;
  readonly update: ProviderMaintenanceCommandAction | null;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** Stable identity checked again immediately before and after maintenance. */
  readonly targetFingerprint: string;
  readonly target: ProviderMaintenanceTargetIdentity;
  /** Put the selected provider binary's directory first so its package manager matches. */
  readonly pathPrepend?: string;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly realCommandPath?: string | null;
  readonly commandDirectory?: string | null;
  /** Canonical manager/root evidence for the pure resolver and focused tests. */
  readonly managerExecutablePath?: string | null;
  readonly realManagerExecutablePath?: string | null;
  /** Verified direct invocation used to avoid Windows package-manager batch wrappers. */
  readonly managerCommand?: ProviderMaintenanceManagerCommandIdentity | null;
  readonly canonicalInstallRoot?: string | null;
  readonly packageChannelEvidence?: ProviderPackageChannelEvidence | null;
}

type MaybePromise<T> = T | PromiseLike<T>;

type ResolveWindowsCommandCandidates = (
  command: string,
  input?: WindowsAsyncCommandDiscoveryInput,
) => MaybePromise<ReadonlyArray<string>>;

type ResolveWindowsCommandPath = (
  command: string,
  input?: WindowsAsyncCommandDiscoveryInput,
) => MaybePromise<string>;

interface ProviderMaintenanceCapabilityResolutionDependencies {
  readonly resolveWindowsCommandCandidates?: ResolveWindowsCommandCandidates;
  readonly resolveWindowsCommandPath?: ResolveWindowsCommandPath;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderKind;
  readonly binaryName: string;
  readonly npmPackageName: string | null;
  /** Omission means manual-only. Package presence never implies manager support. */
  readonly allowedInstallSources?: ReadonlyArray<ActionableProviderInstallSource>;
  /** Accepted executable/shim aliases. Defaults to binaryName. */
  readonly allowedBinaryNames?: ReadonlyArray<string>;
  readonly npmInstallFlags?: ReadonlyArray<string>;
  readonly homebrew: {
    readonly name: string;
    readonly kind: "formula" | "cask";
  } | null;
  readonly latestVersionSource?: ProviderLatestVersionSource | null;
  /**
   * Explicitly trusted read-only metadata fallback used when update ownership
   * cannot be proven or an exact maintenance channel has no latest source.
   * This never authorizes or verifies a mutation.
   */
  readonly advisoryLatestVersionSource?: ProviderLatestVersionSource | null;
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: (installSource: ProviderInstallSource) => ReadonlyArray<string>;
    readonly lockKey: string;
    readonly strategy: "always" | "matching-path";
    readonly excludedInstallSources?: ReadonlyArray<ProviderInstallSource>;
    readonly isCommandPath?: (commandPath: string, platform: NodeJS.Platform) => boolean;
    /** Allows installer provenance to use both the visible junction/shim and its canonical target. */
    readonly isVisibleCommandPath?: (input: {
      readonly visibleCommandPath: string;
      readonly canonicalCommandPath: string;
      readonly platform: NodeJS.Platform;
    }) => boolean;
    readonly resolveInstallRoot?: (input: {
      readonly visibleCommandPath: string;
      readonly canonicalCommandPath: string;
      readonly platform: NodeJS.Platform;
    }) => string | null;
  } | null;
}

interface LatestVersionCacheEntry {
  readonly expiresAt: number;
  readonly generation: number;
  readonly version: string | null;
}

interface LatestVersionInFlightRequest {
  readonly forceRefresh: boolean;
  readonly generation: number;
  readonly promise: Promise<string | null>;
}

const latestVersionCache = new Map<string, LatestVersionCacheEntry>();
const latestVersionGenerations = new Map<string, number>();
const latestVersionInFlightRequests = new Map<string, LatestVersionInFlightRequest>();
const SEMVER_NUMBER_SEGMENT = /^\d+$/;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSemverVersion(version: string): string {
  const [main, prerelease] = version.trim().replace(/^v/, "").split("-", 2);
  const segments = (main ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) {
    segments.push("0");
  }

  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".");
}

function parseSemver(value: string): ParsedSemver | null {
  const [main = "", prerelease] = normalizeSemverVersion(value).split("-", 2);
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (
    majorSegment === undefined ||
    minorSegment === undefined ||
    patchSegment === undefined ||
    !SEMVER_NUMBER_SEGMENT.test(majorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(minorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  return {
    major: Number.parseInt(majorSegment, 10),
    minor: Number.parseInt(minorSegment, 10),
    patch: Number.parseInt(patchSegment, 10),
    prerelease:
      prerelease
        ?.split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = SEMVER_NUMBER_SEGMENT.test(left);
  const rightNumeric = SEMVER_NUMBER_SEGMENT.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

export function compareSemverVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ? normalizeSemverVersion(match[1]) : null;
}

export function normalizeCommandPath(commandPath: string, platform: NodeJS.Platform): string {
  const normalized = commandPath.replaceAll("\\", "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function makeCommandPathSuffixMatcher(
  commandPathSuffixes: ReadonlyArray<string>,
): (commandPath: string, platform: NodeJS.Platform) => boolean {
  const suffixes = commandPathSuffixes.map((suffix) => suffix.trim()).filter(Boolean);
  return (commandPath, platform) => {
    const normalizedSuffixes = suffixes.map((suffix) => normalizeCommandPath(suffix, platform));
    const normalizedCommandPath = normalizeCommandPath(commandPath, platform);
    return normalizedSuffixes.some((suffix) => normalizedCommandPath.endsWith(suffix));
  };
}

/**
 * npm resolves its global prefix from the `node` binary that runs it, not from
 * npm's own location, so a bare `npm install -g` can write to a different
 * install tree than the one the detected provider binary lives in (e.g. a
 * Homebrew-prefix install checked by Synara while nvm's node makes npm install
 * into nvm's prefix). Derive the prefix that owns the detected binary so the
 * update can pin it explicitly.
 */
export function deriveNpmGlobalPrefix(
  commandPath: string,
  platform: NodeJS.Platform,
): string | null {
  // normalizeCommandPath preserves length, so indices map back onto the
  // original string, keeping its casing and separators intact.
  const normalized = normalizeCommandPath(commandPath, platform);
  const unixIndex = normalized.indexOf("/lib/node_modules/");
  if (unixIndex > 0) {
    return commandPath.slice(0, unixIndex);
  }
  const windowsIndex = normalized.indexOf("/npm/node_modules/");
  if (windowsIndex > 0) {
    return commandPath.slice(0, windowsIndex + "/npm".length);
  }
  return null;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderKind;
  readonly packageName: string | null;
  readonly latestVersionSource?: ProviderLatestVersionSource | null;
  readonly advisoryLatestVersionSource?: ProviderLatestVersionSource | null | undefined;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly updatePathPrepend?: string | null;
  readonly updateTarget?: ProviderMaintenanceTargetIdentity | null;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null || !input.updateTarget
      ? null
      : {
          command: [input.updateExecutable, ...input.updateArgs]
            .map((part) => (/\s/.test(part) ? `"${part}"` : part))
            .join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          targetFingerprint: providerMaintenanceTargetFingerprint(input.updateTarget),
          target: input.updateTarget,
          ...(nonEmptyString(input.updatePathPrepend)
            ? { pathPrepend: nonEmptyString(input.updatePathPrepend)! }
            : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    latestVersionSource:
      input.latestVersionSource === undefined
        ? input.packageName
          ? { kind: "npm", name: input.packageName }
          : null
        : input.latestVersionSource,
    advisoryLatestVersionSource: input.advisoryLatestVersionSource ?? null,
    update,
  };
}

export function providerMaintenanceTargetFingerprint(
  target: ProviderMaintenanceTargetIdentity,
): string {
  const channel =
    target.channel.kind === "package-dist-tag"
      ? {
          kind: target.channel.kind,
          tag: target.channel.tag,
          metadataPath: normalizeCommandPath(target.channel.metadataPath, target.platform),
        }
      : target.channel;
  return JSON.stringify({
    platform: target.platform,
    source: target.installSource,
    visibleCommandPath: normalizeCommandPath(target.visibleCommandPath, target.platform),
    canonicalCommandPath: normalizeCommandPath(target.canonicalCommandPath, target.platform),
    canonicalInstallRoot: normalizeCommandPath(target.canonicalInstallRoot, target.platform),
    managerExecutablePath: normalizeCommandPath(target.managerExecutablePath, target.platform),
    canonicalManagerExecutablePath: normalizeCommandPath(
      target.canonicalManagerExecutablePath,
      target.platform,
    ),
    managerCommand: {
      executablePath: normalizeCommandPath(target.managerCommand.executablePath, target.platform),
      argsPrefix: target.managerCommand.argsPrefix.map((arg) =>
        isAbsoluteCommandPath(arg, target.platform)
          ? normalizeCommandPath(arg, target.platform)
          : arg,
      ),
    },
    channel,
  });
}

function providerMaintenanceChannelDestinationFingerprint(
  channel: ProviderMaintenanceChannelIdentity,
  platform: NodeJS.Platform,
): string {
  if (channel.kind === "package-dist-tag") {
    return JSON.stringify({
      kind: channel.kind,
      tag: channel.tag,
      metadataPath: normalizeCommandPath(channel.metadataPath, platform),
    });
  }
  return JSON.stringify(channel);
}

/**
 * Compares the stable update destination after an updater has completed.
 * Versioned payload paths may legitimately change; source, launcher, owning
 * root/manager, and channel provenance may not.
 */
export function providerMaintenanceTargetsShareUpdateDestination(
  left: ProviderMaintenanceTargetIdentity,
  right: ProviderMaintenanceTargetIdentity,
): boolean {
  if (
    left.platform !== right.platform ||
    left.installSource !== right.installSource ||
    normalizeCommandPath(left.visibleCommandPath, left.platform) !==
      normalizeCommandPath(right.visibleCommandPath, right.platform) ||
    normalizeCommandPath(left.canonicalInstallRoot, left.platform) !==
      normalizeCommandPath(right.canonicalInstallRoot, right.platform) ||
    normalizeCommandPath(left.managerExecutablePath, left.platform) !==
      normalizeCommandPath(right.managerExecutablePath, right.platform) ||
    normalizeCommandPath(left.managerCommand.executablePath, left.platform) !==
      normalizeCommandPath(right.managerCommand.executablePath, right.platform) ||
    left.managerCommand.argsPrefix.length !== right.managerCommand.argsPrefix.length ||
    left.managerCommand.argsPrefix.some(
      (arg, index) =>
        normalizeCommandPath(arg, left.platform) !==
        normalizeCommandPath(right.managerCommand.argsPrefix[index] ?? "", right.platform),
    ) ||
    providerMaintenanceChannelDestinationFingerprint(left.channel, left.platform) !==
      providerMaintenanceChannelDestinationFingerprint(right.channel, right.platform)
  ) {
    return false;
  }

  return (
    left.installSource === "native" ||
    normalizeCommandPath(left.canonicalManagerExecutablePath, left.platform) ===
      normalizeCommandPath(right.canonicalManagerExecutablePath, right.platform)
  );
}

function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderKind;
  readonly packageName: string | null;
  readonly advisoryLatestVersionSource?: ProviderLatestVersionSource | null | undefined;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    latestVersionSource: null,
    advisoryLatestVersionSource: input.advisoryLatestVersionSource,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  });
}

function makeGlobalPackageManagerProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  target: ProviderMaintenanceTargetIdentity,
  input: {
    readonly updateArgs: (packageName: string, globalRoot: string) => ReadonlyArray<string>;
    readonly updateLockPrefix: string;
  },
): ProviderMaintenanceCapabilities {
  if (!definition.npmPackageName) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: null,
      advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    });
  }
  const globalRoot = nonEmptyString(target.canonicalInstallRoot);
  if (!globalRoot) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    updateExecutable: target.managerCommand.executablePath,
    updateArgs: [
      ...target.managerCommand.argsPrefix,
      ...input.updateArgs(definition.npmPackageName, globalRoot),
    ],
    updateLockKey: `${input.updateLockPrefix}:${normalizeCommandPath(globalRoot, target.platform)}`,
    updatePathPrepend: commandPathImplementation(target.platform).dirname(
      target.managerCommand.executablePath,
    ),
    updateTarget: target,
  });
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  target: ProviderMaintenanceTargetIdentity,
): ProviderMaintenanceCapabilities {
  return makeGlobalPackageManagerProviderMaintenanceCapabilities(definition, target, {
    updateArgs: (packageName, globalPrefix) => [
      "install",
      "-g",
      ...(definition.npmInstallFlags ?? []),
      "--prefix",
      globalPrefix,
      `${packageName}@latest`,
    ],
    updateLockPrefix: "npm-global",
  });
}

function makeBunGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  target: ProviderMaintenanceTargetIdentity,
): ProviderMaintenanceCapabilities {
  return makeGlobalPackageManagerProviderMaintenanceCapabilities(definition, target, {
    updateArgs: (packageName) => ["i", "-g", `${packageName}@latest`],
    updateLockPrefix: "bun-global",
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  target: ProviderMaintenanceTargetIdentity,
): ProviderMaintenanceCapabilities {
  return makeGlobalPackageManagerProviderMaintenanceCapabilities(definition, target, {
    updateArgs: (packageName) => ["add", "-g", `${packageName}@latest`],
    updateLockPrefix: "pnpm-global",
  });
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  target: ProviderMaintenanceTargetIdentity,
): ProviderMaintenanceCapabilities {
  if (!definition.homebrew) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    });
  }

  const globalRoot = nonEmptyString(target.canonicalInstallRoot);
  if (!globalRoot) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: null,
    latestVersionSource: resolveLatestVersionSourceForInstallSource(definition, "homebrew"),
    advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    updateExecutable: target.managerExecutablePath,
    updateArgs:
      definition.homebrew.kind === "cask"
        ? ["upgrade", "--cask", definition.homebrew.name]
        : ["upgrade", definition.homebrew.name],
    updateLockKey: `homebrew:${normalizeCommandPath(globalRoot, target.platform)}`,
    updatePathPrepend: commandPathImplementation(target.platform).dirname(
      target.managerExecutablePath,
    ),
    updateTarget: target,
  });
}

function resolveLatestVersionSourceForInstallSource(
  definition: PackageManagedProviderMaintenanceDefinition,
  installSource: ProviderInstallSource,
): ProviderLatestVersionSource | null {
  if (definition.latestVersionSource !== undefined) {
    return definition.latestVersionSource;
  }
  if (installSource === "homebrew" && definition.homebrew) {
    return {
      kind: "homebrew",
      name: definition.homebrew.name,
      homebrewKind: definition.homebrew.kind,
    };
  }
  return installSource === "npm" || installSource === "bun" || installSource === "pnpm"
    ? definition.npmPackageName
      ? { kind: "npm", name: definition.npmPackageName }
      : null
    : null;
}

function makeNativeProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  installSource: ProviderInstallSource,
  target: ProviderMaintenanceTargetIdentity,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: installSource === "homebrew" ? null : definition.npmPackageName,
    // Prefer explicit upstream metadata for channels like third-party Homebrew taps,
    // then fall back to the package manager channel when its public API is usable.
    latestVersionSource: resolveLatestVersionSourceForInstallSource(definition, installSource),
    advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    updateExecutable: target.visibleCommandPath,
    updateArgs: definition.nativeUpdate.args(installSource),
    updateLockKey: `${definition.nativeUpdate.lockKey}:${normalizeCommandPath(target.canonicalInstallRoot, target.platform)}`,
    updatePathPrepend: commandPathImplementation(target.platform).dirname(
      target.visibleCommandPath,
    ),
    updateTarget: target,
  });
}

function isInstallSourceAllowed(
  definition: PackageManagedProviderMaintenanceDefinition,
  installSource: ProviderInstallSource,
): installSource is ActionableProviderInstallSource {
  return (
    installSource !== "unknown" &&
    definition.allowedInstallSources?.includes(installSource) === true
  );
}

function detectInstallSource(
  definition: PackageManagedProviderMaintenanceDefinition,
  visibleCommandPath: string,
  canonicalCommandPath: string,
  platform: NodeJS.Platform,
): ProviderInstallSource {
  if (
    definition.nativeUpdate &&
    (definition.nativeUpdate.isVisibleCommandPath?.({
      visibleCommandPath,
      canonicalCommandPath,
      platform,
    }) === true ||
      definition.nativeUpdate.isCommandPath?.(canonicalCommandPath, platform) === true)
  ) {
    return "native";
  }
  if (isBunGlobalCommandPath(definition, canonicalCommandPath, platform)) {
    return "bun";
  }
  if (isPnpmGlobalCommandPath(definition, canonicalCommandPath, platform)) {
    return "pnpm";
  }
  if (isNpmGlobalCommandPath(definition, canonicalCommandPath, platform)) {
    return "npm";
  }
  if (isHomebrewCommandPath(definition, canonicalCommandPath, platform)) {
    return "homebrew";
  }
  return "unknown";
}

function makeProviderMaintenanceForInstallSource(input: {
  readonly definition: PackageManagedProviderMaintenanceDefinition;
  readonly installSource: ProviderInstallSource;
  readonly target: ProviderMaintenanceTargetIdentity;
}): ProviderMaintenanceCapabilities {
  const { definition, installSource, target } = input;
  if (!isInstallSourceAllowed(definition, installSource)) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    });
  }
  if (
    (installSource === "npm" || installSource === "bun" || installSource === "pnpm") &&
    target.channel.kind !== "package-dist-tag"
  ) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
    });
  }
  if (
    definition.nativeUpdate?.strategy === "always" &&
    !definition.nativeUpdate.excludedInstallSources?.includes(installSource)
  ) {
    return (
      makeNativeProviderMaintenanceCapabilities(definition, installSource, target) ??
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
      })
    );
  }
  if (installSource === "native") {
    return (
      makeNativeProviderMaintenanceCapabilities(definition, installSource, target) ??
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
      })
    );
  }
  if (installSource === "bun") {
    return makeBunGlobalProviderMaintenanceCapabilities(definition, target);
  }
  if (installSource === "pnpm") {
    return makePnpmGlobalProviderMaintenanceCapabilities(definition, target);
  }
  if (installSource === "npm") {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition, target);
  }
  if (installSource === "homebrew") {
    return makeHomebrewProviderMaintenanceCapabilities(definition, target);
  }
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
  });
}

function expectedNpmPackagePath(
  definition: PackageManagedProviderMaintenanceDefinition,
): string | null {
  const packageName = nonEmptyString(definition.npmPackageName);
  if (!packageName) {
    return null;
  }
  const segments = packageName
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  return segments.length > 0 ? segments.join("/") : null;
}

function allowedBinaryNames(
  definition: PackageManagedProviderMaintenanceDefinition,
): ReadonlySet<string> {
  return new Set(
    [definition.binaryName, ...(definition.allowedBinaryNames ?? [])]
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function pathContainsDirectory(
  commandPath: string,
  directory: string,
  platform: NodeJS.Platform,
): boolean {
  const normalized = normalizeCommandPath(commandPath, platform);
  const normalizedDirectory = normalizeCommandPath(directory, platform).replace(/^\/+|\/+$/g, "");
  return (
    normalized.includes(`/${normalizedDirectory}/`) ||
    normalized.endsWith(`/${normalizedDirectory}`)
  );
}

function managerInstallRoot(
  commandPath: string,
  source: "bun" | "pnpm" | "homebrew",
  platform: NodeJS.Platform,
): string | null {
  const normalized = normalizeCommandPath(commandPath, platform);
  const markers = (
    source === "bun"
      ? ["/.bun/install/global/node_modules/"]
      : source === "pnpm"
        ? ["/.pnpm/"]
        : ["/Cellar/", "/Caskroom/"]
  ).map((marker) => normalizeCommandPath(marker, platform));
  const marker = markers.find((candidate) => normalized.includes(candidate));
  if (!marker) {
    return null;
  }
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex <= 0) {
    return null;
  }
  if (source === "bun") {
    return commandPath.slice(0, markerIndex + "/.bun/install/global".length);
  }
  return commandPath.slice(0, markerIndex);
}

function isBunGlobalCommandPath(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
  platform: NodeJS.Platform,
): boolean {
  const packagePath = expectedNpmPackagePath(definition);
  return packagePath
    ? pathContainsDirectory(
        commandPath,
        `.bun/install/global/node_modules/${packagePath}`,
        platform,
      )
    : false;
}

function isPnpmGlobalCommandPath(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
  platform: NodeJS.Platform,
): boolean {
  const packagePath = expectedNpmPackagePath(definition);
  if (!packagePath) {
    return false;
  }
  const normalized = normalizeCommandPath(commandPath, platform);
  const hasGlobalRoot = [
    "/.local/share/pnpm/global/",
    "/library/pnpm/global/",
    "/local/share/pnpm/global/",
    "/appdata/local/pnpm/global/",
    "/pnpm/global/",
  ].some((marker) => normalized.includes(marker));
  return (
    hasGlobalRoot &&
    normalized.includes("/.pnpm/") &&
    pathContainsDirectory(commandPath, `node_modules/${packagePath}`, platform)
  );
}

function isNpmGlobalCommandPath(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
  platform: NodeJS.Platform,
): boolean {
  const packagePath = expectedNpmPackagePath(definition);
  return packagePath
    ? pathContainsDirectory(commandPath, `lib/node_modules/${packagePath}`, platform) ||
        pathContainsDirectory(commandPath, `npm/node_modules/${packagePath}`, platform)
    : false;
}

function homebrewPackageToken(
  definition: PackageManagedProviderMaintenanceDefinition,
): string | null {
  const packageName = nonEmptyString(definition.homebrew?.name);
  if (!packageName) {
    return null;
  }
  const segments = packageName
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return nonEmptyString(segments.at(-1));
}

function isHomebrewCommandPath(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
  platform: NodeJS.Platform,
): boolean {
  const packageToken = homebrewPackageToken(definition);
  const packageKind = definition.homebrew?.kind;
  if (!packageToken || !packageKind) {
    return false;
  }
  const installDirectory = packageKind === "cask" ? "Caskroom" : "Cellar";
  return pathContainsDirectory(commandPath, `${installDirectory}/${packageToken}`, platform);
}

function normalizePackageBinTarget(value: unknown): string | null {
  const target = nonEmptyString(value)?.replaceAll("\\", "/");
  if (!target || NodePath.posix.isAbsolute(target) || /^[a-z]:\//iu.test(target)) {
    return null;
  }
  const segments = target
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    return null;
  }
  return segments.join("/");
}

function parseVerifiedNpmPackageBinTarget(
  definition: PackageManagedProviderMaintenanceDefinition,
  manifestContents: string,
): string | null {
  if (!definition.npmPackageName) {
    return null;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestContents);
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const packageManifest = manifest as Record<string, unknown>;
  if (packageManifest.name !== definition.npmPackageName) {
    return null;
  }
  const bin = packageManifest.bin;
  if (typeof bin === "string") {
    const packageBinaryName = definition.npmPackageName.split("/").filter(Boolean).at(-1);
    return packageBinaryName && allowedBinaryNames(definition).has(packageBinaryName.toLowerCase())
      ? normalizePackageBinTarget(bin)
      : null;
  }
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) {
    return null;
  }
  const names = allowedBinaryNames(definition);
  const matchingBin = Object.entries(bin as Record<string, unknown>).find(([name]) =>
    names.has(name.toLowerCase()),
  );
  return normalizePackageBinTarget(matchingBin?.[1]);
}

function windowsNpmShimLinksToPackageBin(input: {
  readonly definition: PackageManagedProviderMaintenanceDefinition;
  readonly packageBinTarget: string;
  readonly shimContents: string;
}): boolean {
  const packagePath = expectedNpmPackagePath(input.definition);
  if (!packagePath) {
    return false;
  }
  const expectedTarget = `node_modules/${packagePath}/${input.packageBinTarget}`.toLowerCase();
  return parseCanonicalWindowsNpmNodeShim(input.shimContents)?.toLowerCase() === expectedTarget;
}

function commandPathImplementation(platform: NodeJS.Platform): typeof NodePath.posix {
  return platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function resolveWindowsNpmShimEvidence(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
): { readonly globalPrefix: string; readonly packageManifestPath: string } | null {
  if (!definition.npmPackageName) {
    return null;
  }
  const path = commandPathImplementation("win32");
  const extension = path.extname(commandPath).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return null;
  }
  const commandName = path.basename(commandPath, extension).toLowerCase();
  if (!allowedBinaryNames(definition).has(commandName)) {
    return null;
  }

  const globalPrefix = path.dirname(commandPath);
  const packageSegments = definition.npmPackageName.split("/").filter(Boolean);
  if (globalPrefix === "." || packageSegments.length === 0) {
    return null;
  }
  return {
    globalPrefix,
    packageManifestPath: path.join(
      globalPrefix,
      "node_modules",
      ...packageSegments,
      "package.json",
    ),
  };
}

function parseJsonObject(contents: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(contents) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stablePackageVersion(
  definition: PackageManagedProviderMaintenanceDefinition,
  manifestContents: string,
): string | null {
  const manifest = parseJsonObject(manifestContents);
  if (!manifest || manifest.name !== definition.npmPackageName) {
    return null;
  }
  const version = nonEmptyString(manifest.version);
  const parsed = version ? parseSemver(version) : null;
  return parsed && parsed.prerelease.length === 0 ? normalizeSemverVersion(version!) : null;
}

function metadataProvesLatestPackageTag(
  metadata: Record<string, unknown>,
  packageName: string,
): boolean {
  if (metadata.name === packageName) {
    const requested = metadata._requested;
    if (requested && typeof requested === "object" && !Array.isArray(requested)) {
      const requestedRecord = requested as Record<string, unknown>;
      if (
        requestedRecord.type === "tag" &&
        requestedRecord.rawSpec === "latest" &&
        (requestedRecord.raw === undefined || requestedRecord.raw === `${packageName}@latest`)
      ) {
        return true;
      }
    }
    if (metadata._spec === `${packageName}@latest`) {
      return true;
    }
  }

  for (const sectionName of ["dependencies", "optionalDependencies"] as const) {
    const section = metadata[sectionName];
    if (
      section &&
      typeof section === "object" &&
      !Array.isArray(section) &&
      (section as Record<string, unknown>)[packageName] === "latest"
    ) {
      return true;
    }
  }
  return false;
}

function derivePackageManifestPath(
  definition: PackageManagedProviderMaintenanceDefinition,
  canonicalCommandPath: string,
  platform: NodeJS.Platform,
): string | null {
  const packagePath = expectedNpmPackagePath(definition);
  if (!packagePath) {
    return null;
  }
  const normalized = normalizeCommandPath(canonicalCommandPath, platform);
  const marker = `/node_modules/${packagePath}`;
  const markerIndex = normalized.lastIndexOf(marker);
  const markerEnd = markerIndex + marker.length;
  if (markerIndex < 0 || (normalized.length > markerEnd && normalized[markerEnd] !== "/")) {
    return null;
  }
  const packageDirectory = canonicalCommandPath.slice(0, markerEnd);
  return commandPathImplementation(platform).join(packageDirectory, "package.json");
}

function packageBinPath(
  packageManifestPath: string,
  packageBinTarget: string,
  platform: NodeJS.Platform,
): string {
  const path = commandPathImplementation(platform);
  return path.resolve(path.dirname(packageManifestPath), packageBinTarget);
}

function deriveCanonicalInstallRoot(
  installSource: ActionableProviderInstallSource,
  canonicalCommandPath: string,
  platform: NodeJS.Platform,
): string | null {
  if (installSource === "npm") {
    return deriveNpmGlobalPrefix(canonicalCommandPath, platform);
  }
  if (installSource === "bun" || installSource === "pnpm" || installSource === "homebrew") {
    return managerInstallRoot(canonicalCommandPath, installSource, platform);
  }
  return commandPathImplementation(platform).dirname(canonicalCommandPath);
}

function executableBaseName(commandPath: string, platform: NodeJS.Platform): string {
  const path = commandPathImplementation(platform);
  return path.basename(commandPath, path.extname(commandPath)).toLowerCase();
}

function isAbsoluteCommandPath(commandPath: string, platform: NodeJS.Platform): boolean {
  return commandPathImplementation(platform).isAbsolute(commandPath);
}

function commandPathIsWithinRoot(
  commandPath: string,
  rootPath: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedRoot = normalizeCommandPath(rootPath, platform).replace(/\/+$/u, "");
  const normalizedCommand = normalizeCommandPath(commandPath, platform);
  return normalizedCommand === normalizedRoot || normalizedCommand.startsWith(`${normalizedRoot}/`);
}

function managerMatchesInstallRoot(input: {
  readonly installSource: ActionableProviderInstallSource;
  readonly managerExecutablePath: string;
  readonly canonicalInstallRoot: string;
  readonly platform: NodeJS.Platform;
}): boolean {
  const managerName =
    input.installSource === "homebrew"
      ? "brew"
      : input.installSource === "native"
        ? null
        : input.installSource;
  if (
    managerName &&
    executableBaseName(input.managerExecutablePath, input.platform) !== managerName
  ) {
    return false;
  }
  if (
    input.platform === "win32" &&
    input.installSource === "npm" &&
    commandPathImplementation(input.platform)
      .basename(input.managerExecutablePath)
      .toLowerCase() !== "npm.cmd"
  ) {
    return false;
  }
  if (input.installSource === "npm" || input.installSource === "native") {
    return true;
  }

  const normalizedManagerWithExtension = normalizeCommandPath(
    input.managerExecutablePath,
    input.platform,
  );
  const normalizedManager = /\.(?:exe|cmd|bat)$/u.test(normalizedManagerWithExtension)
    ? normalizedManagerWithExtension.replace(/\.(?:exe|cmd|bat)$/u, "")
    : normalizedManagerWithExtension;
  const normalizedRoot = normalizeCommandPath(input.canonicalInstallRoot, input.platform).replace(
    /\/$/u,
    "",
  );
  if (input.installSource === "homebrew") {
    return normalizedManager === `${normalizedRoot}/bin/brew`;
  }
  if (input.installSource === "bun") {
    const bunRootMarker = "/.bun/install/global";
    const markerIndex = normalizedRoot.indexOf(bunRootMarker);
    return (
      markerIndex > 0 &&
      normalizedManager === `${normalizedRoot.slice(0, markerIndex)}/.bun/bin/bun`
    );
  }
  const globalMarker = "/global/";
  const globalIndex = normalizedRoot.lastIndexOf(globalMarker);
  return globalIndex > 0 && normalizedManager === `${normalizedRoot.slice(0, globalIndex)}/pnpm`;
}

function makeMaintenanceTarget(input: {
  readonly definition: PackageManagedProviderMaintenanceDefinition;
  readonly platform: NodeJS.Platform;
  readonly installSource: ProviderInstallSource;
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly canonicalInstallRoot: string | null;
  readonly managerExecutablePath: string | null;
  readonly canonicalManagerExecutablePath: string | null;
  readonly managerCommand: ProviderMaintenanceManagerCommandIdentity | null;
  readonly packageChannelEvidence: ProviderPackageChannelEvidence | null;
}): ProviderMaintenanceTargetIdentity | null {
  if (!isInstallSourceAllowed(input.definition, input.installSource)) {
    return null;
  }
  const canonicalInstallRoot = nonEmptyString(input.canonicalInstallRoot);
  const managerExecutablePath = nonEmptyString(input.managerExecutablePath);
  const canonicalManagerExecutablePath = nonEmptyString(input.canonicalManagerExecutablePath);
  if (!canonicalInstallRoot || !managerExecutablePath || !canonicalManagerExecutablePath) {
    return null;
  }
  const managerCommand =
    input.managerCommand ??
    (input.platform === "win32" && input.installSource === "npm"
      ? null
      : { executablePath: managerExecutablePath, argsPrefix: [] });
  if (!managerCommand) {
    return null;
  }
  if (
    [
      input.visibleCommandPath,
      input.canonicalCommandPath,
      canonicalInstallRoot,
      managerExecutablePath,
      canonicalManagerExecutablePath,
      managerCommand.executablePath,
    ].some((path) => !isAbsoluteCommandPath(path, input.platform))
  ) {
    return null;
  }
  if (
    managerCommand.argsPrefix.some(
      (arg) => hasPathSeparator(arg) && !isAbsoluteCommandPath(arg, input.platform),
    )
  ) {
    return null;
  }
  if (!commandPathIsWithinRoot(input.canonicalCommandPath, canonicalInstallRoot, input.platform)) {
    return null;
  }

  const derivedRoot = deriveCanonicalInstallRoot(
    input.installSource,
    input.canonicalCommandPath,
    input.platform,
  );
  if (
    input.installSource !== "native" &&
    (!derivedRoot ||
      normalizeCommandPath(derivedRoot, input.platform) !==
        normalizeCommandPath(canonicalInstallRoot, input.platform))
  ) {
    return null;
  }
  if (
    !managerMatchesInstallRoot({
      installSource: input.installSource,
      managerExecutablePath,
      canonicalInstallRoot,
      platform: input.platform,
    })
  ) {
    return null;
  }
  if (input.platform === "win32" && input.installSource === "npm") {
    const path = commandPathImplementation(input.platform);
    if (path.basename(canonicalManagerExecutablePath).toLowerCase() !== "npm.cmd") {
      return null;
    }
    const expectedNodePath = path.join(path.dirname(canonicalManagerExecutablePath), "node.exe");
    const allowedNpmCliPaths = [
      path.join(canonicalInstallRoot, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(
        path.dirname(canonicalManagerExecutablePath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    ];
    if (
      normalizeCommandPath(managerCommand.executablePath, input.platform) !==
        normalizeCommandPath(expectedNodePath, input.platform) ||
      managerCommand.argsPrefix.length !== 1 ||
      !allowedNpmCliPaths.some(
        (candidate) =>
          normalizeCommandPath(candidate, input.platform) ===
          normalizeCommandPath(managerCommand.argsPrefix[0] ?? "", input.platform),
      )
    ) {
      return null;
    }
  }

  let channel: ProviderMaintenanceChannelIdentity;
  if (
    input.installSource === "npm" ||
    input.installSource === "bun" ||
    input.installSource === "pnpm"
  ) {
    const evidence = input.packageChannelEvidence;
    const parsedVersion = evidence ? parseSemver(evidence.installedVersion) : null;
    if (
      !evidence ||
      evidence.tag !== "latest" ||
      !parsedVersion ||
      parsedVersion.prerelease.length > 0 ||
      !nonEmptyString(evidence.metadataPath) ||
      !isAbsoluteCommandPath(evidence.metadataPath, input.platform) ||
      !commandPathIsWithinRoot(evidence.metadataPath, canonicalInstallRoot, input.platform)
    ) {
      return null;
    }
    channel = evidence;
  } else if (input.installSource === "homebrew") {
    if (!input.definition.homebrew) {
      return null;
    }
    channel = {
      kind: "homebrew",
      name: input.definition.homebrew.name,
      packageKind: input.definition.homebrew.kind,
    };
  } else {
    if (
      normalizeCommandPath(managerExecutablePath, input.platform) !==
        normalizeCommandPath(input.visibleCommandPath, input.platform) ||
      normalizeCommandPath(canonicalManagerExecutablePath, input.platform) !==
        normalizeCommandPath(input.canonicalCommandPath, input.platform)
    ) {
      return null;
    }
    channel = { kind: "native-self-update", provider: input.definition.provider };
  }

  return {
    platform: input.platform,
    installSource: input.installSource,
    visibleCommandPath: input.visibleCommandPath,
    canonicalCommandPath: input.canonicalCommandPath,
    canonicalInstallRoot,
    managerExecutablePath,
    canonicalManagerExecutablePath,
    managerCommand,
    channel,
  };
}

function manualCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    advisoryLatestVersionSource: definition.advisoryLatestVersionSource,
  });
}

async function managerExecutablePathCandidates(
  commandPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  resolveWindowsCommandCandidates: ResolveWindowsCommandCandidates,
): Promise<
  ReadonlyArray<{
    readonly visiblePath: string;
    readonly requestedDirectory: string;
  }>
> {
  const path = commandPathImplementation(platform);
  const requestedDirectory = path.dirname(commandPath);
  if (platform !== "win32") {
    return [{ visiblePath: commandPath, requestedDirectory }];
  }
  if (path.extname(commandPath)) {
    return [{ visiblePath: commandPath, requestedDirectory }];
  }

  const absoluteCommandPath = path.isAbsolute(commandPath);
  if (absoluteCommandPath) {
    const configuredPathExtensions = readEffectiveWindowsEnvironmentValue(env, "PATHEXT");
    const extensions = (configuredPathExtensions ?? "")
      .split(";")
      .map((extension) => extension.toLowerCase())
      .filter((extension) => [".com", ".exe", ".bat", ".cmd"].includes(extension));
    return Array.from(new Set(extensions), (extension) => ({
      visiblePath: `${commandPath}${extension}`,
      requestedDirectory,
    }));
  }

  const candidates = await resolveWindowsCommandCandidates(commandPath, {
    env,
    platform,
  });
  const requestedDirectories = (readEffectiveWindowsEnvironmentValue(env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return candidates
    .filter((candidate) => {
      const extension = path.extname(candidate).toLowerCase();
      return [".com", ".exe", ".bat", ".cmd"].includes(extension);
    })
    .flatMap((visiblePath) =>
      requestedDirectories.map((pathEntry) => ({
        visiblePath,
        requestedDirectory: pathEntry,
      })),
    );
}

function inspectCanonicalDirectory(fileSystem: FileSystem.FileSystem, directoryPath: string) {
  return Effect.gen(function* () {
    const stat = yield* fileSystem
      .stat(directoryPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat?.type !== "Directory") {
      return null;
    }
    const canonicalPath = yield* fileSystem
      .realPath(directoryPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return canonicalPath
      ? {
          canonicalPath,
          device: stat.dev,
          inode: stat.ino,
        }
      : null;
  });
}

function canonicalizeDirectory(fileSystem: FileSystem.FileSystem, directoryPath: string) {
  return inspectCanonicalDirectory(fileSystem, directoryPath).pipe(
    Effect.map((identity) => identity?.canonicalPath ?? null),
  );
}

function canonicalDirectoriesMatch(
  left: NonNullable<Effect.Success<ReturnType<typeof inspectCanonicalDirectory>>>,
  right: NonNullable<Effect.Success<ReturnType<typeof inspectCanonicalDirectory>>>,
  platform: NodeJS.Platform,
): boolean {
  if (left.inode !== undefined && right.inode !== undefined) {
    return left.device === right.device && left.inode === right.inode;
  }
  return (
    normalizeCommandPath(left.canonicalPath, platform) ===
    normalizeCommandPath(right.canonicalPath, platform)
  );
}

async function managerCandidatePaths(input: {
  readonly installSource: Exclude<ActionableProviderInstallSource, "native">;
  readonly canonicalInstallRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly preferredManagerExecutablePath?: string | null;
  readonly resolveWindowsCommandCandidates: ResolveWindowsCommandCandidates;
}): Promise<
  ReadonlyArray<{
    readonly visiblePath: string;
    readonly requestedDirectory: string;
  }>
> {
  const managerName = input.installSource === "homebrew" ? "brew" : input.installSource;
  const rootPath = commandPathImplementation(input.platform);
  const roots: string[] = [];
  if (input.preferredManagerExecutablePath) {
    roots.push(input.preferredManagerExecutablePath);
  }
  if (input.installSource === "npm") {
    roots.push(
      input.platform === "win32"
        ? rootPath.join(input.canonicalInstallRoot, "npm")
        : rootPath.join(input.canonicalInstallRoot, "bin", "npm"),
    );
  } else if (input.installSource === "bun") {
    roots.push(rootPath.resolve(input.canonicalInstallRoot, "..", "..", "bin", "bun"));
  } else if (input.installSource === "pnpm") {
    const normalizedRoot = normalizeCommandPath(input.canonicalInstallRoot, input.platform);
    const globalIndex = normalizedRoot.lastIndexOf("/global/");
    if (globalIndex > 0) {
      roots.push(rootPath.join(input.canonicalInstallRoot.slice(0, globalIndex), "pnpm"));
    }
  } else {
    roots.push(rootPath.join(input.canonicalInstallRoot, "bin", "brew"));
  }

  const configuredPath =
    input.platform === "win32"
      ? readEffectiveWindowsEnvironmentValue(input.env, "PATH")
      : input.env.PATH;
  const pathEntries = (configuredPath ?? "")
    .split(input.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (input.platform === "win32") {
    roots.push(managerName);
  } else {
    for (const entry of pathEntries) {
      roots.push(commandPathImplementation(input.platform).join(entry, managerName));
    }
  }

  const candidates: Array<{ readonly visiblePath: string; readonly requestedDirectory: string }> =
    [];
  const seenRoots = new Set<string>();
  for (const candidate of roots) {
    const normalizedRoot = normalizeCommandPath(candidate, input.platform);
    if (seenRoots.has(normalizedRoot)) continue;
    seenRoots.add(normalizedRoot);
    candidates.push(
      ...(await managerExecutablePathCandidates(
        candidate,
        input.platform,
        input.env,
        input.resolveWindowsCommandCandidates,
      )),
    );
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = `${normalizeCommandPath(candidate.visiblePath, input.platform)}\0${normalizeCommandPath(candidate.requestedDirectory, input.platform)}`;
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

const resolveManagerExecutable = Effect.fn("resolveProviderMaintenanceManager")(function* (
  input: {
    readonly installSource: Exclude<ActionableProviderInstallSource, "native">;
    readonly canonicalInstallRoot: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly preferredManagerExecutablePath?: string | null;
    readonly resolveWindowsCommandCandidates: ResolveWindowsCommandCandidates;
  },
  fileSystem: FileSystem.FileSystem,
) {
  const candidates = yield* Effect.promise(() => managerCandidatePaths(input));
  for (const candidate of candidates) {
    const path = commandPathImplementation(input.platform);
    if (!path.isAbsolute(candidate.visiblePath)) {
      continue;
    }
    const stat = yield* fileSystem
      .stat(candidate.visiblePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat?.type !== "File") {
      continue;
    }
    if (
      !managerMatchesInstallRoot({
        installSource: input.installSource,
        managerExecutablePath: candidate.visiblePath,
        canonicalInstallRoot: input.canonicalInstallRoot,
        platform: input.platform,
      })
    ) {
      continue;
    }
    let canonicalRequestedDirectory: Effect.Success<ReturnType<typeof inspectCanonicalDirectory>> =
      null;
    if (input.platform === "win32") {
      const [requestedDirectory, visibleDirectory] = yield* Effect.all([
        inspectCanonicalDirectory(fileSystem, candidate.requestedDirectory),
        inspectCanonicalDirectory(fileSystem, path.dirname(candidate.visiblePath)),
      ]);
      if (
        !requestedDirectory ||
        !visibleDirectory ||
        !canonicalDirectoriesMatch(requestedDirectory, visibleDirectory, input.platform)
      ) {
        continue;
      }
      canonicalRequestedDirectory = requestedDirectory;
    }
    const canonicalPath = yield* fileSystem
      .realPath(candidate.visiblePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!canonicalPath) {
      continue;
    }
    if (canonicalRequestedDirectory !== null) {
      const canonicalPathDirectory = yield* inspectCanonicalDirectory(
        fileSystem,
        path.dirname(canonicalPath),
      );
      if (
        !canonicalPathDirectory ||
        !canonicalDirectoriesMatch(
          canonicalRequestedDirectory,
          canonicalPathDirectory,
          input.platform,
        )
      ) {
        continue;
      }
    }
    return { visiblePath: candidate.visiblePath, canonicalPath };
  }
  return null;
});

const resolveWindowsNpmManagerCommand = Effect.fn("resolveWindowsNpmManagerCommand")(function* (
  input: {
    readonly canonicalInstallRoot: string;
    readonly canonicalManagerExecutablePath: string;
  },
  fileSystem: FileSystem.FileSystem,
) {
  const path = commandPathImplementation("win32");
  const canonicalManagerDirectory = path.dirname(input.canonicalManagerExecutablePath);
  const expectedNodePath = path.join(canonicalManagerDirectory, "node.exe");
  const resolveExactFile = (candidate: string) =>
    Effect.gen(function* () {
      const stat = yield* fileSystem.stat(candidate).pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat?.type !== "File") {
        return null;
      }
      const canonicalPath = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      return canonicalPath &&
        normalizeCommandPath(canonicalPath, "win32") === normalizeCommandPath(candidate, "win32")
        ? canonicalPath
        : null;
    });
  const nodeExecutablePath = yield* resolveExactFile(expectedNodePath);
  if (!nodeExecutablePath) {
    return null;
  }

  const npmCliCandidates = [
    path.join(input.canonicalInstallRoot, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(canonicalManagerDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(
    (candidate, index, candidates) =>
      candidates.findIndex(
        (other) =>
          normalizeCommandPath(other, "win32") === normalizeCommandPath(candidate, "win32"),
      ) === index,
  );
  for (const candidate of npmCliCandidates) {
    const npmCliPath = yield* resolveExactFile(candidate);
    if (npmCliPath) {
      return {
        executablePath: nodeExecutablePath,
        argsPrefix: [npmCliPath],
      } satisfies ProviderMaintenanceManagerCommandIdentity;
    }
  }
  return null;
});

const resolvePackageChannelEvidence = Effect.fn("resolveProviderPackageChannelEvidence")(function* (
  input: {
    readonly definition: PackageManagedProviderMaintenanceDefinition;
    readonly canonicalCommandPath: string;
    readonly canonicalInstallRoot: string;
    readonly packageManifestPath: string;
    readonly platform: NodeJS.Platform;
  },
  fileSystem: FileSystem.FileSystem,
) {
  const packageName = input.definition.npmPackageName;
  if (!packageName) {
    return null;
  }
  const manifestContents = yield* fileSystem
    .readFileString(input.packageManifestPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!manifestContents) {
    return null;
  }
  const installedVersion = stablePackageVersion(input.definition, manifestContents);
  const packageBinTarget = parseVerifiedNpmPackageBinTarget(input.definition, manifestContents);
  if (!installedVersion || !packageBinTarget) {
    return null;
  }
  const expectedPackageBinPath = packageBinPath(
    input.packageManifestPath,
    packageBinTarget,
    input.platform,
  );
  const packageBinStat = yield* fileSystem
    .stat(expectedPackageBinPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (packageBinStat?.type !== "File") {
    return null;
  }
  const canonicalPackageBinPath = yield* fileSystem
    .realPath(expectedPackageBinPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (
    !canonicalPackageBinPath ||
    normalizeCommandPath(canonicalPackageBinPath, input.platform) !==
      normalizeCommandPath(input.canonicalCommandPath, input.platform)
  ) {
    return null;
  }

  const rootPackageJson = commandPathImplementation(input.platform).join(
    input.canonicalInstallRoot,
    "package.json",
  );
  for (const metadataPath of [input.packageManifestPath, rootPackageJson]) {
    const metadataContents = yield* fileSystem
      .readFileString(metadataPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const metadata = metadataContents ? parseJsonObject(metadataContents) : null;
    if (!metadata || !metadataProvesLatestPackageTag(metadata, packageName)) {
      continue;
    }
    const canonicalMetadataPath = yield* fileSystem
      .realPath(metadataPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!canonicalMetadataPath) {
      return null;
    }
    return {
      kind: "package-dist-tag" as const,
      tag: "latest" as const,
      installedVersion,
      metadataPath: canonicalMetadataPath,
    } satisfies ProviderPackageChannelEvidence;
  }
  return null;
});

const resolveWindowsNpmShimDetails = Effect.fn("resolveWindowsNpmShimDetails")(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
  fileSystem: FileSystem.FileSystem,
) {
  const evidence = resolveWindowsNpmShimEvidence(definition, commandPath);
  if (!evidence) {
    return null;
  }
  const packageManifestContents = yield* fileSystem
    .readFileString(evidence.packageManifestPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  const shimContents = yield* fileSystem
    .readFileString(commandPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!packageManifestContents || !shimContents) {
    return null;
  }
  const packageBinTarget = parseVerifiedNpmPackageBinTarget(definition, packageManifestContents);
  if (
    !packageBinTarget ||
    !windowsNpmShimLinksToPackageBin({ definition, packageBinTarget, shimContents })
  ) {
    return null;
  }
  const linkedPackageBinPath = packageBinPath(
    evidence.packageManifestPath,
    packageBinTarget,
    "win32",
  );
  const linkedStat = yield* fileSystem
    .stat(linkedPackageBinPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (linkedStat?.type !== "File") {
    return null;
  }
  const canonicalCommandPath = yield* fileSystem
    .realPath(linkedPackageBinPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  return canonicalCommandPath
    ? { canonicalCommandPath, packageManifestPath: evidence.packageManifestPath }
    : null;
});

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const visibleCommandPath = nonEmptyString(options?.binaryPath);
  const canonicalCommandPath = nonEmptyString(options?.realCommandPath);
  if (!visibleCommandPath || !canonicalCommandPath) {
    return manualCapabilities(definition);
  }
  const platform = options?.platform ?? process.platform;
  const installSource = detectInstallSource(
    definition,
    visibleCommandPath,
    canonicalCommandPath,
    platform,
  );
  const target = makeMaintenanceTarget({
    definition,
    platform,
    installSource,
    visibleCommandPath,
    canonicalCommandPath,
    canonicalInstallRoot: nonEmptyString(options?.canonicalInstallRoot),
    managerExecutablePath: nonEmptyString(options?.managerExecutablePath),
    canonicalManagerExecutablePath: nonEmptyString(options?.realManagerExecutablePath),
    managerCommand: options?.managerCommand ?? null,
    packageChannelEvidence: options?.packageChannelEvidence ?? null,
  });
  return target
    ? makeProviderMaintenanceForInstallSource({ definition, installSource, target })
    : manualCapabilities(definition);
}

const resolveVerifiedCandidateMaintenance = Effect.fn("resolveVerifiedCandidateMaintenance")(
  function* (
    input: {
      readonly definition: PackageManagedProviderMaintenanceDefinition;
      readonly visibleCommandPath: string;
      readonly canonicalCommandPath: string;
      readonly packageManifestPath?: string | null;
      readonly env: NodeJS.ProcessEnv;
      readonly platform: NodeJS.Platform;
      readonly preferredManagerExecutablePath?: string | null;
      readonly resolveWindowsCommandCandidates: ResolveWindowsCommandCandidates;
    },
    fileSystem: FileSystem.FileSystem,
  ) {
    const installSource = detectInstallSource(
      input.definition,
      input.visibleCommandPath,
      input.canonicalCommandPath,
      input.platform,
    );
    if (!isInstallSourceAllowed(input.definition, installSource)) {
      return manualCapabilities(input.definition);
    }

    if (installSource === "native") {
      const installRoot =
        input.definition.nativeUpdate?.resolveInstallRoot?.({
          visibleCommandPath: input.visibleCommandPath,
          canonicalCommandPath: input.canonicalCommandPath,
          platform: input.platform,
        }) ?? deriveCanonicalInstallRoot("native", input.canonicalCommandPath, input.platform);
      if (!installRoot) {
        return manualCapabilities(input.definition);
      }
      const canonicalInstallRoot = yield* canonicalizeDirectory(fileSystem, installRoot);
      return canonicalInstallRoot
        ? resolvePackageManagedProviderMaintenance(input.definition, {
            binaryPath: input.visibleCommandPath,
            realCommandPath: input.canonicalCommandPath,
            platform: input.platform,
            canonicalInstallRoot,
            managerExecutablePath: input.visibleCommandPath,
            realManagerExecutablePath: input.canonicalCommandPath,
          })
        : manualCapabilities(input.definition);
    }

    const installRoot = deriveCanonicalInstallRoot(
      installSource,
      input.canonicalCommandPath,
      input.platform,
    );
    if (!installRoot) {
      return manualCapabilities(input.definition);
    }
    const canonicalInstallRoot = yield* canonicalizeDirectory(fileSystem, installRoot);
    if (
      !canonicalInstallRoot ||
      normalizeCommandPath(canonicalInstallRoot, input.platform) !==
        normalizeCommandPath(installRoot, input.platform)
    ) {
      return manualCapabilities(input.definition);
    }
    const manager = yield* resolveManagerExecutable(
      {
        installSource,
        canonicalInstallRoot,
        env: input.env,
        platform: input.platform,
        resolveWindowsCommandCandidates: input.resolveWindowsCommandCandidates,
        ...(input.preferredManagerExecutablePath !== undefined
          ? { preferredManagerExecutablePath: input.preferredManagerExecutablePath }
          : {}),
      },
      fileSystem,
    );
    if (!manager) {
      return manualCapabilities(input.definition);
    }
    const managerCommand =
      input.platform === "win32" && installSource === "npm"
        ? yield* resolveWindowsNpmManagerCommand(
            {
              canonicalInstallRoot,
              canonicalManagerExecutablePath: manager.canonicalPath,
            },
            fileSystem,
          )
        : null;
    if (input.platform === "win32" && installSource === "npm" && !managerCommand) {
      return manualCapabilities(input.definition);
    }

    let packageChannelEvidence: ProviderPackageChannelEvidence | null = null;
    if (installSource === "npm" || installSource === "bun" || installSource === "pnpm") {
      const packageManifestPath =
        input.packageManifestPath ??
        derivePackageManifestPath(input.definition, input.canonicalCommandPath, input.platform);
      if (!packageManifestPath) {
        return manualCapabilities(input.definition);
      }
      packageChannelEvidence = yield* resolvePackageChannelEvidence(
        {
          definition: input.definition,
          canonicalCommandPath: input.canonicalCommandPath,
          canonicalInstallRoot,
          packageManifestPath,
          platform: input.platform,
        },
        fileSystem,
      );
      if (!packageChannelEvidence) {
        return manualCapabilities(input.definition);
      }
    }

    return resolvePackageManagedProviderMaintenance(input.definition, {
      binaryPath: input.visibleCommandPath,
      realCommandPath: input.canonicalCommandPath,
      platform: input.platform,
      canonicalInstallRoot,
      managerExecutablePath: manager.visiblePath,
      realManagerExecutablePath: manager.canonicalPath,
      ...(managerCommand ? { managerCommand } : {}),
      packageChannelEvidence,
    });
  },
);

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
  dependencies?: ProviderMaintenanceCapabilityResolutionDependencies,
) {
  const binaryPath = nonEmptyString(options?.binaryPath) ?? definition.binaryName;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const pathEntries = (env.PATH ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let unresolvedCandidates: ReadonlyArray<string>;
  if (platform === "win32") {
    const resolveWindowsCommandPath =
      dependencies?.resolveWindowsCommandPath ?? resolveRuntimeWindowsCommandPathAsync;
    const selectedCommandPath = yield* Effect.promise(async () =>
      resolveWindowsCommandPath(binaryPath, { env, platform }),
    );
    unresolvedCandidates = commandPathImplementation(platform).isAbsolute(selectedCommandPath)
      ? [selectedCommandPath]
      : [];
  } else {
    unresolvedCandidates = hasPathSeparator(binaryPath)
      ? [binaryPath]
      : pathEntries.map((entry) => commandPathImplementation(platform).join(entry, binaryPath));
  }

  for (const candidate of unresolvedCandidates) {
    const commandStat = yield* fileSystem
      .stat(candidate)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (commandStat?.type !== "File") {
      continue;
    }
    const canonicalCandidate = yield* fileSystem
      .realPath(candidate)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!canonicalCandidate) {
      return manualCapabilities(definition);
    }

    let canonicalCommandPath = canonicalCandidate;
    let packageManifestPath: string | null = null;
    if (detectInstallSource(definition, candidate, canonicalCommandPath, platform) === "unknown") {
      if (platform !== "win32") {
        return manualCapabilities(definition);
      }
      const npmShim = yield* resolveWindowsNpmShimDetails(definition, candidate, fileSystem);
      if (!npmShim) {
        return manualCapabilities(definition);
      }
      canonicalCommandPath = npmShim.canonicalCommandPath;
      packageManifestPath = npmShim.packageManifestPath;
    }

    return yield* resolveVerifiedCandidateMaintenance(
      {
        definition,
        visibleCommandPath: candidate,
        canonicalCommandPath,
        packageManifestPath,
        env,
        platform,
        resolveWindowsCommandCandidates:
          dependencies?.resolveWindowsCommandCandidates ??
          resolveRuntimeWindowsCommandCandidatesAsync,
        ...(options?.managerExecutablePath !== undefined
          ? { preferredManagerExecutablePath: options.managerExecutablePath }
          : {}),
      },
      fileSystem,
    );
  }

  return manualCapabilities(definition);
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion || !input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly provider: ProviderKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({ provider: input.provider, packageName: null });
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

async function fetchNpmLatestVersion(packageName: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(LATEST_VERSION_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { version?: unknown };
    return nonEmptyString(payload.version);
  } catch {
    return null;
  }
}

async function fetchHomebrewLatestVersion(
  source: ProviderLatestVersionSource,
): Promise<string | null> {
  if (source.kind !== "homebrew" || !source.homebrewKind) {
    return null;
  }
  try {
    const response = await fetch(
      `https://formulae.brew.sh/api/${source.homebrewKind}/${encodeURIComponent(source.name)}.json`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(LATEST_VERSION_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      version?: unknown;
      versions?: { stable?: unknown };
    };
    return nonEmptyString(
      source.homebrewKind === "cask" ? payload.version : payload.versions?.stable,
    );
  } catch {
    return null;
  }
}

function fetchLatestProviderVersion(source: ProviderLatestVersionSource): Promise<string | null> {
  return source.kind === "homebrew"
    ? fetchHomebrewLatestVersion(source)
    : fetchNpmLatestVersion(source.name);
}

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
  options?: { readonly forceRefresh?: boolean },
) {
  const source = maintenanceCapabilities.latestVersionSource;
  if (!source) {
    return null;
  }

  const cacheKey =
    source.kind === "homebrew"
      ? `homebrew:${source.homebrewKind ?? "unknown"}:${source.name}`
      : `npm:${source.name}`;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const forceRefresh = options?.forceRefresh === true;
  const inFlight = latestVersionInFlightRequests.get(cacheKey);

  // Once a forced generation starts, later readers join it instead of observing
  // the cache entry it is replacing. Concurrent forced callers also share that
  // generation, while a forced caller supersedes an older normal request.
  if (inFlight && (!forceRefresh || inFlight.forceRefresh)) {
    return yield* Effect.promise(() => inFlight.promise);
  }

  const cached = latestVersionCache.get(cacheKey);
  if (
    !forceRefresh &&
    cached &&
    cached.generation === latestVersionGenerations.get(cacheKey) &&
    cached.expiresAt > now
  ) {
    return cached.version;
  }

  const generation = (latestVersionGenerations.get(cacheKey) ?? 0) + 1;
  latestVersionGenerations.set(cacheKey, generation);
  const promise = fetchLatestProviderVersion(source).then((version) => {
    const currentRequest = latestVersionInFlightRequests.get(cacheKey);
    if (
      latestVersionGenerations.get(cacheKey) === generation &&
      currentRequest?.generation === generation
    ) {
      latestVersionCache.set(cacheKey, {
        expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
        generation,
        version,
      });
      latestVersionInFlightRequests.delete(cacheKey);
    }
    return version;
  });
  latestVersionInFlightRequests.set(cacheKey, { forceRefresh, generation, promise });
  return yield* Effect.promise(() => promise);
});

export const enrichProviderStatusWithVersionAdvisory = Effect.fn(
  "enrichProviderStatusWithVersionAdvisory",
)(function* (
  status: ServerProviderStatus,
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
  options?: {
    readonly forceRefresh?: boolean;
    readonly useAdvisoryLatestVersionSource?: boolean;
  },
) {
  if (!status.available || !status.version) {
    return {
      ...status,
      versionAdvisory: createProviderVersionAdvisory({
        provider: status.provider,
        currentVersion: status.version ?? null,
        checkedAt: status.checkedAt,
        maintenanceCapabilities,
      }),
    };
  }

  const advisoryCapabilities =
    options?.useAdvisoryLatestVersionSource === true &&
    maintenanceCapabilities.latestVersionSource === null &&
    maintenanceCapabilities.advisoryLatestVersionSource !== null
      ? {
          ...maintenanceCapabilities,
          latestVersionSource: maintenanceCapabilities.advisoryLatestVersionSource,
        }
      : maintenanceCapabilities;
  const latestVersion = yield* resolveLatestProviderVersion(
    advisoryCapabilities,
    options?.forceRefresh === undefined ? undefined : { forceRefresh: options.forceRefresh },
  );
  return {
    ...status,
    versionAdvisory: createProviderVersionAdvisory({
      provider: status.provider,
      currentVersion: status.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities,
    }),
  };
});
