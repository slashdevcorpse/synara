/**
 * ProviderHealthLive - Cache-backed provider health service.
 *
 * Seeds provider status from disk cache when available, then refreshes from
 * CLI probes without blocking the rest of server startup.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as OS from "node:os";
import * as NodePath from "node:path";
import type {
  ProviderKind,
  ServerSettings,
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
  ServerProviderUpdateState,
} from "@synara/contracts";
import { ServerProviderUpdateError } from "@synara/contracts";
import {
  resolveCodexCliExecutableAsync,
  resolveCodexCliExecutableWithDiscoveryAsync,
} from "@synara/shared/codexCliExecutable";
import {
  resolveCommandCodeCliExecutableAsync,
  resolveCommandCodeCliExecutableWithDiscoveryAsync,
} from "@synara/shared/commandCodeCliExecutable";
import { parseCodexConfigModelProvider } from "@synara/shared/codexConfig";
import { decodeJsonResult } from "@synara/shared/schemaJson";
import type { WindowsCommandDiscoveryOutcome } from "@synara/shared/windowsProcess";
import {
  query as claudeQuery,
  type SDKUserMessage,
  type SpawnOptions as ClaudeSpawnOptions,
  type SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Array,
  Cache,
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ServerConfig } from "../../config";
import {
  buildProviderChildEnvironment,
  type ProviderChildKind,
} from "../../providerChildEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings";
import { isWindowsShellCommandMissingResult } from "../../shell-command-detection";
import {
  buildCursorAgentCommand,
  buildCursorAgentHeadlessEnv,
  DEFAULT_CURSOR_AGENT_BINARY,
  resolveCursorAgentBinaryPath,
} from "../acp/CursorAcpCommand";
import { hasDroidApiKeyEnv, resolveDroidCliBinaryPath } from "../acp/DroidAcpSupport";
import { hasGrokApiKeyEnv } from "../acp/GrokAcpSupport";
import {
  claudeAuthMetadata,
  isStructuredClaudeAuthFalseNegativeCandidate,
  parseClaudeAuthStatusFromOutput,
} from "../claudeAuthStatus";
import { acquireClaudeAuthStatusLock } from "../claudeAuthStatusLock";
import { buildClaudeProcessEnv, readClaudeCliCredentialsSummary } from "../claudeProcessEnv";
import {
  ANTIGRAVITY_WINDOWS_UNAVAILABLE_MESSAGE,
  isAntigravityAvailableOnPlatform,
} from "../antigravityAvailability.ts";
import { buildOpenCodeCompatibleProcessEnv } from "../openCodeProcessEnv.ts";
import {
  buildDroidMaintenanceProcessEnv,
  buildDroidRuntimeProcessEnv,
} from "../droidProcessEnv.ts";
import {
  detailFromResult,
  extractAuthBoolean,
  extractAuthMethod,
  nonEmptyTrimmed,
  PROVIDER_COMMAND_TIMEOUT_DETAIL,
  toTitleCaseWords,
  type CommandResult,
} from "../providerCliOutput";
import { buildPiProcessEnv } from "../piProcessEnv.ts";
import { probeProviderCliVersion } from "../providerCliVersionProbe";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import { ProviderService } from "../Services/ProviderService";
import {
  orderProviderStatuses,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";
import { makeProviderMaintenanceCommandCoordinator } from "../providerMaintenanceCommandCoordinator";
import {
  makeProviderMaintenanceOwnedResourceCoordinator,
  type ProviderMaintenanceOwnedResourceCoordinator,
  type ProviderMaintenanceOwnedResourceRegistration,
} from "../providerMaintenanceOwnedResources";
import {
  isWindowsJobPreparedCommand,
  prepareWindowsProviderProcessAsync,
  WindowsProviderTargetNotResolvedError,
} from "../windowsProviderProcess.ts";
import {
  enrichProviderStatusWithVersionAdvisory,
  compareSemverVersions,
  makeCommandPathSuffixMatcher,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  parseGenericCliVersion,
  providerMaintenanceTargetsShareUpdateDestination,
  resolveProviderMaintenanceCapabilitiesEffect,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText";
import { buildCodexProcessEnv } from "../../codexProcessEnv.ts";
import type { ProcessTreeKiller } from "../../terminal/processTreeKiller.ts";
import {
  makeProviderMaintenanceGate,
  ProviderMaintenanceBusyError,
  type ProviderMaintenanceGate,
} from "../providerMaintenanceGate.ts";
import { quiesceProviderRuntimesForUpdate } from "../providerUpdateQuiescence.ts";
import { classifyCompletedProviderUpdate } from "../providerUpdateOutcome.ts";
import {
  shouldRetryDelayedProviderUpdateVersion,
  shouldRunWindowsDroidNativeUpdateFinalizer,
  verifyDelayedProviderUpdateVersion,
  type ProviderUpdateVerificationSnapshot,
} from "../providerUpdateVerification.ts";
import {
  findProviderProcessExitUnprovenError,
  ProviderProcessExitUnprovenError,
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "../supervisedProcessTeardown.ts";
import {
  containedClaudeSdkProcessDidNotSpawn,
  prepareContainedClaudeSdkProcess,
  spawnContainedClaudeSdkProcess,
  type ContainedClaudeSdkProcessPreparation,
} from "../containedClaudeSdkProcess.ts";
import {
  installPreparedEffectProcessSupervisor,
  supervisePreparedEffectProcess,
  supervisePreparedNodeProcess,
  type SupervisePreparedEffectProcessOptions,
  WindowsJobProcessExitUnprovenError,
  windowsJobNodeProcessSupervisor,
} from "../windowsJobProcessSupervisor.ts";

export { parseClaudeAuthStatusFromOutput } from "../claudeAuthStatus";
export type { CommandResult } from "../providerCliOutput";

const DEFAULT_TIMEOUT_MS = 4_000;
const CLAUDE_HEALTH_TIMEOUT_MS = 20_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 20_000;
const CODEX_PROVIDER = "codex" as const;
const COMMAND_CODE_PROVIDER = "commandCode" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
const CURSOR_PROVIDER = "cursor" as const;
const ANTIGRAVITY_PROVIDER = "antigravity" as const;
const GROK_PROVIDER = "grok" as const;
const DROID_PROVIDER = "droid" as const;
const KILO_PROVIDER = "kilo" as const;
const OPENCODE_PROVIDER = "opencode" as const;
const PI_PROVIDER = "pi" as const;
type ProviderStatuses = ReadonlyArray<ServerProviderStatus>;
const DISABLED_PROVIDER_STATUS_MESSAGE = "Provider is disabled in Synara settings.";
const MINIMUM_ANTIGRAVITY_CLI_VERSION = "1.0.12";

function makeAntigravityWindowsUnavailableStatus(
  checkedAt = new Date().toISOString(),
): ServerProviderStatus {
  return {
    provider: ANTIGRAVITY_PROVIDER,
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt,
    message: ANTIGRAVITY_WINDOWS_UNAVAILABLE_MESSAGE,
  };
}

const PROVIDERS = [
  CODEX_PROVIDER,
  COMMAND_CODE_PROVIDER,
  CLAUDE_AGENT_PROVIDER,
  CURSOR_PROVIDER,
  ANTIGRAVITY_PROVIDER,
  GROK_PROVIDER,
  DROID_PROVIDER,
  KILO_PROVIDER,
  OPENCODE_PROVIDER,
  PI_PROVIDER,
] as const satisfies ReadonlyArray<ProviderKind>;

const providerChildKind = (provider: ProviderKind): ProviderChildKind =>
  provider === CLAUDE_AGENT_PROVIDER ? "claude" : provider;

const providerCommandEnv = (provider: ProviderKind): NodeJS.ProcessEnv =>
  buildProviderChildEnvironment({ provider: providerChildKind(provider) });

export function buildProviderUpdateProcessEnv(input: {
  readonly provider: ProviderKind;
  readonly pathPrepend?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const baseEnv =
    input.provider === DROID_PROVIDER
      ? buildDroidMaintenanceProcessEnv({
          baseEnv: input.baseEnv ?? process.env,
          platform,
        })
      : buildProviderChildEnvironment({
          provider: providerChildKind(input.provider),
          baseEnv: input.baseEnv ?? process.env,
          platform,
        });
  return input.pathPrepend
    ? {
        ...baseEnv,
        PATH: [input.pathPrepend, baseEnv.PATH]
          .filter((entry): entry is string => Boolean(entry))
          .join(platform === "win32" ? ";" : ":"),
      }
    : baseEnv;
}

const UPDATE_OUTPUT_MAX_BYTES = 10_000;
export const PROVIDER_UPDATE_TIMEOUT_MS = 2 * 60_000;

function formatProviderUpdateTimeout(timeoutMs: number): string {
  if (timeoutMs < 1_000) {
    return `${timeoutMs} ${timeoutMs === 1 ? "millisecond" : "milliseconds"}`;
  }
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = timeoutMs / 1_000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function isClaudeNativeCommandPath(commandPath: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizeCommandPath(commandPath, platform);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

function isOpenCodeNativeCommandPath(commandPath: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizeCommandPath(commandPath, platform);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

function isKiloNativeCommandPath(commandPath: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizeCommandPath(commandPath, platform);
  return (
    normalized.endsWith("/.kilo/bin/kilo") ||
    normalized.endsWith("/.local/bin/kilo") ||
    normalized.includes("/.local/share/kilo/bin/")
  );
}

class ProviderHealthProcessExitUnprovenError extends ProviderProcessExitUnprovenError {
  override readonly cause: unknown;

  constructor(rootPid: number, cause: unknown) {
    super({
      rootPid,
      rootExited: false,
      remainingDescendantPids: null,
      captureComplete: false,
    });
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.name = "ProviderHealthProcessExitUnprovenError";
    this.message = `Provider health process ${rootPid} did not prove complete exit. ${detail}`;
    this.cause = cause;
  }
}

function normalizeProviderHealthExitFailure(
  cause: unknown,
  rootPid: number,
  exactWindowsOwner: boolean,
): ProviderProcessExitUnprovenError {
  return (
    findProviderProcessExitUnprovenError(cause) ??
    (exactWindowsOwner
      ? new WindowsJobProcessExitUnprovenError(rootPid, cause)
      : new ProviderHealthProcessExitUnprovenError(rootPid, cause))
  );
}

const isAntigravityNativeCommandPath = makeCommandPathSuffixMatcher([
  "/.local/bin/agy",
  "/AppData/Local/agy/bin/agy.exe",
]);

function isWindowsDroidNativeCommandPath(commandPath: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32" || !NodePath.win32.isAbsolute(commandPath)) return false;
  const normalized = normalizeCommandPath(commandPath, platform);
  return normalized.endsWith("/droid.exe") || normalized.endsWith("/droid.com");
}

function isCursorAgentNativeCommandPath(commandPath: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizeCommandPath(commandPath, platform);
  return (
    normalized.includes("/.local/share/cursor-agent/") &&
    (normalized.endsWith("/cursor-agent") || normalized.endsWith("/cursor-agent.exe"))
  );
}

function installRootThroughMarker(
  input: {
    readonly visibleCommandPath: string;
    readonly canonicalCommandPath: string;
    readonly platform: NodeJS.Platform;
  },
  markers: ReadonlyArray<string>,
): string | null {
  for (const commandPath of [input.canonicalCommandPath, input.visibleCommandPath]) {
    const normalized = normalizeCommandPath(commandPath, input.platform);
    for (const rawMarker of markers) {
      const marker = normalizeCommandPath(rawMarker, input.platform);
      const markerIndex = normalized.indexOf(marker);
      if (markerIndex >= 0) {
        return commandPath.slice(0, markerIndex + marker.length);
      }
    }
  }
  return null;
}

const resolveClaudeNativeInstallRoot = (input: {
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly platform: NodeJS.Platform;
}) => installRootThroughMarker(input, ["/.local/share/claude"]);

const resolveAntigravityNativeInstallRoot = (input: {
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly platform: NodeJS.Platform;
}) => installRootThroughMarker(input, ["/AppData/Local/agy"]);

const resolveDroidNativeInstallRoot = (input: {
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly platform: NodeJS.Platform;
}) =>
  isWindowsDroidNativeCommandPath(input.canonicalCommandPath, input.platform)
    ? NodePath.win32.dirname(input.canonicalCommandPath)
    : null;

const resolveKiloNativeInstallRoot = (input: {
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly platform: NodeJS.Platform;
}) => installRootThroughMarker(input, ["/.kilo", "/.local/share/kilo"]);

const resolveOpenCodeNativeInstallRoot = (input: {
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly platform: NodeJS.Platform;
}) => installRootThroughMarker(input, ["/.opencode"]);

const resolveCursorAgentNativeInstallRoot = (input: {
  readonly visibleCommandPath: string;
  readonly canonicalCommandPath: string;
  readonly platform: NodeJS.Platform;
}) => installRootThroughMarker(input, ["/.local/share/cursor-agent"]);

const isCodexStandaloneCommandPath = makeCommandPathSuffixMatcher([
  "/Programs/OpenAI/Codex/bin/codex.exe",
]);

const isWindowsCodexStandaloneCommandPath = (
  commandPath: string,
  platform: NodeJS.Platform,
): boolean => platform === "win32" && isCodexStandaloneCommandPath(commandPath, platform);

export const PACKAGE_MANAGED_PROVIDER_UPDATES: Partial<
  Record<ProviderKind, PackageManagedProviderMaintenanceDefinition>
> = {
  codex: {
    provider: CODEX_PROVIDER,
    binaryName: "codex",
    npmPackageName: "@openai/codex",
    allowedInstallSources: ["npm", "bun", "pnpm", "homebrew", "native"],
    homebrew: { name: "codex", kind: "cask" },
    advisoryLatestVersionSource: { kind: "npm", name: "@openai/codex" },
    nativeUpdate: {
      executable: "codex",
      args: () => ["update"],
      lockKey: "codex-native",
      strategy: "matching-path",
      isCommandPath: isWindowsCodexStandaloneCommandPath,
      isVisibleCommandPath: ({ visibleCommandPath, platform }) =>
        isWindowsCodexStandaloneCommandPath(visibleCommandPath, platform),
      resolveInstallRoot: ({ visibleCommandPath, platform }) =>
        isWindowsCodexStandaloneCommandPath(visibleCommandPath, platform)
          ? NodePath.win32.dirname(NodePath.win32.dirname(visibleCommandPath))
          : null,
    },
  },
  commandCode: {
    provider: COMMAND_CODE_PROVIDER,
    binaryName: "commandcode",
    allowedBinaryNames: ["cmd", "cmdc", "command-code", "commandcode"],
    npmPackageName: "command-code",
    allowedInstallSources: ["npm"],
    homebrew: null,
    advisoryLatestVersionSource: { kind: "npm", name: "command-code" },
    nativeUpdate: null,
  },
  claudeAgent: {
    provider: CLAUDE_AGENT_PROVIDER,
    binaryName: "claude",
    npmPackageName: "@anthropic-ai/claude-code",
    allowedInstallSources: ["npm", "homebrew", "native"],
    homebrew: { name: "claude-code", kind: "cask" },
    nativeUpdate: {
      executable: "claude",
      args: () => ["update"],
      lockKey: "claude-native",
      strategy: "matching-path",
      isCommandPath: isClaudeNativeCommandPath,
      resolveInstallRoot: resolveClaudeNativeInstallRoot,
    },
  },
  antigravity: {
    provider: ANTIGRAVITY_PROVIDER,
    binaryName: "agy",
    // Antigravity is distributed as a native binary and owns its update channel.
    npmPackageName: null,
    allowedInstallSources: ["native"],
    homebrew: null,
    latestVersionSource: null,
    nativeUpdate: {
      executable: "agy",
      args: () => ["update"],
      lockKey: "antigravity-native",
      strategy: "matching-path",
      isCommandPath: isAntigravityNativeCommandPath,
      resolveInstallRoot: resolveAntigravityNativeInstallRoot,
    },
  },
  droid: {
    provider: DROID_PROVIDER,
    binaryName: "droid",
    allowedBinaryNames: ["droid"],
    npmPackageName: "droid",
    allowedInstallSources: ["npm", "native"],
    homebrew: null,
    advisoryLatestVersionSource: { kind: "npm", name: "droid" },
    nativeUpdate: {
      executable: "droid",
      args: () => ["update"],
      lockKey: "droid-native",
      strategy: "matching-path",
      isCommandPath: isWindowsDroidNativeCommandPath,
      resolveInstallRoot: resolveDroidNativeInstallRoot,
    },
  },
  kilo: {
    provider: KILO_PROVIDER,
    binaryName: "kilo",
    npmPackageName: "@kilocode/cli",
    allowedInstallSources: ["npm", "native"],
    homebrew: null,
    nativeUpdate: {
      executable: "kilo",
      args: () => ["upgrade"],
      lockKey: "kilo-native",
      strategy: "matching-path",
      isCommandPath: isKiloNativeCommandPath,
      resolveInstallRoot: resolveKiloNativeInstallRoot,
    },
  },
  opencode: {
    provider: OPENCODE_PROVIDER,
    binaryName: "opencode",
    npmPackageName: "opencode-ai",
    allowedInstallSources: ["npm", "bun", "pnpm", "homebrew", "native"],
    homebrew: { name: "anomalyco/tap/opencode", kind: "formula" },
    advisoryLatestVersionSource: { kind: "npm", name: "opencode-ai" },
    nativeUpdate: {
      executable: "opencode",
      args: (installSource) =>
        installSource === "unknown" || installSource === "native"
          ? ["upgrade"]
          : ["upgrade", "--method", installSource],
      lockKey: "opencode-native",
      strategy: "matching-path",
      excludedInstallSources: ["homebrew"],
      isCommandPath: isOpenCodeNativeCommandPath,
      resolveInstallRoot: resolveOpenCodeNativeInstallRoot,
    },
  },
  pi: {
    provider: PI_PROVIDER,
    binaryName: "pi",
    npmPackageName: "@earendil-works/pi-coding-agent",
    allowedInstallSources: ["npm", "bun", "pnpm"],
    npmInstallFlags: ["--ignore-scripts"],
    homebrew: null,
    nativeUpdate: null,
  },
  cursor: {
    provider: CURSOR_PROVIDER,
    binaryName: "cursor-agent",
    npmPackageName: null,
    allowedInstallSources: ["native"],
    homebrew: null,
    latestVersionSource: null,
    nativeUpdate: {
      executable: "cursor-agent",
      args: () => ["update"],
      lockKey: "cursor-agent-native",
      strategy: "matching-path",
      isCommandPath: isCursorAgentNativeCommandPath,
      resolveInstallRoot: resolveCursorAgentNativeInstallRoot,
    },
  },
};

const LEGACY_FACTORY_DROID_NPM_UPDATE: PackageManagedProviderMaintenanceDefinition = {
  provider: DROID_PROVIDER,
  binaryName: "droid",
  allowedBinaryNames: ["droid"],
  npmPackageName: "@factory/cli",
  allowedInstallSources: ["npm"],
  homebrew: null,
  nativeUpdate: null,
};

export function packageManagedProviderUpdateDefinitions(
  provider: ProviderKind,
): ReadonlyArray<PackageManagedProviderMaintenanceDefinition> {
  const primary = PACKAGE_MANAGED_PROVIDER_UPDATES[provider];
  if (!primary) {
    return [];
  }
  return provider === DROID_PROVIDER ? [primary, LEGACY_FACTORY_DROID_NPM_UPDATE] : [primary];
}

// ── Pure helpers ────────────────────────────────────────────────────
//
// Generic CLI-output parsing lives in ../providerCliOutput; Claude auth-status
// interpretation lives in ../claudeAuthStatus.

function resolveVoiceTranscriptionAvailability(
  authMethod: string | undefined,
): boolean | undefined {
  if (!authMethod) {
    return undefined;
  }
  return authMethod === "chatgpt" || authMethod === "chatgptAuthTokens";
}

// ── Subscription type detection ─────────────────────────────────────
//
// Walks arbitrary JSON output from `<provider> auth status` looking for a
// subscription/plan identifier. Used as a best-effort first pass; the SDK
// probe below is the reliable source when available.

const SUBSCRIPTION_TYPE_KEYS = [
  "subscriptionType",
  "subscription_type",
  "plan",
  "tier",
  "planType",
  "plan_type",
] as const;

const SUBSCRIPTION_CONTAINER_KEYS = ["account", "subscription", "user", "billing"] as const;
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"] as const;
const AUTH_METHOD_CONTAINER_KEYS = ["auth", "account", "session"] as const;

const asNonEmptyString = (v: unknown): Option.Option<string> =>
  typeof v === "string" && v.length > 0 ? Option.some(v) : Option.none();

const asRecord = (v: unknown): Option.Option<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Option.some(v as Record<string, unknown>)
    : Option.none();

function findSubscriptionType(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findSubscriptionType));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        SUBSCRIPTION_TYPE_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        SUBSCRIPTION_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findSubscriptionType)),
        ),
      );
    }),
  );
}

function findAuthMethodDeep(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findAuthMethodDeep));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        AUTH_METHOD_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        AUTH_METHOD_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findAuthMethodDeep)),
        ),
      );
    }),
  );
}

const decodeUnknownJson = decodeJsonResult(Schema.Unknown);

function extractSubscriptionTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findSubscriptionType(parsed.success));
}

function extractClaudeAuthMethodFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findAuthMethodDeep(parsed.success));
}

// ── Codex subscription label ────────────────────────────────────────

type CodexPlanTypeLiteral =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "self_serve_business_usage_based"
  | "enterprise_cbp_usage_based"
  | "unknown";

function codexAccountAuthLabel(input: {
  readonly type: string | undefined;
  readonly planType: string | undefined;
}): string | undefined {
  if (input.type === "apiKey") return "OpenAI API Key";
  if (!input.planType) return undefined;
  switch (input.planType as CodexPlanTypeLiteral) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return toTitleCaseWords(input.planType);
  }
}

function extractCodexAccountTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  const walk = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = walk(entry);
        if (nested) return nested;
      }
      return undefined;
    }
    const record = Option.getOrUndefined(asRecord(value));
    if (!record) return undefined;
    const direct = Option.getOrUndefined(
      Option.firstSomeOf(["type", "accountType"].map((key) => asNonEmptyString(record[key]))),
    );
    if (direct) return direct;
    for (const key of ["account", "session", "auth"] as const) {
      const nested = walk(record[key]);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(parsed.success);
}

// ── Claude SDK capability probe ─────────────────────────────────────
//
// Spawns a lightweight Claude Agent SDK session and reads the
// initialization result. The prompt is a never-yielding AsyncIterable so
// no user message reaches the Anthropic API — we get account metadata
// (including subscription type) from local IPC, then abort the
// subprocess. Used as a fallback when `claude auth status` output
// doesn't include subscription info.

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

type PreparedProviderProcess = Awaited<ReturnType<typeof prepareWindowsProviderProcessAsync>>;
type ProviderProcessPreparer = (
  ...args: Parameters<typeof prepareWindowsProviderProcessAsync>
) => PreparedProviderProcess | Promise<PreparedProviderProcess>;
type CodexExecutableResolver = (
  ...args: Parameters<typeof resolveCodexCliExecutableWithDiscoveryAsync>
) =>
  | Awaited<ReturnType<typeof resolveCodexCliExecutableWithDiscoveryAsync>>
  | ReturnType<typeof resolveCodexCliExecutableWithDiscoveryAsync>;
type CommandCodeExecutableResolver = (
  ...args: Parameters<typeof resolveCommandCodeCliExecutableWithDiscoveryAsync>
) =>
  | Awaited<ReturnType<typeof resolveCommandCodeCliExecutableWithDiscoveryAsync>>
  | ReturnType<typeof resolveCommandCodeCliExecutableWithDiscoveryAsync>;

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const probeClaudeSubscription = (processOptions: ProviderHealthProcessOptions = {}) => {
  const abort = new AbortController();
  type ClaudeProbeProcessOwner = {
    readonly sequence: number;
    readonly process: import("node:child_process").ChildProcess;
    readonly prepared?: PreparedProviderProcess;
    readonly exactWindowsOwner: boolean;
    registrationPromise?: Promise<ProviderMaintenanceOwnedResourceRegistration>;
    supervisionFailure?: Error;
  };
  const platform = processOptions.platform ?? globalThis.process.platform;
  const owners: ClaudeProbeProcessOwner[] = [];
  let nextOwnerSequence = 1;
  let recordedSupervisionFailure: Error | undefined;
  let rejectSupervisionFailure!: (cause: Error) => void;
  const supervisionFailure = new Promise<never>((_resolve, reject) => {
    rejectSupervisionFailure = reject;
  });
  void supervisionFailure.catch(() => undefined);
  const recordSupervisionFailure = (cause: unknown): void => {
    if (recordedSupervisionFailure) return;
    const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
    recordedSupervisionFailure = error;
    for (const owner of owners) owner.supervisionFailure ??= error;
    try {
      if (!abort.signal.aborted) abort.abort();
    } catch {
      // The failure promise below still forces scoped cleanup even if an abort listener defects.
    }
    rejectSupervisionFailure(error);
  };
  const reportUnprovenExit = (error: ProviderProcessExitUnprovenError) =>
    processOptions.onUnprovenExit?.({ provider: CLAUDE_AGENT_PROVIDER, error }) ?? Effect.void;
  const closeOwner = (owner: (typeof owners)[number]) => {
    if (containedClaudeSdkProcessDidNotSpawn(owner.process)) return Effect.void;
    const rootPid = Number(owner.process.pid);
    const emergencyTeardown = (ownershipFailure: unknown) =>
      Effect.tryPromise({
        try: () =>
          teardownChildProcessTree(
            owner.process,
            processOptions.teardownProcessTree ?? teardownProviderProcessTree,
          ),
        catch: (teardownFailure) =>
          normalizeProviderHealthExitFailure(
            new AggregateError(
              [ownershipFailure, teardownFailure],
              "Contained Claude process had no exact supervisor and emergency teardown failed.",
            ),
            rootPid,
            owner.exactWindowsOwner,
          ),
      }).pipe(Effect.asVoid);
    let supervisor = windowsJobNodeProcessSupervisor(owner.process);
    if (!supervisor && owner.prepared) {
      try {
        supervisor = supervisePreparedNodeProcess(owner.prepared, owner.process, {
          platform,
          ...(platform === "win32" ? {} : { ownedProcessGroupId: rootPid }),
        });
      } catch (cause) {
        return emergencyTeardown(cause);
      }
    }
    if (!supervisor) {
      return emergencyTeardown(
        new Error("Contained Claude process has no retained shared supervisor."),
      );
    }
    return Effect.tryPromise({
      try: supervisor.teardown,
      catch: (cause) => normalizeProviderHealthExitFailure(cause, rootPid, owner.exactWindowsOwner),
    }).pipe(Effect.asVoid);
  };
  const recordOwner = (input: {
    readonly process: import("node:child_process").ChildProcess;
    readonly prepared?: PreparedProviderProcess;
  }) => {
    const exactWindowsOwner = platform === "win32";
    const owner: ClaudeProbeProcessOwner = {
      sequence: nextOwnerSequence,
      process: input.process,
      ...(input.prepared ? { prepared: input.prepared } : {}),
      exactWindowsOwner,
      ...(recordedSupervisionFailure ? { supervisionFailure: recordedSupervisionFailure } : {}),
    };
    nextOwnerSequence += 1;
    owners.push(owner);
    if (processOptions.maintenanceOwnedResources) {
      owner.registrationPromise = Effect.runPromise(
        processOptions.maintenanceOwnedResources.register({
          provider: CLAUDE_AGENT_PROVIDER,
          resourceId: `provider-health-subscription-probe:${String(owner.sequence)}`,
          close: () => closeOwner(owner).pipe(Effect.tapError(reportUnprovenExit)),
        }),
      );
    }
    return owner;
  };
  return Effect.tryPromise(async () => {
    const containedPreparation: ContainedClaudeSdkProcessPreparation | undefined =
      processOptions.spawnContainedClaudeProcess === undefined &&
      processOptions.prepareProcess === undefined
        ? await prepareContainedClaudeSdkProcess("claude", { platform })
        : undefined;
    const q = (processOptions.queryClaude ?? claudeQuery)({
      // oxlint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abort.signal);
      })(),
      options: {
        persistSession: false,
        abortController: abort,
        settingSources: ["user", "project", "local"],
        allowedTools: [],
        stderr: () => {},
        spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => {
          let spawnedOwner: ClaudeProbeProcessOwner | undefined;
          const process = (
            processOptions.spawnContainedClaudeProcess ?? spawnContainedClaudeSdkProcess
          )(options, {
            platform,
            ...(containedPreparation
              ? { prepareProcess: containedPreparation.prepareProcess }
              : processOptions.prepareProcess
                ? {
                    prepareProcess: (command, args, input) => {
                      const prepared = processOptions.prepareProcess!(command, args, input);
                      if (prepared instanceof Promise) {
                        throw new Error(
                          "The synchronous Claude SDK callback requires a prewarmed process preparer.",
                        );
                      }
                      return prepared;
                    },
                  }
                : {}),
            onSpawnedProcess: ({ prepared, process }) => {
              spawnedOwner = recordOwner({ prepared, process });
            },
            onSupervisionError: recordSupervisionFailure,
          }) as unknown as ClaudeSpawnedProcess & import("node:child_process").ChildProcess;
          const owner =
            spawnedOwner ??
            owners.find((candidate) => candidate.process === process) ??
            recordOwner({ process });
          if (recordedSupervisionFailure) {
            owner.supervisionFailure ??= recordedSupervisionFailure;
          }
          const supervisor = windowsJobNodeProcessSupervisor(process);
          const rootPid = Number(process.pid);
          const missingSupervisorError =
            !supervisor && Number.isInteger(rootPid) && rootPid > 0
              ? normalizeProviderHealthExitFailure(
                  new Error("Contained Claude process has no retained shared supervisor."),
                  rootPid,
                  owner.exactWindowsOwner,
                )
              : undefined;
          if (missingSupervisorError) throw missingSupervisorError;
          return process as unknown as ClaudeSpawnedProcess;
        },
      },
    });
    const init = await Promise.race([q.initializationResult(), supervisionFailure]);
    return { subscriptionType: init.account?.subscriptionType };
  }).pipe(
    Effect.ensuring(
      Effect.tryPromise(async () => {
        if (!abort.signal.aborted) abort.abort();
        const failures: unknown[] = [];
        for (const owner of owners) {
          let registration: ProviderMaintenanceOwnedResourceRegistration | undefined;
          try {
            registration = await owner.registrationPromise;
          } catch (cause) {
            failures.push(cause);
          }
          try {
            await Effect.runPromise(closeOwner(owner));
            if (registration) await Effect.runPromise(registration.unregister);
          } catch (cause) {
            const error = normalizeProviderHealthExitFailure(
              cause,
              Number(owner.process.pid),
              owner.exactWindowsOwner,
            );
            failures.push(error);
            await Effect.runPromise(reportUnprovenExit(error));
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Contained Claude health processes did not all close.",
          );
        }
      }).pipe(Effect.ignore),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly voiceTranscriptionAvailable?: boolean;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(parsed),
        authMethod: extractAuthMethod(parsed),
      };
    } catch {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
  })();

  if (parsedAuth.auth === true) {
    const voiceTranscriptionAvailable = resolveVoiceTranscriptionAvailability(
      parsedAuth.authMethod,
    );
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(voiceTranscriptionAvailable !== undefined ? { voiceTranscriptionAvailable } : {}),
    };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

// ── Codex CLI config detection ──────────────────────────────────────

/**
 * Providers that use OpenAI-native authentication via `codex login`.
 * When the configured `model_provider` is one of these, the `codex login
 * status` probe still runs. For any other provider value the auth probe
 * is skipped because authentication is handled externally (e.g. via
 * environment variables like `PORTKEY_API_KEY` or `AZURE_API_KEY`).
 */
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

/**
 * Read the `model_provider` value from the Codex CLI config file.
 *
 * Looks for the file at `$CODEX_HOME/config.toml` (falls back to
 * `~/.codex/config.toml`). Uses a simple line-by-line scan rather than
 * a full TOML parser to avoid adding a dependency for a single key.
 *
 * Returns `undefined` when the file does not exist or does not set
 * `model_provider`.
 */
export const readCodexConfigModelProvider = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const codexHome = process.env.CODEX_HOME || path.join(OS.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");

  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }

  return parseCodexConfigModelProvider(content);
});

/**
 * Returns `true` when the Codex CLI is configured with a custom
 * (non-OpenAI) model provider, meaning `codex login` auth is not
 * required because authentication is handled through provider-specific
 * environment variables.
 */
export const hasCustomModelProvider = Effect.map(
  readCodexConfigModelProvider,
  (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
);

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const TRANSIENT_WINDOWS_COMMAND_DISCOVERY_DETAIL =
  "Windows command discovery was temporarily unavailable";

function normalizeProviderCommandPreparationError(
  cause: unknown,
  executable: string,
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
): Error {
  if (cause instanceof WindowsProviderTargetNotResolvedError) {
    const effectiveDiscoveryOutcome = cause.discoveryOutcome ?? discoveryOutcome;
    if (effectiveDiscoveryOutcome === "not_found") {
      return Object.assign(new Error(`spawn ${executable} ENOENT`, { cause }), { code: "ENOENT" });
    }
    if (effectiveDiscoveryOutcome === "transient_failure") {
      return Object.assign(
        new Error(`${TRANSIENT_WINDOWS_COMMAND_DISCOVERY_DETAIL}: ${executable}`, { cause }),
        { code: "EAGAIN" },
      );
    }
  }
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

export interface ProviderHealthProcessOptions {
  readonly platform?: NodeJS.Platform;
  readonly prepareProcess?: ProviderProcessPreparer;
  readonly prepareResolvedProcess?: ProviderProcessPreparer;
  readonly superviseProcess?: typeof supervisePreparedEffectProcess;
  readonly processTreeKiller?: ProcessTreeKiller;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  readonly windowsJobSupervisorOptions?: Pick<
    SupervisePreparedEffectProcessOptions,
    "requestStop" | "verifyExit" | "windowsExitTimeoutMs"
  >;
  readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
  readonly onUnprovenExit?: (input: {
    readonly provider: ProviderKind;
    readonly error: ProviderProcessExitUnprovenError;
  }) => Effect.Effect<void>;
  readonly spawnContainedClaudeProcess?: typeof spawnContainedClaudeSdkProcess;
  readonly queryClaude?: typeof claudeQuery;
  readonly resolveCodexExecutable?: CodexExecutableResolver;
  readonly resolveCommandCodeExecutable?: CommandCodeExecutableResolver;
}

const runProviderCommand = (
  provider: ProviderKind,
  executable: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  executableAlreadyResolved = false,
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
  processOptions: ProviderHealthProcessOptions = {},
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = processOptions.platform ?? process.platform;
    const prepared = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          executableAlreadyResolved && processOptions.prepareResolvedProcess
            ? processOptions.prepareResolvedProcess(executable, args, { env, platform })
            : (processOptions.prepareProcess ?? prepareWindowsProviderProcessAsync)(
                executable,
                args,
                {
                  env,
                  platform,
                },
              ),
        ),
      catch: (cause) =>
        normalizeProviderCommandPreparationError(cause, executable, discoveryOutcome),
    });
    const exactWindowsOwner = isWindowsJobPreparedCommand(prepared);
    const command = ChildProcess.make(prepared.command, prepared.args, {
      shell: prepared.shell,
      ...(prepared.windowsHide ? { windowsHide: true } : {}),
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env,
      // Health probes are non-interactive. Leaving stdin as a pipe can keep CLIs
      // such as Antigravity waiting even after a read-only subcommand has finished.
      stdin: "ignore",
      detached: platform !== "win32",
      // Effect's child finalizer remains the provisional owner until the exact prepared-command
      // supervisor and its later (LIFO) finalizer are installed below.
    });

    const owned = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(command);
        let unprovenExitReported = false;
        const reportUnprovenExit = (cause: unknown, rootPid = Number(child.pid)) => {
          const error = normalizeProviderHealthExitFailure(cause, rootPid, exactWindowsOwner);
          return Effect.uninterruptible(
            Effect.suspend(() => {
              if (unprovenExitReported) return Effect.void;
              unprovenExitReported = true;
              return processOptions.onUnprovenExit?.({ provider, error }) ?? Effect.void;
            }),
          );
        };
        const rootPid = Number(child.pid);
        const installation = yield* Effect.try({
          try: () =>
            installPreparedEffectProcessSupervisor(
              prepared,
              child,
              {
                ...processOptions.windowsJobSupervisorOptions,
                platform,
                ...(processOptions.processTreeKiller
                  ? { processTreeKiller: processOptions.processTreeKiller }
                  : {}),
                teardownProcessTree: processOptions.teardownProcessTree ?? teardownProcessTree,
                ...(platform === "win32" ? {} : { ownedProcessGroupId: rootPid }),
              },
              processOptions.superviseProcess,
            ),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
        const supervisor = installation.supervisor;
        let completed = false;
        let registration: ProviderMaintenanceOwnedResourceRegistration | undefined;
        const teardownOwner = Effect.tryPromise({
          try: supervisor.teardown,
          catch: (error) => normalizeProviderHealthExitFailure(error, rootPid, exactWindowsOwner),
        });
        // Register the exact owner before any fallible maintenance publication. On scope unwind it
        // runs before Effect's provisional process finalizer, preserving exact proof as the normal
        // path while still covering default-constructor and registration failures.
        yield* Effect.addFinalizer(() =>
          completed
            ? Effect.void
            : teardownOwner.pipe(
                Effect.andThen(registration?.unregister ?? Effect.void),
                Effect.tapError(reportUnprovenExit),
                Effect.asVoid,
                Effect.ignore,
              ),
        );
        registration = processOptions.maintenanceOwnedResources
          ? yield* processOptions.maintenanceOwnedResources.register({
              provider,
              resourceId: `provider-health-probe:${String(supervisor.rootPid)}`,
              close: () => teardownOwner.pipe(Effect.tapError(reportUnprovenExit), Effect.asVoid),
            })
          : undefined;
        if (installation._tag === "Recovered") {
          const recoveryResult = yield* teardownOwner.pipe(
            Effect.tapError(reportUnprovenExit),
            Effect.result,
          );
          if (Result.isFailure(recoveryResult)) {
            // The durable registry now owns the failed fallback. Do not immediately retry the
            // same retained owner again from this scope's finalizer.
            if (registration) completed = true;
            return yield* Effect.fail(recoveryResult.failure);
          }
          if (registration) yield* registration.unregister;
          completed = true;
          const requestedFailure = installation.requestedSupervisorFailure;
          return yield* Effect.fail(
            requestedFailure instanceof Error
              ? requestedFailure
              : new Error(String(requestedFailure)),
          );
        }
        return {
          child,
          supervisor,
          reportUnprovenExit,
          markCompleted: Effect.uninterruptible(
            (registration?.unregister ?? Effect.void).pipe(
              Effect.andThen(Effect.sync(() => void (completed = true))),
            ),
          ),
        };
      }),
    );
    const { child, supervisor } = owned;

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    yield* Effect.tryPromise({
      try: supervisor.proveExit,
      catch: (error) =>
        normalizeProviderHealthExitFailure(error, supervisor.rootPid, exactWindowsOwner),
    }).pipe(Effect.tapError(owned.reportUnprovenExit));
    yield* owned.markCompleted;

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCodexCommand = (
  args: ReadonlyArray<string>,
  executable = "codex",
  env: NodeJS.ProcessEnv = providerCommandEnv(CODEX_PROVIDER),
  processOptions: ProviderHealthProcessOptions = {},
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
) =>
  runProviderCommand(
    CODEX_PROVIDER,
    executable,
    args,
    env,
    true,
    teardownProviderProcessTree,
    processOptions,
    discoveryOutcome,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runCommandCodeCommand = (
  args: ReadonlyArray<string>,
  executable = "commandcode",
  teardownProcessTree: typeof teardownProviderProcessTree = teardownProviderProcessTree,
  processOptions: ProviderHealthProcessOptions = {},
  discoveryOutcome?: WindowsCommandDiscoveryOutcome,
) =>
  runProviderCommand(
    COMMAND_CODE_PROVIDER,
    executable,
    args,
    providerCommandEnv(COMMAND_CODE_PROVIDER),
    true,
    teardownProcessTree,
    processOptions,
    discoveryOutcome,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runClaudeCommand = (
  args: ReadonlyArray<string>,
  executable = "claude",
  env: NodeJS.ProcessEnv = buildClaudeProcessEnv(),
  processOptions: ProviderHealthProcessOptions = {},
) =>
  runProviderCommand(
    CLAUDE_AGENT_PROVIDER,
    executable,
    args,
    env,
    false,
    teardownProviderProcessTree,
    processOptions,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runGrokCommand = (
  args: ReadonlyArray<string>,
  executable = "grok",
  processOptions: ProviderHealthProcessOptions = {},
) =>
  runProviderCommand(
    GROK_PROVIDER,
    executable,
    ["--no-auto-update", ...args],
    providerCommandEnv(GROK_PROVIDER),
    false,
    teardownProviderProcessTree,
    processOptions,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runOpenCodeCommand = (
  args: ReadonlyArray<string>,
  executable = "opencode",
  processOptions: ProviderHealthProcessOptions = {},
) =>
  runProviderCommand(
    OPENCODE_PROVIDER,
    executable,
    args,
    buildOpenCodeCompatibleProcessEnv({
      provider: OPENCODE_PROVIDER,
      ...(processOptions.platform ? { platform: processOptions.platform } : {}),
    }),
    false,
    teardownProviderProcessTree,
    processOptions,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runKiloCommand = (
  args: ReadonlyArray<string>,
  executable = "kilo",
  processOptions: ProviderHealthProcessOptions = {},
) =>
  runProviderCommand(
    KILO_PROVIDER,
    executable,
    args,
    buildOpenCodeCompatibleProcessEnv({
      provider: KILO_PROVIDER,
      ...(processOptions.platform ? { platform: processOptions.platform } : {}),
    }),
    false,
    teardownProviderProcessTree,
    processOptions,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runCursorCommand = (
  args: ReadonlyArray<string>,
  executable = DEFAULT_CURSOR_AGENT_BINARY,
  processOptions: ProviderHealthProcessOptions = {},
) => {
  const command = buildCursorAgentCommand(executable, args);
  return runProviderCommand(
    CURSOR_PROVIDER,
    command.command,
    command.args,
    buildCursorAgentHeadlessEnv(),
    false,
    teardownProviderProcessTree,
    processOptions,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${command.command} ENOENT`))
        : Effect.succeed(result),
    ),
  );
};

function parseCursorAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const output = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = output.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Cursor Agent authentication status command is unavailable in this Cursor Agent version.",
    };
  }

  if (
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("not authenticated") ||
    lowerOutput.includes("unauthenticated") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("run 'agent login'") ||
    lowerOutput.includes("run `agent login`") ||
    lowerOutput.includes("run cursor-agent login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
    };
  }

  if (
    lowerOutput.includes("logged in") ||
    lowerOutput.includes("login successful") ||
    lowerOutput.includes("authenticated")
  ) {
    return { status: "ready", authStatus: "authenticated" };
  }

  if (result.code === 0) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Cursor Agent is installed, but Synara could not verify authentication status.",
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Cursor Agent authentication status. ${detail}`
      : "Could not verify Cursor Agent authentication status.",
  };
}

function cursorModelsOutputHasModels(output: string): boolean {
  return output.split(/\r?\n/u).some((line) => line.trim().length > 0 && line.includes(" - "));
}

function cursorModelsOutputHasNoModels(output: string): boolean {
  return output.toLowerCase().includes("no models available");
}

const runPiCommand = (
  args: ReadonlyArray<string>,
  executable = "pi",
  processOptions: ProviderHealthProcessOptions = {},
) =>
  runProviderCommand(
    PI_PROVIDER,
    executable,
    args,
    buildPiProcessEnv({
      ...(processOptions.platform ? { platform: processOptions.platform } : {}),
    }),
    false,
    teardownProviderProcessTree,
    processOptions,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runAntigravityCommand = (
  args: ReadonlyArray<string>,
  executable = "agy",
  processOptions: ProviderHealthProcessOptions = {},
) =>
  runProviderCommand(
    ANTIGRAVITY_PROVIDER,
    executable,
    args,
    providerCommandEnv(ANTIGRAVITY_PROVIDER),
    false,
    teardownProviderProcessTree,
    processOptions,
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

// ── Health check ────────────────────────────────────────────────────

async function makeCodexProbeEnv(homePath?: string): Promise<NodeJS.ProcessEnv> {
  const normalizedHomePath = nonEmptyTrimmed(homePath);
  return buildCodexProcessEnv({
    ...(normalizedHomePath ? { homePath: normalizedHomePath } : {}),
  });
}

const readCodexConfigModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = env.CODEX_HOME?.trim() || path.join(OS.homedir(), ".codex");
    const configPath = path.join(codexHome, "config.toml");

    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) {
      return undefined;
    }

    return parseCodexConfigModelProvider(content);
  });

const hasCustomModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.map(
    readCodexConfigModelProviderForEnv(env),
    (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
  );

export const makeCheckCodexProviderStatus = (
  binaryPath?: string,
  homePath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const probeEnv = yield* Effect.promise(() => makeCodexProbeEnv(homePath));
    const configuredExecutable = nonEmptyTrimmed(binaryPath) ?? "codex";
    const resolution = yield* Effect.promise(() =>
      Promise.resolve(
        (processOptions.resolveCodexExecutable ?? resolveCodexCliExecutableWithDiscoveryAsync)(
          configuredExecutable,
          {
            env: probeEnv,
            platform: processOptions.platform,
          },
        ),
      ),
    );
    const executable = resolution.executable;

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* probeProviderCliVersion(
      runCodexCommand(
        ["--version"],
        executable,
        probeEnv,
        processOptions,
        resolution.discoveryOutcome,
      ),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Codex CLI (`codex`) is not installed or not on PATH."
            : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      };
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      };
    }
    const version = versionProbe.result;

    const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
    if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: formatCodexCliUpgradeMessage(parsedVersion),
      };
    }

    // Probe 2: `codex login status` — is the user authenticated?
    //
    // Custom model providers (e.g. Portkey, Azure OpenAI proxy) handle
    // authentication through their own environment variables, so `codex
    // login status` will report "not logged in" even when the CLI works
    // fine.  Skip the auth probe entirely for non-OpenAI providers.
    if (yield* hasCustomModelProviderForEnv(probeEnv)) {
      return {
        provider: CODEX_PROVIDER,
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Using a custom Codex model provider; OpenAI login check skipped.",
      } satisfies ServerProviderStatus;
    }

    const authProbe = yield* runCodexCommand(
      ["login", "status"],
      executable,
      probeEnv,
      processOptions,
      resolution.discoveryOutcome,
    ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Could not verify Codex authentication status. Timed out while running command.",
      };
    }

    const authOutput = authProbe.success.value;
    const parsed = parseAuthStatusFromOutput(authOutput);
    const codexPlanType = extractSubscriptionTypeFromOutput(authOutput);
    const codexAccountType = extractCodexAccountTypeFromOutput(authOutput);
    const codexLabel =
      parsed.authStatus === "authenticated"
        ? codexAccountAuthLabel({ type: codexAccountType, planType: codexPlanType })
        : undefined;
    const codexAuthType =
      parsed.authStatus === "authenticated"
        ? codexAccountType === "apiKey"
          ? "apiKey"
          : codexPlanType
        : undefined;

    return {
      provider: CODEX_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      version: parsedVersion,
      ...(codexAuthType ? { authType: codexAuthType } : {}),
      ...(codexLabel ? { authLabel: codexLabel } : {}),
      ...(parsed.voiceTranscriptionAvailable !== undefined
        ? { voiceTranscriptionAvailable: parsed.voiceTranscriptionAvailable }
        : {}),
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkCodexProviderStatus = makeCheckCodexProviderStatus();

// ── Command Code health check ──────────────────────────────────────

const COMMAND_CODE_HEALTH_TIMEOUT_MS = 15_000;

export interface CommandCodeStatusJson {
  readonly authenticated: boolean;
  readonly version?: string;
  readonly error?: string;
  readonly user?: string;
  readonly provider?: string;
  readonly model?: string;
}

function optionalJsonString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseCommandCodeStatusJson(stdout: string): CommandCodeStatusJson | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.authenticated !== "boolean") return undefined;
    const version = optionalJsonString(record, "version");
    const error = optionalJsonString(record, "error");
    const user = optionalJsonString(record, "user");
    const provider = optionalJsonString(record, "provider");
    const model = optionalJsonString(record, "model");
    return {
      authenticated: record.authenticated,
      ...(version ? { version } : {}),
      ...(error ? { error } : {}),
      ...(user ? { user } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
  } catch {
    return undefined;
  }
}

export const makeCheckCommandCodeProviderStatus = (
  binaryPath?: string,
  options?: ProviderHealthProcessOptions & {
    readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const env = providerCommandEnv(COMMAND_CODE_PROVIDER);
    const configured = nonEmptyTrimmed(binaryPath) ?? "commandcode";
    const resolution = yield* Effect.promise(() =>
      Promise.resolve(
        (
          options?.resolveCommandCodeExecutable ?? resolveCommandCodeCliExecutableWithDiscoveryAsync
        )(configured, { env, platform: options?.platform }),
      ),
    );
    const executable = resolution.executable;
    const versionProbe = yield* probeProviderCliVersion(
      runCommandCodeCommand(
        ["--version"],
        executable,
        options?.teardownProcessTree,
        options,
        resolution.discoveryOutcome,
      ),
      COMMAND_CODE_HEALTH_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: COMMAND_CODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Command Code CLI (`commandcode` or `command-code`) is not installed or not on PATH."
            : `Failed to execute Command Code CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }
    if (versionProbe.outcome === "timeout") {
      return {
        provider: COMMAND_CODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Command Code CLI is installed but its version probe timed out.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const versionResult = versionProbe.result;
      const detail = detailFromResult(versionResult);
      return {
        provider: COMMAND_CODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Command Code CLI is installed but failed to run. ${detail}`
          : "Command Code CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const versionResult = versionProbe.result;
    const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    const authProbe = yield* runCommandCodeCommand(
      ["status", "--json"],
      executable,
      options?.teardownProcessTree,
      options,
      resolution.discoveryOutcome,
    ).pipe(Effect.timeoutOption(COMMAND_CODE_HEALTH_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(authProbe)) {
      return {
        provider: COMMAND_CODE_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version,
        checkedAt,
        message: "Command Code is installed, but authentication could not be verified.",
      } satisfies ServerProviderStatus;
    }
    if (Option.isNone(authProbe.success)) {
      return {
        provider: COMMAND_CODE_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version,
        checkedAt,
        message: "Command Code is installed, but authentication verification timed out.",
      } satisfies ServerProviderStatus;
    }

    const authResult = authProbe.success.value;
    const parsedStatus = parseCommandCodeStatusJson(authResult.stdout);
    if (!parsedStatus) {
      return {
        provider: COMMAND_CODE_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version,
        checkedAt,
        message: "Command Code returned malformed authentication status JSON.",
      } satisfies ServerProviderStatus;
    }
    const authenticated = authResult.code === 0 && parsedStatus.authenticated;
    const statusVersion = parsedStatus.version ?? version;
    return {
      provider: COMMAND_CODE_PROVIDER,
      status: authenticated ? ("ready" as const) : ("warning" as const),
      available: true,
      authStatus: authenticated ? ("authenticated" as const) : ("unauthenticated" as const),
      version: statusVersion,
      checkedAt,
      ...(authenticated
        ? {
            authType: parsedStatus.provider ?? "commandCode",
            authLabel: parsedStatus.user ?? "Command Code Account",
          }
        : {
            message:
              parsedStatus.error ??
              "Command Code is not authenticated. Run `commandcode login` and try again.",
          }),
    } satisfies ServerProviderStatus;
  });

export const checkCommandCodeProviderStatus = makeCheckCommandCodeProviderStatus();

// ── Claude Agent health check ───────────────────────────────────────

const CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS = 1_000;

export const makeCheckClaudeProviderStatus = (
  resolveSubscriptionType?: Effect.Effect<string | undefined>,
  binaryPath?: string,
  homeDir?: string,
  options?: ProviderHealthProcessOptions & { readonly falseNegativeRetryDelayMs?: number },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "claude";
    const claudeEnv = buildClaudeProcessEnv(
      homeDir ? { env: process.env, homeDir } : { env: process.env },
    );

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* probeProviderCliVersion(
      runClaudeCommand(["--version"], executable, claudeEnv, options),
      CLAUDE_HEALTH_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
            : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      };
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      };
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    // Probe 2: `claude auth status` — is the user authenticated? The command can
    // redeem a single-use rotating OAuth refresh token, so it is serialized with
    // every other `claude auth status` invocation in this process (credential
    // keepalive, concurrent health probes) via the shared lock.
    const runAuthStatusProbe = Effect.acquireUseRelease(
      Effect.promise(() => acquireClaudeAuthStatusLock()),
      () =>
        runClaudeCommand(["auth", "status"], executable, claudeEnv, options).pipe(
          Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
        ),
      (release) => Effect.sync(release),
    ).pipe(Effect.result);

    const authProbe = yield* runAuthStatusProbe;

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: "Could not verify Claude authentication status. Timed out while running command.",
      };
    }

    let authOutput = authProbe.success.value;
    let parsed = parseClaudeAuthStatusFromOutput(authOutput);
    const credentialSummary = readClaudeCliCredentialsSummary(
      homeDir ? { env: claudeEnv, homeDir } : { env: claudeEnv },
    );
    // A structured `loggedIn:false` with a clean exit and no local credential
    // record to rescue it (macOS keeps OAuth in the Keychain, not on disk) is
    // the signature of a lost refresh-token rotation race with a concurrent
    // `claude auth status` invocation. Re-probe once after the rotation settles.
    if (
      !credentialSummary.usable &&
      isStructuredClaudeAuthFalseNegativeCandidate(authOutput, parsed)
    ) {
      const retryDelayMs =
        options?.falseNegativeRetryDelayMs ?? CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS;
      if (retryDelayMs > 0) {
        yield* Effect.sleep(retryDelayMs);
      }
      const retryProbe = yield* runAuthStatusProbe;
      if (Result.isSuccess(retryProbe) && Option.isSome(retryProbe.success)) {
        authOutput = retryProbe.success.value;
        parsed = parseClaudeAuthStatusFromOutput(authOutput);
      }
    }
    const structuredFalseNegative = isStructuredClaudeAuthFalseNegativeCandidate(
      authOutput,
      parsed,
    );
    const credentialProbeSubscriptionType =
      credentialSummary.usable && structuredFalseNegative && resolveSubscriptionType
        ? yield* resolveSubscriptionType
        : undefined;
    // Claude 2.1.x can report `loggedIn:false` from `auth status` while a live
    // SDK init still reads account metadata. Token strings alone are not enough:
    // require the SDK probe before treating the credential file as authenticated.
    const effectiveParsed: ReturnType<typeof parseClaudeAuthStatusFromOutput> =
      credentialProbeSubscriptionType !== undefined
        ? { status: "ready", authStatus: "authenticated" }
        : parsed;
    const useCredentialMetadata = credentialProbeSubscriptionType !== undefined;

    // Determine subscription type from multiple sources (cheapest first):
    // 1. JSON output of `claude auth status` (may or may not contain it)
    // 2. Cached SDK probe (spawns a Claude process on miss, reads
    //    `initializationResult()` for account metadata, then aborts
    //    immediately — no API tokens are consumed)
    let subscriptionType =
      extractSubscriptionTypeFromOutput(authOutput) ??
      credentialProbeSubscriptionType ??
      (useCredentialMetadata ? credentialSummary.subscriptionType : undefined);
    const authMethod =
      extractClaudeAuthMethodFromOutput(authOutput) ??
      (useCredentialMetadata ? "claude.ai" : undefined);
    if (
      !subscriptionType &&
      resolveSubscriptionType &&
      effectiveParsed.authStatus === "authenticated"
    ) {
      subscriptionType = yield* resolveSubscriptionType;
    }
    const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });

    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: effectiveParsed.status,
      available: true,
      authStatus: effectiveParsed.authStatus,
      version: parsedVersion,
      ...(authMetadata ? { authType: authMetadata.type, authLabel: authMetadata.label } : {}),
      checkedAt,
      ...(effectiveParsed.message ? { message: effectiveParsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

// ── Grok health check ───────────────────────────────────────────────

export const makeCheckGrokProviderStatus = (
  binaryPath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "grok";

    const versionProbe = yield* probeProviderCliVersion(
      runGrokCommand(["--version"], executable, processOptions),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Grok CLI (`grok`) is not installed or not on PATH."
            : `Failed to execute Grok CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Grok CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Grok CLI is installed but failed to run. ${detail}`
          : "Grok CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const hasApiKey = hasGrokApiKeyEnv();

    return {
      provider: GROK_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: hasApiKey ? ("authenticated" as const) : ("unknown" as const),
      version: parsedVersion,
      checkedAt,
      ...(hasApiKey
        ? { authType: "apiKey", authLabel: "xAI API Key" }
        : {
            message:
              "Grok CLI is installed. Run `grok` to authenticate locally, or set XAI_API_KEY before starting a session.",
          }),
    } satisfies ServerProviderStatus;
  });

export const checkGrokProviderStatus = makeCheckGrokProviderStatus();

// ── Droid health check ─────────────────────────────────────────────

const runDroidCommand = (
  args: ReadonlyArray<string>,
  executable = "droid",
  processOptions: ProviderHealthProcessOptions = {},
) =>
  runProviderCommand(
    DROID_PROVIDER,
    executable,
    args,
    buildDroidRuntimeProcessEnv({
      ...(processOptions.platform ? { platform: processOptions.platform } : {}),
    }),
    false,
    teardownProviderProcessTree,
    processOptions,
  );

export const makeCheckDroidProviderStatus = (
  binaryPath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = resolveDroidCliBinaryPath(nonEmptyTrimmed(binaryPath) ?? undefined);

    const versionProbe = yield* probeProviderCliVersion(
      runDroidCommand(["--version"], executable, processOptions),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: DROID_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Droid CLI (`droid`) is not installed or not on PATH."
            : `Failed to execute Droid CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: DROID_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Droid CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: DROID_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Droid CLI is installed but failed to run. ${detail}`
          : "Droid CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const hasApiKey = hasDroidApiKeyEnv();

    return {
      provider: DROID_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: hasApiKey ? ("authenticated" as const) : ("unknown" as const),
      version: parsedVersion,
      checkedAt,
      ...(hasApiKey
        ? { authType: "apiKey", authLabel: "Factory API Key" }
        : {
            message:
              "Droid CLI is installed. Synara can use the CLI's cached device-pairing login; run `droid` to authenticate locally if needed, or set FACTORY_API_KEY.",
          }),
    } satisfies ServerProviderStatus;
  });

export const checkDroidProviderStatus = makeCheckDroidProviderStatus();

// ── OpenCode health check ───────────────────────────────────────────

export const makeCheckOpenCodeProviderStatus = (
  binaryPath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "opencode";

    const versionProbe = yield* probeProviderCliVersion(
      runOpenCodeCommand(["--version"], executable, processOptions),
      OPENCODE_HEALTH_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
            : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: `OpenCode CLI is installed but failed to run. ${PROVIDER_COMMAND_TIMEOUT_DETAIL}`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `OpenCode CLI is installed but failed to run. ${detail}`
          : "OpenCode CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    return {
      provider: OPENCODE_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message:
        "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
    } satisfies ServerProviderStatus;
  });

export const checkOpenCodeProviderStatus = makeCheckOpenCodeProviderStatus();

// ── Kilo health check ───────────────────────────────────────────────

export const makeCheckKiloProviderStatus = (
  binaryPath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "kilo";

    const versionProbe = yield* probeProviderCliVersion(
      runKiloCommand(["--version"], executable, processOptions),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: KILO_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Kilo CLI (`kilo`) is not installed or not on PATH."
            : `Failed to execute Kilo CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: KILO_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Kilo CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: KILO_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Kilo CLI is installed but failed to run. ${detail}`
          : "Kilo CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    return {
      provider: KILO_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message: "Kilo CLI is installed. Configure provider credentials inside Kilo as needed.",
    } satisfies ServerProviderStatus;
  });

export const checkKiloProviderStatus = makeCheckKiloProviderStatus();

// ── Pi health check ─────────────────────────────────────────────

export const checkPiProviderStatus = (
  agentDir?: string,
  binaryPath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "pi";

    const versionProbe = yield* probeProviderCliVersion(
      runPiCommand(["--version"], executable, processOptions),
      DEFAULT_TIMEOUT_MS,
    );

    // Pi itself is SDK-backed in Synara. Keep this CLI probe advisory so health
    // refreshes do not import the SDK and initialize its native clipboard module.
    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Pi SDK is bundled, but the Pi CLI (`pi`) is not on PATH, so Synara could not verify the installed CLI version."
            : `Pi SDK is bundled, but the CLI health check failed: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Pi SDK is bundled, but the CLI health check timed out before Synara could verify the installed version.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Pi SDK is bundled, but the CLI health check failed. ${detail}`
          : "Pi SDK is bundled, but the CLI health check failed.",
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const configuredAgentDir = nonEmptyTrimmed(agentDir);
    return {
      provider: PI_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message: configuredAgentDir
        ? `Pi CLI is installed. Synara will use Pi agent dir ${configuredAgentDir}.`
        : "Pi CLI is installed. Configure provider credentials inside Pi as needed.",
    } satisfies ServerProviderStatus;
  });

// ── Antigravity CLI health check ──────────────────────────────────

export const checkAntigravityProviderStatus = (
  binaryPath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const platform = processOptions.platform ?? process.platform;
    if (!isAntigravityAvailableOnPlatform(platform)) {
      return makeAntigravityWindowsUnavailableStatus(checkedAt);
    }
    const executable = nonEmptyTrimmed(binaryPath) ?? "agy";
    const versionProbe = yield* probeProviderCliVersion(
      runAntigravityCommand(["--version"], executable, processOptions),
      DEFAULT_TIMEOUT_MS,
    );
    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Antigravity CLI (`agy`) is not installed or is not on PATH."
            : `Antigravity CLI health check failed: ${String(versionProbe.cause)}`,
      } satisfies ServerProviderStatus;
    }
    if (versionProbe.outcome === "timeout") {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        status: "warning",
        available: true,
        authStatus: "unknown",
        checkedAt,
        message: "Antigravity CLI version check timed out.",
      } satisfies ServerProviderStatus;
    }
    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      return {
        provider: ANTIGRAVITY_PROVIDER,
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt,
        message: detailFromResult(version) ?? "Antigravity CLI version check failed.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    if (
      parsedVersion !== null &&
      compareSemverVersions(parsedVersion, MINIMUM_ANTIGRAVITY_CLI_VERSION) < 0
    ) {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        status: "error",
        available: false,
        authStatus: "unknown",
        version: parsedVersion,
        checkedAt,
        message: `Antigravity CLI ${parsedVersion} is too old for Synara. Upgrade to ${MINIMUM_ANTIGRAVITY_CLI_VERSION} or newer.`,
      } satisfies ServerProviderStatus;
    }
    const models = yield* runAntigravityCommand(["models"], executable, processOptions).pipe(
      Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
      Effect.result,
    );
    if (
      Result.isSuccess(models) &&
      Option.isSome(models.success) &&
      models.success.value.code === 0 &&
      models.success.value.stdout.trim().length > 0
    ) {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        status: "ready",
        available: true,
        authStatus: "authenticated",
        version: parsedVersion,
        checkedAt,
        message: "Antigravity CLI is installed, authenticated, and returned available models.",
      } satisfies ServerProviderStatus;
    }
    return {
      provider: ANTIGRAVITY_PROVIDER,
      status: "warning",
      available: true,
      authStatus: "unknown",
      version: parsedVersion,
      checkedAt,
      message: "Antigravity CLI is installed, but Synara could not verify login by listing models.",
    } satisfies ServerProviderStatus;
  });

// ── Cursor health check ─────────────────────────────────────────────

export const makeCheckCursorProviderStatus = (
  binaryPath?: string,
  processOptions: ProviderHealthProcessOptions = {},
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = resolveCursorAgentBinaryPath(nonEmptyTrimmed(binaryPath));

    const versionProbe = yield* probeProviderCliVersion(
      runCursorCommand(["--version"], executable, processOptions),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          versionProbe.outcome === "missing"
            ? "Cursor Agent CLI (`cursor-agent`) is not installed or not on PATH."
            : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Cursor Agent CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Cursor Agent CLI is installed but failed to run. ${detail}`
          : "Cursor Agent CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    const authProbe = yield* runCursorCommand(["status"], executable, processOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Cursor Agent authentication status: ${error.message}.`
            : "Could not verify Cursor Agent authentication status.",
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Could not verify Cursor Agent authentication status. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    const parsedAuth = parseCursorAuthStatusFromOutput(authProbe.success.value);
    if (parsedAuth.authStatus !== "authenticated") {
      return {
        provider: CURSOR_PROVIDER,
        status: parsedAuth.status,
        available: true,
        authStatus: parsedAuth.authStatus,
        version: parsedVersion,
        checkedAt,
        ...(parsedAuth.message ? { message: parsedAuth.message } : {}),
      } satisfies ServerProviderStatus;
    }

    const modelsProbe = yield* runCursorCommand(["models"], executable, processOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(modelsProbe)) {
      const error = modelsProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Cursor Agent is authenticated, but model discovery failed: ${error.message}.`
            : "Cursor Agent is authenticated, but model discovery failed.",
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(modelsProbe.success)) {
      return {
        provider: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but model discovery timed out before Synara could verify available models.",
      } satisfies ServerProviderStatus;
    }

    const modelsResult = modelsProbe.success.value;
    const modelsOutput = `${modelsResult.stdout}\n${modelsResult.stderr}`;
    const modelAuth = parseCursorAuthStatusFromOutput(modelsResult);
    if (modelAuth.authStatus === "unauthenticated") {
      return {
        provider: CURSOR_PROVIDER,
        status: modelAuth.status,
        available: true,
        authStatus: modelAuth.authStatus,
        version: parsedVersion,
        checkedAt,
        ...(modelAuth.message ? { message: modelAuth.message } : {}),
      } satisfies ServerProviderStatus;
    }
    if (cursorModelsOutputHasNoModels(modelsOutput)) {
      return {
        provider: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but it reports no models available for this account.",
      } satisfies ServerProviderStatus;
    }
    if (modelsResult.code !== 0) {
      const detail = detailFromResult(modelsResult);
      return {
        provider: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message: detail
          ? `Cursor Agent is authenticated, but model discovery failed. ${detail}`
          : "Cursor Agent is authenticated, but model discovery failed.",
      } satisfies ServerProviderStatus;
    }
    if (!cursorModelsOutputHasModels(modelsOutput)) {
      return {
        provider: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but model discovery returned no recognizable model rows.",
      } satisfies ServerProviderStatus;
    }

    return {
      provider: CURSOR_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      version: parsedVersion,
      checkedAt,
    } satisfies ServerProviderStatus;
  });

export const checkCursorProviderStatus = makeCheckCursorProviderStatus();

// ── Snapshot helpers ────────────────────────────────────────────────

function comparableProviderVersionAdvisory(
  advisory: ServerProviderStatus["versionAdvisory"] | undefined,
): Omit<NonNullable<ServerProviderStatus["versionAdvisory"]>, "checkedAt"> | null {
  if (!advisory) {
    return null;
  }
  const { checkedAt: _checkedAt, ...comparableAdvisory } = advisory;
  return comparableAdvisory;
}

export function providerStatusesEqual(
  left: ReadonlyArray<ServerProviderStatus>,
  right: ReadonlyArray<ServerProviderStatus>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((status, index) => {
    const next = right[index];
    return (
      next !== undefined &&
      status.provider === next.provider &&
      status.status === next.status &&
      status.available === next.available &&
      status.authStatus === next.authStatus &&
      (status.authType ?? null) === (next.authType ?? null) &&
      (status.authLabel ?? null) === (next.authLabel ?? null) &&
      status.voiceTranscriptionAvailable === next.voiceTranscriptionAvailable &&
      (status.version ?? null) === (next.version ?? null) &&
      (status.message ?? null) === (next.message ?? null) &&
      JSON.stringify(comparableProviderVersionAdvisory(status.versionAdvisory)) ===
        JSON.stringify(comparableProviderVersionAdvisory(next.versionAdvisory)) &&
      JSON.stringify(status.updateState ?? null) === JSON.stringify(next.updateState ?? null)
    );
  });
}

function isTransientProviderCommandFailure(status: ServerProviderStatus): boolean {
  return (
    status.status !== "ready" &&
    status.authStatus === "unknown" &&
    ((status.message ?? "").includes(PROVIDER_COMMAND_TIMEOUT_DETAIL) ||
      (status.message ?? "").includes(TRANSIENT_WINDOWS_COMMAND_DISCOVERY_DETAIL))
  );
}

function wasPreviouslyUsableProviderStatus(status: ServerProviderStatus): boolean {
  return status.available && status.status === "ready";
}

export function stabilizeProviderStatusesAgainstTransientTimeouts(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  nextStatuses: ReadonlyArray<ServerProviderStatus>,
): ReadonlyArray<ServerProviderStatus> {
  if (previousStatuses.length === 0) {
    return nextStatuses;
  }

  const previousByProvider = new Map(
    previousStatuses.map((status) => [status.provider, status] as const),
  );

  return nextStatuses.map((status) => {
    const previous = previousByProvider.get(status.provider);
    if (
      !previous ||
      !wasPreviouslyUsableProviderStatus(previous) ||
      !isTransientProviderCommandFailure(status)
    ) {
      return status;
    }

    // A single slow CLI probe should not make an already usable provider look broken.
    return {
      ...previous,
      checkedAt: status.checkedAt,
      ...(status.updateState !== undefined ? { updateState: status.updateState } : {}),
    };
  });
}

export function isProviderEnabledForSettings(
  provider: ProviderKind,
  settings: ServerSettings,
): boolean {
  return (
    settings.providers[provider]?.enabled !== false && settings.providers[provider] !== undefined
  );
}

export function makeDisabledProviderStatus(
  provider: ProviderKind,
  checkedAt = new Date().toISOString(),
): ServerProviderStatus {
  return {
    provider,
    status: "warning" as const,
    available: false,
    authStatus: "unknown" as const,
    checkedAt,
    message: DISABLED_PROVIDER_STATUS_MESSAGE,
  } satisfies ServerProviderStatus;
}

function isDisabledProviderStatusOverlay(status: ServerProviderStatus): boolean {
  return status.message === DISABLED_PROVIDER_STATUS_MESSAGE && status.available === false;
}

function mergeProviderStatusUpdates(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  updatedStatuses: ReadonlyArray<ServerProviderStatus>,
): ProviderStatuses {
  const statusByProvider = new Map(
    previousStatuses.map((status) => [status.provider, status] as const),
  );
  for (const status of updatedStatuses) {
    statusByProvider.set(status.provider, status);
  }
  return orderProviderStatuses([...statusByProvider.values()]);
}

function makeFailedProviderHealthStatus(
  provider: ProviderKind,
  checkedAt = new Date().toISOString(),
): ServerProviderStatus {
  return {
    provider,
    status: "error" as const,
    available: false,
    authStatus: "unknown" as const,
    checkedAt,
    message: "Provider health check failed before completion. Retry to refresh its status.",
  } satisfies ServerProviderStatus;
}

// Keeps local CLI version/status visible while removing network-backed update metadata.
function makeSuppressedProviderVersionAdvisory(
  status: ServerProviderStatus,
  currentVersion?: string | null,
): NonNullable<ServerProviderStatus["versionAdvisory"]> {
  return {
    status: "unknown",
    currentVersion: currentVersion ?? status.version ?? null,
    latestVersion: null,
    updateCommand: null,
    canUpdate: false,
    checkedAt: status.checkedAt,
    message: null,
  };
}

function suppressProviderVersionAdvisory(status: ServerProviderStatus): ServerProviderStatus {
  return {
    ...status,
    versionAdvisory: makeSuppressedProviderVersionAdvisory(status),
  };
}

// Disabled providers are a settings overlay, not a probe result. Keep the raw
// cached/probed status intact so re-enabling a provider can reuse it immediately.
export function projectProviderStatusesForSettings(
  statuses: ReadonlyArray<ServerProviderStatus>,
  settings: ServerSettings,
  checkedAt = new Date().toISOString(),
): ProviderStatuses {
  const statusByProvider = new Map(statuses.map((status) => [status.provider, status] as const));
  const projected: ServerProviderStatus[] = [];

  for (const provider of PROVIDERS) {
    const status = statusByProvider.get(provider);
    if (!isProviderEnabledForSettings(provider, settings)) {
      const disabledStatus = makeDisabledProviderStatus(provider, status?.checkedAt ?? checkedAt);
      const disabledStatusWithAdvisory = {
        ...disabledStatus,
        versionAdvisory: makeSuppressedProviderVersionAdvisory(disabledStatus, status?.version),
      } satisfies ServerProviderStatus;
      projected.push(
        status?.updateState
          ? { ...disabledStatusWithAdvisory, updateState: status.updateState }
          : disabledStatusWithAdvisory,
      );
      continue;
    }

    if (status && !isDisabledProviderStatusOverlay(status)) {
      projected.push(
        settings.enableProviderUpdateChecks ? status : suppressProviderVersionAdvisory(status),
      );
    }
  }

  return orderProviderStatuses(projected);
}

// ── Layer ───────────────────────────────────────────────────────────

export function makeProviderHealthLive(
  options?: ProviderHealthProcessOptions & {
    readonly providerUpdateTimeoutMs?: number;
    readonly maintenanceGate?: ProviderMaintenanceGate;
  },
) {
  const providerUpdateTimeoutMs = options?.providerUpdateTimeoutMs ?? PROVIDER_UPDATE_TIMEOUT_MS;
  const platform = options?.platform ?? process.platform;
  const baseProviderProcessOptions: ProviderHealthProcessOptions = {
    platform,
    ...(options?.prepareProcess ? { prepareProcess: options.prepareProcess } : {}),
    ...(options?.prepareResolvedProcess
      ? { prepareResolvedProcess: options.prepareResolvedProcess }
      : {}),
    ...(options?.superviseProcess ? { superviseProcess: options.superviseProcess } : {}),
    ...(options?.windowsJobSupervisorOptions
      ? { windowsJobSupervisorOptions: options.windowsJobSupervisorOptions }
      : {}),
    ...(options?.spawnContainedClaudeProcess
      ? { spawnContainedClaudeProcess: options.spawnContainedClaudeProcess }
      : {}),
    ...(options?.queryClaude ? { queryClaude: options.queryClaude } : {}),
    ...(options?.resolveCodexExecutable
      ? { resolveCodexExecutable: options.resolveCodexExecutable }
      : {}),
    ...(options?.resolveCommandCodeExecutable
      ? { resolveCommandCodeExecutable: options.resolveCommandCodeExecutable }
      : {}),
  };
  return Layer.effect(
    ProviderHealth,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const providerService = yield* ProviderService;
      const maintenanceGate = options?.maintenanceGate ?? (yield* makeProviderMaintenanceGate);
      const maintenanceOwnedResources =
        options?.maintenanceOwnedResources ??
        (yield* makeProviderMaintenanceOwnedResourceCoordinator);
      const unprovenHealthProbeExitsRef = yield* Ref.make<
        ReadonlyMap<ProviderKind, ProviderProcessExitUnprovenError>
      >(new Map());
      const onUnprovenExit: NonNullable<ProviderHealthProcessOptions["onUnprovenExit"]> = (input) =>
        Ref.update(unprovenHealthProbeExitsRef, (previous) => {
          const next = new Map(previous);
          if (!next.has(input.provider)) next.set(input.provider, input.error);
          return next;
        }).pipe(
          Effect.andThen(
            maintenanceGate.latchProvider({
              provider: input.provider,
              reason: input.error.message,
            }),
          ),
          Effect.andThen(options?.onUnprovenExit?.(input) ?? Effect.void),
        );
      const providerProcessOptions: ProviderHealthProcessOptions = {
        ...baseProviderProcessOptions,
        maintenanceOwnedResources,
        onUnprovenExit,
      };
      const teardownProcessTree = options?.teardownProcessTree ?? teardownProviderProcessTree;
      const changesPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ReadonlyArray<ServerProviderStatus>>(),
        PubSub.shutdown,
      );
      const refreshScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(refreshScope, Exit.void));

      const cachePathByProvider = new Map(
        PROVIDERS.map(
          (provider) =>
            [
              provider,
              resolveProviderStatusCachePath({
                stateDir: serverConfig.stateDir,
                provider,
              }),
            ] as const,
        ),
      );

      const cachedStatuses: ProviderStatuses = yield* Effect.forEach(
        PROVIDERS,
        (provider) =>
          readProviderStatusCache(cachePathByProvider.get(provider)!).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((statuses) =>
          orderProviderStatuses(
            statuses
              .filter(
                (status): status is ServerProviderStatus =>
                  status !== undefined && !isDisabledProviderStatusOverlay(status),
              )
              .map((status) =>
                status.provider === ANTIGRAVITY_PROVIDER &&
                !isAntigravityAvailableOnPlatform(platform)
                  ? makeAntigravityWindowsUnavailableStatus(status.checkedAt)
                  : status,
              ),
          ),
        ),
      );

      const statusesRef = yield* Ref.make<ProviderStatuses>(cachedStatuses);
      const providerStatusCommitEpochsRef = yield* Ref.make<ReadonlyMap<ProviderKind, number>>(
        new Map(),
      );
      const updateStatesRef = yield* Ref.make<ReadonlyMap<ProviderKind, ServerProviderUpdateState>>(
        new Map(),
      );
      const statusCommitMutex = yield* Semaphore.make(1);
      const refreshFiberRef = yield* Ref.make<Fiber.Fiber<ProviderStatuses, never> | null>(null);
      const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
        makeAlreadyRunningError: (provider) =>
          new ServerProviderUpdateError({
            provider: provider as ProviderKind,
            reason: "An update is already running for this provider.",
          }),
        makeCrossProcessLockError: (provider, _lockKey, cause) =>
          new ServerProviderUpdateError({
            provider: provider as ProviderKind,
            reason: `Could not acquire the cross-process update lock safely. No update was started. ${cause.message}`,
          }),
      });

      // 5-minute TTL cache for the Claude SDK subscription probe. The probe
      // spawns a short-lived `claude` subprocess to read account metadata
      // from the local init handshake; capacity=1 because the probe has no
      // parameters.
      const claudeSubscriptionCache = yield* Cache.make({
        capacity: 1,
        timeToLive: Duration.minutes(5),
        lookup: (_: "claude") => probeClaudeSubscription(providerProcessOptions),
      });
      const resolveClaudeSubscription = Cache.get(claudeSubscriptionCache, "claude").pipe(
        Effect.map((probe) => probe?.subscriptionType),
      );

      const getProviderBinaryPath = (provider: ProviderKind, settings: ServerSettings) => {
        switch (provider) {
          case "codex":
            return settings.providers.codex.binaryPath;
          case "commandCode":
            return settings.providers.commandCode.binaryPath;
          case "claudeAgent":
            return settings.providers.claudeAgent.binaryPath;
          case "cursor":
            return settings.providers.cursor.binaryPath;
          case "antigravity":
            return settings.providers.antigravity.binaryPath;
          case "grok":
            return settings.providers.grok.binaryPath;
          case "droid":
            return settings.providers.droid.binaryPath;
          case "kilo":
            return settings.providers.kilo.binaryPath;
          case "opencode":
            return settings.providers.opencode.binaryPath;
          case "pi":
            return settings.providers.pi.binaryPath;
        }
      };

      const resolveProviderMaintenanceCapabilitiesForSettings = Effect.fn(
        "resolveProviderMaintenanceCapabilitiesForSettings",
      )(function* (provider: ProviderKind, settings: ServerSettings) {
        if (!isProviderEnabledForSettings(provider, settings)) {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            latestVersionSource: null,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          });
        }
        if (provider === ANTIGRAVITY_PROVIDER && !isAntigravityAvailableOnPlatform(platform)) {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            latestVersionSource: null,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          });
        }
        if (provider === GROK_PROVIDER) {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            latestVersionSource: null,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          });
        }
        const definitions = packageManagedProviderUpdateDefinitions(provider);
        if (definitions.length === 0) {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          });
        }
        const commandEnv =
          provider === CODEX_PROVIDER
            ? yield* Effect.promise(() =>
                makeCodexProbeEnv(settings.providers.codex.homePath ?? undefined),
              )
            : providerCommandEnv(provider);
        const configuredBinaryPath = getProviderBinaryPath(provider, settings);
        const binaryPath =
          provider === CODEX_PROVIDER
            ? yield* Effect.promise(() =>
                resolveCodexCliExecutableAsync(configuredBinaryPath ?? "codex", {
                  env: commandEnv,
                  platform,
                }),
              )
            : provider === COMMAND_CODE_PROVIDER
              ? yield* Effect.promise(() =>
                  resolveCommandCodeCliExecutableAsync(configuredBinaryPath ?? "commandcode", {
                    env: commandEnv,
                    platform,
                  }),
                )
              : provider === CURSOR_PROVIDER
                ? resolveCursorAgentBinaryPath(configuredBinaryPath)
                : provider === DROID_PROVIDER
                  ? platform === "win32"
                    ? (configuredBinaryPath ?? "droid")
                    : resolveDroidCliBinaryPath(configuredBinaryPath ?? undefined)
                  : configuredBinaryPath;
        const [primaryDefinition, ...alternateDefinitions] = definitions;
        if (!primaryDefinition) {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          });
        }
        const primaryCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          primaryDefinition,
          {
            binaryPath,
            env: commandEnv,
            platform,
          },
        ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
        if (primaryCapabilities.update !== null) {
          return primaryCapabilities;
        }
        for (const definition of alternateDefinitions) {
          const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(definition, {
            binaryPath,
            env: commandEnv,
            platform,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
          if (capabilities.update !== null) {
            return capabilities;
          }
        }
        return primaryCapabilities;
      });

      const getProviderMaintenanceCapabilities = Effect.fn("getProviderMaintenanceCapabilities")(
        function* (provider: ProviderKind) {
          const settings = yield* serverSettings.getSettings;
          return yield* resolveProviderMaintenanceCapabilitiesForSettings(provider, settings);
        },
      );

      const applyVolatileProviderState = Effect.fn("applyVolatileProviderState")(function* (
        status: ServerProviderStatus,
      ) {
        const updateStates = yield* Ref.get(updateStatesRef);
        const updateState = updateStates.get(status.provider);
        if (!updateState) {
          const { updateState: _updateState, ...statusWithoutUpdateState } = status;
          return statusWithoutUpdateState;
        }
        return {
          ...status,
          updateState,
        };
      });

      const projectStatusesForCurrentSettings = Effect.fn(
        "projectProviderStatusesForCurrentSettings",
      )(function* (statuses: ReadonlyArray<ServerProviderStatus>) {
        return yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => projectProviderStatusesForSettings(statuses, settings)),
          Effect.catch(() => Effect.succeed(statuses)),
          Effect.flatMap((projected) =>
            Effect.forEach(projected, applyVolatileProviderState, {
              concurrency: "unbounded",
            }),
          ),
        );
      });

      const persistStatuses = (statuses: ProviderStatuses) =>
        Effect.forEach(
          statuses,
          (status) => {
            const { updateState: _updateState, ...statusToPersist } = status;
            return writeProviderStatusCache({
              filePath: cachePathByProvider.get(status.provider)!,
              provider: statusToPersist,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.tapError(Effect.logError),
              Effect.ignore,
            );
          },
          { concurrency: "unbounded", discard: true },
        );

      const publishProjectedStatuses = Effect.fn("publishProjectedProviderStatuses")(function* () {
        return yield* statusCommitMutex.withPermit(
          Effect.gen(function* () {
            const rawStatuses = yield* Ref.get(statusesRef);
            const projectedStatuses = yield* projectStatusesForCurrentSettings(rawStatuses);
            yield* PubSub.publish(changesPubSub, projectedStatuses);
            return projectedStatuses;
          }),
        );
      });

      const advanceProviderStatusCommitEpochs = (providers: ReadonlyArray<ProviderKind>) =>
        Ref.update(providerStatusCommitEpochsRef, (previous) => {
          const next = new Map(previous);
          for (const provider of providers) {
            next.set(provider, (previous.get(provider) ?? 0) + 1);
          }
          return next;
        });

      const commitProviderState = Effect.fn("commitProviderState")(function* (
        provider: ProviderKind,
        input: {
          readonly status?: ServerProviderStatus;
          readonly updateState?: ServerProviderUpdateState | null;
        },
      ) {
        return yield* statusCommitMutex.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (input.updateState !== undefined) {
                yield* Ref.update(updateStatesRef, (previous) => {
                  const next = new Map(previous);
                  if (!input.updateState || input.updateState.status === "idle") {
                    next.delete(provider);
                  } else {
                    next.set(provider, input.updateState);
                  }
                  return next;
                });
              }

              let rawStatuses = yield* Ref.get(statusesRef);
              if (input.status !== undefined) {
                const { updateState: _updateState, ...rawStatus } = input.status;
                rawStatuses = mergeProviderStatusUpdates(rawStatuses, [rawStatus]);
                yield* Ref.set(statusesRef, rawStatuses);
                yield* persistStatuses(rawStatuses);
                yield* advanceProviderStatusCommitEpochs([provider]);
              }

              const projectedStatuses = yield* projectStatusesForCurrentSettings(rawStatuses);
              yield* PubSub.publish(changesPubSub, projectedStatuses);
              return projectedStatuses;
            }),
          ),
        );
      });

      const setProviderUpdateState = Effect.fn("setProviderUpdateState")(function* (
        provider: ProviderKind,
        state: ServerProviderUpdateState | null,
      ) {
        return yield* commitProviderState(provider, { updateState: state });
      });

      const enrichStatuses = Effect.fn("enrichProviderStatuses")(function* (
        statuses: ReadonlyArray<ServerProviderStatus>,
      ) {
        const settings = yield* serverSettings.ready.pipe(
          Effect.flatMap(() => serverSettings.getSettings),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (settings?.enableProviderUpdateChecks === false) {
          return yield* Effect.forEach(
            statuses,
            (status) => {
              const suppressedStatus = suppressProviderVersionAdvisory(status);
              return applyVolatileProviderState(suppressedStatus).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("Provider status projection failed", {
                        provider: status.provider,
                        cause: Cause.pretty(cause),
                      }).pipe(Effect.as(suppressedStatus)),
                ),
              );
            },
            { concurrency: "unbounded" },
          );
        }

        return yield* Effect.forEach(
          statuses,
          (status) =>
            getProviderMaintenanceCapabilities(status.provider).pipe(
              Effect.flatMap((capabilities) =>
                enrichProviderStatusWithVersionAdvisory(status, capabilities, {
                  useAdvisoryLatestVersionSource: true,
                }),
              ),
              Effect.flatMap(applyVolatileProviderState),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("Provider status enrichment failed", {
                      provider: status.provider,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.as(suppressProviderVersionAdvisory(status))),
              ),
            ),
          { concurrency: "unbounded" },
        );
      });

      const checkProviderWhenEnabled = <E, R>(
        settings: ServerSettings,
        provider: ProviderKind,
        check: Effect.Effect<ServerProviderStatus, E, R>,
      ): Effect.Effect<Option.Option<ServerProviderStatus>, E, R> =>
        isProviderEnabledForSettings(provider, settings)
          ? maintenanceGate
              .withOperation({
                provider,
                operation: "ProviderHealth.refresh",
                run: check,
              })
              .pipe(
                Effect.map(Option.some),
                Effect.catchTag("ProviderMaintenanceBusyError", () =>
                  Effect.succeed(Option.none()),
                ),
              )
          : Effect.succeed(Option.none());

      const checkProviderStatusForSettings = (
        settings: ServerSettings,
        provider: ProviderKind,
      ): Effect.Effect<ServerProviderStatus, ProviderProcessExitUnprovenError> => {
        const check = (() => {
          switch (provider) {
            case CODEX_PROVIDER:
              return makeCheckCodexProviderStatus(
                settings.providers.codex.binaryPath,
                settings.providers.codex.homePath,
                providerProcessOptions,
              );
            case COMMAND_CODE_PROVIDER:
              return makeCheckCommandCodeProviderStatus(settings.providers.commandCode.binaryPath, {
                teardownProcessTree,
                ...providerProcessOptions,
              });
            case CLAUDE_AGENT_PROVIDER:
              return makeCheckClaudeProviderStatus(
                resolveClaudeSubscription,
                settings.providers.claudeAgent.binaryPath,
                serverConfig.homeDir,
                providerProcessOptions,
              );
            case CURSOR_PROVIDER:
              return makeCheckCursorProviderStatus(
                settings.providers.cursor.binaryPath,
                providerProcessOptions,
              );
            case ANTIGRAVITY_PROVIDER:
              return checkAntigravityProviderStatus(
                settings.providers.antigravity.binaryPath,
                providerProcessOptions,
              );
            case GROK_PROVIDER:
              return makeCheckGrokProviderStatus(
                settings.providers.grok.binaryPath,
                providerProcessOptions,
              );
            case DROID_PROVIDER:
              return makeCheckDroidProviderStatus(
                settings.providers.droid.binaryPath,
                providerProcessOptions,
              );
            case KILO_PROVIDER:
              return makeCheckKiloProviderStatus(
                settings.providers.kilo.binaryPath,
                providerProcessOptions,
              );
            case OPENCODE_PROVIDER:
              return makeCheckOpenCodeProviderStatus(
                settings.providers.opencode.binaryPath,
                providerProcessOptions,
              );
            case PI_PROVIDER:
              return checkPiProviderStatus(
                settings.providers.pi.agentDir,
                settings.providers.pi.binaryPath,
                providerProcessOptions,
              );
          }
        })();
        const assertNoUnprovenExit = Ref.get(unprovenHealthProbeExitsRef).pipe(
          Effect.flatMap((failures) => {
            const failure = failures.get(provider);
            return failure ? Effect.fail(failure) : Effect.void;
          }),
        );
        return assertNoUnprovenExit.pipe(
          Effect.andThen(
            check.pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
          ),
          Effect.flatMap((status) => assertNoUnprovenExit.pipe(Effect.as(status))),
        );
      };

      const loadProviderStatuses = serverSettings.ready
        .pipe(
          Effect.flatMap(() => serverSettings.getSettings),
          Effect.flatMap((settings) =>
            Effect.all(
              PROVIDERS.map((provider) =>
                checkProviderWhenEnabled(
                  settings,
                  provider,
                  checkProviderStatusForSettings(settings, provider),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.failCause(cause)
                      : Effect.logWarning("Provider health probe failed", {
                          provider,
                          cause: Cause.pretty(cause),
                        }).pipe(Effect.as(Option.some(makeFailedProviderHealthStatus(provider)))),
                  ),
                ),
              ),
              {
                concurrency: "unbounded",
              },
            ),
          ),
        )
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.map((statuses) =>
            orderProviderStatuses(
              statuses.flatMap((status) => (Option.isSome(status) ? [status.value] : [])),
            ),
          ),
          Effect.flatMap(enrichStatuses),
        );

      const refreshNow = Effect.gen(function* () {
        const refreshRevision = (yield* serverSettings.getSnapshot).revision;
        const refreshStatusCommitEpochs = yield* Ref.get(providerStatusCommitEpochsRef);
        // Drop the cached Claude subscription probe so switching accounts (login
        // / logout / add account outside the app) is reflected on the next
        // refresh instead of being pinned to the old account for up to 5 minutes.
        yield* Cache.invalidate(claudeSubscriptionCache, "claude");
        const loadedStatuses = yield* loadProviderStatuses;
        return yield* statusCommitMutex.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if ((yield* serverSettings.getSnapshot).revision !== refreshRevision) {
                const currentStatuses = yield* Ref.get(statusesRef);
                return yield* projectStatusesForCurrentSettings(currentStatuses);
              }
              const previousRawStatuses = yield* Ref.get(statusesRef);
              const previousStatuses =
                yield* projectStatusesForCurrentSettings(previousRawStatuses);
              const currentStatusCommitEpochs = yield* Ref.get(providerStatusCommitEpochsRef);
              const freshLoadedStatuses = loadedStatuses.filter(
                (status) =>
                  (refreshStatusCommitEpochs.get(status.provider) ?? 0) ===
                  (currentStatusCommitEpochs.get(status.provider) ?? 0),
              );
              const stabilizedLoadedStatuses = stabilizeProviderStatusesAgainstTransientTimeouts(
                previousRawStatuses,
                freshLoadedStatuses,
              );
              const nextRawStatuses = mergeProviderStatusUpdates(
                previousRawStatuses,
                stabilizedLoadedStatuses,
              );
              const nextStatuses = yield* projectStatusesForCurrentSettings(nextRawStatuses);
              yield* Ref.set(statusesRef, nextRawStatuses);
              if (freshLoadedStatuses.length > 0) {
                yield* advanceProviderStatusCommitEpochs(
                  freshLoadedStatuses.map((status) => status.provider),
                );
              }
              if (providerStatusesEqual(previousStatuses, nextStatuses)) {
                return nextStatuses;
              }
              yield* persistStatuses(nextRawStatuses);
              yield* PubSub.publish(changesPubSub, nextStatuses);
              return nextStatuses;
            }),
          ),
        );
      });

      // Keep a single refresh in flight so repeated config reads do not spawn
      // overlapping CLI probes while the cache already gives us a usable answer.
      const ensureRefreshFiber: Effect.Effect<Fiber.Fiber<ProviderStatuses, never>> = Effect.gen(
        function* () {
          const inFlight = yield* Ref.get(refreshFiberRef);
          if (inFlight) {
            return inFlight;
          }
          const refreshFiber = yield* Effect.gen(function* () {
            const refreshExit = yield* Effect.exit(refreshNow);
            if (Exit.isSuccess(refreshExit)) {
              return refreshExit.value;
            }
            // Keep the current in-memory snapshot as the source of truth if a
            // foreground refresh fails after startup.
            const rawStatuses = yield* Ref.get(statusesRef);
            return yield* projectStatusesForCurrentSettings(rawStatuses);
          }).pipe(Effect.ensuring(Ref.set(refreshFiberRef, null)), Effect.forkIn(refreshScope));
          yield* Ref.set(refreshFiberRef, refreshFiber);
          return refreshFiber;
        },
      );

      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach(() => publishProjectedStatuses().pipe(Effect.asVoid)),
        Effect.forkIn(refreshScope),
      );

      const refresh: Effect.Effect<ProviderStatuses> = ensureRefreshFiber.pipe(
        Effect.flatMap(Fiber.join),
      );

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      const makeUpdateState = (input: {
        readonly status: ServerProviderUpdateState["status"];
        readonly startedAt: string | null;
        readonly finishedAt: string | null;
        readonly message: string | null;
        readonly output?: string | null;
      }): ServerProviderUpdateState => ({
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        message: input.message,
        output: input.output ?? null,
      });

      const describeUpdateCommandError = (error: unknown): string => {
        if (error instanceof Error && error.message.trim().length > 0) {
          if (error.message.includes("initial is not a function")) {
            return "Update command failed before producing output. Try running the provider update command from a terminal.";
          }
          return error.message;
        }
        if (typeof error === "string" && error.trim().length > 0) {
          return error;
        }
        return "Update command could not be started.";
      };

      const runUpdateCommand = Effect.fn("runProviderUpdateCommand")(function* (input: {
        readonly provider: ProviderKind;
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly pathPrepend?: string;
        readonly teardownFailureRef: Ref.Ref<Error | null>;
      }) {
        const updateEnv = buildProviderUpdateProcessEnv({
          provider: input.provider,
          ...(input.pathPrepend ? { pathPrepend: input.pathPrepend } : {}),
          platform,
        });
        const prepared = yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(
              (providerProcessOptions.prepareProcess ?? prepareWindowsProviderProcessAsync)(
                input.command,
                input.args,
                {
                  env: updateEnv,
                  platform,
                },
              ),
            ),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
        const supervised = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const childCommandOptions: ChildProcess.CommandOptions = {
              detached: platform !== "win32",
              shell: prepared.shell,
              ...(prepared.windowsHide ? { windowsHide: true } : {}),
              ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
              env: updateEnv,
              // Keep Effect's child finalizer as provisional ownership until the exact supervisor
              // and its later (LIFO) finalizer are installed below.
            };
            const child = yield* spawner.spawn(
              ChildProcess.make(prepared.command, prepared.args, childCommandOptions),
            );
            const rootPid = Number(child.pid);
            const exactWindowsOwner = isWindowsJobPreparedCommand(prepared);
            const reportUnprovenExit = (cause: unknown) => {
              const error = normalizeProviderHealthExitFailure(cause, rootPid, exactWindowsOwner);
              return Ref.set(input.teardownFailureRef, error).pipe(
                Effect.andThen(
                  maintenanceGate.latchProvider({
                    provider: input.provider,
                    reason: error.message,
                  }),
                ),
              );
            };
            const installation = yield* Effect.try({
              try: () =>
                installPreparedEffectProcessSupervisor(
                  prepared,
                  child,
                  {
                    ...providerProcessOptions.windowsJobSupervisorOptions,
                    ...(options?.processTreeKiller
                      ? { processTreeKiller: options.processTreeKiller }
                      : {}),
                    teardownProcessTree,
                    platform,
                    ...(platform === "win32" ? {} : { ownedProcessGroupId: rootPid }),
                  },
                  providerProcessOptions.superviseProcess,
                ),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            });
            const processSupervisor = installation.supervisor;
            let completed = false;
            let registration: ProviderMaintenanceOwnedResourceRegistration | undefined;
            const teardownOwner = Effect.tryPromise({
              try: processSupervisor.teardown,
              catch: (error) =>
                normalizeProviderHealthExitFailure(error, rootPid, exactWindowsOwner),
            });
            // Exact teardown must be registered before maintenance publication can fail. Effect's
            // provisional finalizer remains underneath it and therefore runs second on unwind.
            yield* Effect.addFinalizer(() =>
              completed
                ? Effect.void
                : teardownOwner.pipe(
                    Effect.andThen(registration?.unregister ?? Effect.void),
                    Effect.tapError(reportUnprovenExit),
                    Effect.ignore,
                  ),
            );
            registration = yield* maintenanceOwnedResources.register({
              provider: input.provider,
              resourceId: `provider-update:${String(rootPid)}`,
              close: () => teardownOwner.pipe(Effect.tapError(reportUnprovenExit), Effect.asVoid),
            });
            if (installation._tag === "Recovered") {
              const recoveryResult = yield* teardownOwner.pipe(
                Effect.tapError(reportUnprovenExit),
                Effect.result,
              );
              if (Result.isFailure(recoveryResult)) {
                // The maintenance registry retains this exact fallback for an explicit retry.
                completed = true;
                return yield* Effect.fail(recoveryResult.failure);
              }
              yield* registration.unregister;
              completed = true;
              const requestedFailure = installation.requestedSupervisorFailure;
              return yield* Effect.fail(
                requestedFailure instanceof Error
                  ? requestedFailure
                  : new Error(String(requestedFailure)),
              );
            }
            yield* Effect.tryPromise({
              try: processSupervisor.waitForInitialCapture,
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            });
            return {
              child,
              processSupervisor,
              markCompleted: Effect.uninterruptible(
                registration.unregister.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      completed = true;
                    }),
                  ),
                ),
              ),
            };
          }),
        );
        const { child, processSupervisor } = supervised;
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        yield* Effect.tryPromise({
          try: () => processSupervisor.proveExit(),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        yield* supervised.markCompleted;
        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        };
      });

      const updateTargetsEqual = (
        left: NonNullable<ProviderMaintenanceCapabilities["update"]>,
        right: NonNullable<ProviderMaintenanceCapabilities["update"]>,
      ): boolean =>
        left.executable === right.executable &&
        left.lockKey === right.lockKey &&
        left.pathPrepend === right.pathPrepend &&
        left.targetFingerprint === right.targetFingerprint &&
        left.args.length === right.args.length &&
        left.args.every((arg, index) => arg === right.args[index]);

      const providerSettingsFingerprint = (
        provider: ProviderKind,
        settings: ServerSettings,
      ): string => JSON.stringify(settings.providers[provider]);

      interface ProviderUpdateSettingsGeneration {
        readonly revision: number;
        readonly settings: ServerSettings;
        readonly capabilities: ProviderMaintenanceCapabilities;
      }

      const updateEvidenceGenerationMatches = (
        provider: ProviderKind,
        expected: ProviderUpdateSettingsGeneration,
        current: ProviderUpdateSettingsGeneration,
      ): boolean => {
        const expectedUpdate = expected.capabilities.update;
        const currentUpdate = current.capabilities.update;
        return (
          expected.revision === current.revision &&
          providerSettingsFingerprint(provider, expected.settings) ===
            providerSettingsFingerprint(provider, current.settings) &&
          expectedUpdate !== null &&
          currentUpdate !== null &&
          updateTargetsEqual(expectedUpdate, currentUpdate) &&
          providerMaintenanceTargetsShareUpdateDestination(
            expectedUpdate.target,
            currentUpdate.target,
          )
        );
      };

      const updateDestinationGenerationMatches = (
        provider: ProviderKind,
        expected: ProviderUpdateSettingsGeneration,
        current: ProviderUpdateSettingsGeneration,
      ): boolean => {
        const expectedUpdate = expected.capabilities.update;
        const currentUpdate = current.capabilities.update;
        return (
          expected.revision === current.revision &&
          providerSettingsFingerprint(provider, expected.settings) ===
            providerSettingsFingerprint(provider, current.settings) &&
          expectedUpdate !== null &&
          currentUpdate !== null &&
          providerMaintenanceTargetsShareUpdateDestination(
            expectedUpdate.target,
            currentUpdate.target,
          )
        );
      };

      const updateProvider: ProviderHealthShape["updateProvider"] = Effect.fn(
        "ProviderHealth.updateProvider",
      )(function* (input) {
        const provider = input.provider;
        const toUpdateError = (cause: unknown, reason?: string): ServerProviderUpdateError => {
          if (reason === undefined && cause instanceof ServerProviderUpdateError) {
            return cause;
          }
          const error = new ServerProviderUpdateError({
            provider,
            reason: reason ?? (cause instanceof Error ? cause.message : String(cause)),
          });
          Object.defineProperty(error, "cause", { value: cause, enumerable: false });
          return error;
        };
        const readUpdateSettingsGeneration = Effect.fn("readProviderUpdateSettingsGeneration")(
          function* () {
            const snapshot = yield* serverSettings.getSnapshot.pipe(Effect.mapError(toUpdateError));
            const capabilities = yield* resolveProviderMaintenanceCapabilitiesForSettings(
              provider,
              snapshot.settings,
            ).pipe(Effect.mapError(toUpdateError));
            return {
              revision: snapshot.revision,
              settings: snapshot.settings,
              capabilities,
            } satisfies ProviderUpdateSettingsGeneration;
          },
        );
        const initialGeneration = yield* readUpdateSettingsGeneration();
        const initialSettings = initialGeneration.settings;
        if (!isProviderEnabledForSettings(provider, initialSettings)) {
          return yield* new ServerProviderUpdateError({
            provider,
            reason: "Provider is disabled in Synara settings.",
          });
        }
        const initialCapabilities = initialGeneration.capabilities;
        const initialUpdate = initialCapabilities.update;
        if (!initialUpdate) {
          return yield* new ServerProviderUpdateError({
            provider,
            reason: "This provider does not support one-click updates.",
          });
        }

        const jobBeganRef = yield* Ref.make(false);
        const terminalStateWrittenRef = yield* Ref.make(false);
        const startedAtRef = yield* Ref.make<string | null>(null);
        const teardownFailureRef = yield* Ref.make<Error | null>(null);

        const markTerminal = Effect.fn("markProviderUpdateTerminal")(function* (input: {
          readonly status: Extract<
            ServerProviderUpdateState["status"],
            | "already_current"
            | "failed"
            | "succeeded"
            | "still_outdated"
            | "unchanged"
            | "unverified"
          >;
          readonly message: string;
          readonly output?: string | null;
          readonly providerStatus?: ServerProviderStatus;
        }) {
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const finishedAt = yield* nowIso;
              const startedAt = yield* Ref.get(startedAtRef);
              const providers = yield* commitProviderState(provider, {
                updateState: makeUpdateState({
                  status: input.status,
                  startedAt,
                  finishedAt,
                  message: input.message,
                  output: input.output ?? null,
                }),
                ...(input.providerStatus !== undefined ? { status: input.providerStatus } : {}),
              });
              yield* Ref.set(terminalStateWrittenRef, true);
              return providers;
            }),
          );
        });

        const handleUpdateHealthProbeFailure = <E extends Error>(
          probe: Effect.Effect<ServerProviderStatus, E>,
          phase: "pre-update" | "post-update",
        ) =>
          probe.pipe(
            Effect.catch((cause) => {
              const reason =
                cause instanceof ProviderMaintenanceBusyError
                  ? cause.message
                  : `${phase === "pre-update" ? "Pre-update" : "Post-update"} provider health could not prove process exit. Restart Synara before using '${provider}' again. ${cause.message}`;
              const error = toUpdateError(cause, reason);
              return markTerminal({ status: "failed", message: reason }).pipe(
                Effect.andThen(Effect.fail(error)),
              );
            }),
          );

        const runAdmittedPreUpdateHealthProbe = (settings: ServerSettings) =>
          handleUpdateHealthProbeFailure(
            maintenanceGate.withOperation({
              provider,
              operation: "ProviderHealth.update.pre-update",
              run: checkProviderStatusForSettings(settings, provider),
            }),
            "pre-update",
          );

        // The caller already owns exclusive maintenance. Reacquiring operation admission here
        // would reject the update itself and release the gate before delayed replacement probes.
        const runExclusivePostUpdateHealthProbe = (settings: ServerSettings) =>
          handleUpdateHealthProbeFailure(
            maintenanceGate.assertProviderNotLatched({ provider }).pipe(
              Effect.andThen(checkProviderStatusForSettings(settings, provider)),
              Effect.tap(() => maintenanceGate.assertProviderNotLatched({ provider })),
            ),
            "post-update",
          );

        const runPostUpdateVerificationProbe = Effect.fn("runProviderPostUpdateVerificationProbe")(
          function* (stableGeneration: ProviderUpdateSettingsGeneration) {
            const generation = yield* readUpdateSettingsGeneration();
            const update = generation.capabilities.update;
            const targetChangedBeforeProbe =
              !update ||
              !updateDestinationGenerationMatches(provider, stableGeneration, generation);
            const status = yield* runExclusivePostUpdateHealthProbe(generation.settings);
            const decisionGeneration = yield* readUpdateSettingsGeneration();
            const evidenceChanged = !updateEvidenceGenerationMatches(
              provider,
              generation,
              decisionGeneration,
            );
            return {
              generation,
              status,
              targetChanged: targetChangedBeforeProbe || evidenceChanged,
            };
          },
        );

        const run = Effect.gen(function* () {
          const lockedGeneration = yield* readUpdateSettingsGeneration();
          const lockedSettings = lockedGeneration.settings;
          const lockedCapabilities = lockedGeneration.capabilities;
          const lockedUpdate = lockedCapabilities.update;
          if (
            !lockedUpdate ||
            !updateEvidenceGenerationMatches(provider, initialGeneration, lockedGeneration)
          ) {
            const providers = yield* markTerminal({
              status: "failed",
              message:
                "Provider settings or the resolved install target changed while the update was queued. Retry the update.",
            });
            return { providers };
          }

          const usesExternalServer =
            (provider === KILO_PROVIDER || provider === OPENCODE_PROVIDER) &&
            lockedSettings.providers[provider].serverUrl.trim().length > 0;
          const startedAt = yield* nowIso;
          yield* Ref.set(startedAtRef, startedAt);
          yield* setProviderUpdateState(
            provider,
            makeUpdateState({
              status: "running",
              startedAt,
              finishedAt: null,
              message: "Updating provider.",
            }),
          );

          const beforeStatus = yield* runAdmittedPreUpdateHealthProbe(lockedSettings);
          const beforeVersion = beforeStatus.version ?? null;
          const stableGeneration = yield* readUpdateSettingsGeneration();
          const stableCapabilities = stableGeneration.capabilities;
          const stableUpdate = stableCapabilities.update;
          if (
            !stableUpdate ||
            !updateEvidenceGenerationMatches(provider, lockedGeneration, stableGeneration)
          ) {
            const providers = yield* markTerminal({
              status: "failed",
              message:
                "Provider settings or the resolved install target changed during pre-update verification. Retry the update.",
            });
            return { providers };
          }

          const preflightStatus = yield* enrichProviderStatusWithVersionAdvisory(
            beforeStatus,
            stableCapabilities,
            { forceRefresh: true, useAdvisoryLatestVersionSource: true },
          ).pipe(Effect.catch(() => Effect.succeed(beforeStatus)));
          const preflightDecisionGeneration = yield* readUpdateSettingsGeneration();
          if (
            !updateEvidenceGenerationMatches(
              provider,
              stableGeneration,
              preflightDecisionGeneration,
            )
          ) {
            const providers = yield* markTerminal({
              status: "failed",
              message:
                "Provider settings or the resolved install target changed during pre-update verification. Retry the update.",
            });
            return { providers };
          }
          if (preflightStatus.versionAdvisory?.status === "current") {
            const providers = yield* markTerminal({
              status: "already_current",
              message: "Provider CLI is already current; no update command was run.",
              providerStatus: preflightStatus,
            });
            return { providers };
          }
          yield* commitProviderState(provider, { status: preflightStatus });

          const exclusiveResult = yield* maintenanceGate
            .withExclusiveMaintenance({
              provider,
              latchReasonOnFailure: (cause) =>
                findProviderProcessExitUnprovenError(Cause.squash(cause))?.message ?? null,
              run: Effect.gen(function* () {
                const gatedGeneration = yield* readUpdateSettingsGeneration();
                const gatedCapabilities = gatedGeneration.capabilities;
                const gatedUpdate = gatedCapabilities.update;
                if (
                  !gatedUpdate ||
                  !updateEvidenceGenerationMatches(
                    provider,
                    preflightDecisionGeneration,
                    gatedGeneration,
                  )
                ) {
                  return yield* new ServerProviderUpdateError({
                    provider,
                    reason:
                      "Provider settings or the resolved install target changed before runtime shutdown. Retry the update.",
                  });
                }
                if (provider !== PI_PROVIDER) {
                  yield* quiesceProviderRuntimesForUpdate({
                    provider,
                    providerService,
                    stopIdleSessions: provider !== KILO_PROVIDER && provider !== OPENCODE_PROVIDER,
                  });
                }
                yield* maintenanceOwnedResources.drainProviderResources({ provider });
                const commandGeneration = yield* readUpdateSettingsGeneration();
                const commandCapabilities = commandGeneration.capabilities;
                const commandUpdate = commandCapabilities.update;
                if (
                  !commandUpdate ||
                  !updateEvidenceGenerationMatches(provider, gatedGeneration, commandGeneration)
                ) {
                  return yield* new ServerProviderUpdateError({
                    provider,
                    reason:
                      "Provider settings or the resolved install target changed while owned runtimes were stopping. Retry the update.",
                  });
                }
                const commandResult = yield* runUpdateCommand({
                  provider,
                  command: commandUpdate.executable,
                  args: commandUpdate.args,
                  ...(commandUpdate.pathPrepend ? { pathPrepend: commandUpdate.pathPrepend } : {}),
                  teardownFailureRef,
                }).pipe(Effect.scoped);
                const commandResults = [commandResult];
                if (commandResult.exitCode !== 0) {
                  return {
                    _tag: "NonZeroExit",
                    commandResults,
                    failedCommandResult: commandResult,
                  } as const;
                }

                let verificationGeneration = stableGeneration;
                let initialPostProbe = yield* runPostUpdateVerificationProbe(stableGeneration);
                if (
                  shouldRunWindowsDroidNativeUpdateFinalizer({
                    platform,
                    provider,
                    updateChannelKind: commandUpdate.target.channel.kind,
                    beforeVersion,
                    initialSnapshot: initialPostProbe,
                  })
                ) {
                  const finalizerGeneration = yield* readUpdateSettingsGeneration();
                  const finalizerUpdate = finalizerGeneration.capabilities.update;
                  if (
                    !finalizerUpdate ||
                    !updateEvidenceGenerationMatches(
                      provider,
                      initialPostProbe.generation,
                      finalizerGeneration,
                    )
                  ) {
                    initialPostProbe = {
                      ...initialPostProbe,
                      targetChanged: true,
                    };
                  } else {
                    yield* maintenanceGate.assertProviderNotLatched({ provider });
                    const finalizerResult = yield* runUpdateCommand({
                      provider,
                      command: finalizerUpdate.executable,
                      args: ["update", "--check"],
                      ...(finalizerUpdate.pathPrepend
                        ? { pathPrepend: finalizerUpdate.pathPrepend }
                        : {}),
                      teardownFailureRef,
                    }).pipe(Effect.scoped);
                    commandResults.push(finalizerResult);
                    if (finalizerResult.exitCode !== 0) {
                      return {
                        _tag: "NonZeroExit",
                        commandResults,
                        failedCommandResult: finalizerResult,
                      } as const;
                    }
                    verificationGeneration = finalizerGeneration;
                    initialPostProbe = yield* runPostUpdateVerificationProbe(finalizerGeneration);
                  }
                }
                const verifiedPostProbe = shouldRetryDelayedProviderUpdateVersion(platform)
                  ? yield* verifyDelayedProviderUpdateVersion({
                      beforeVersion,
                      initialSnapshot: initialPostProbe,
                      probe: runPostUpdateVerificationProbe(verificationGeneration),
                    })
                  : initialPostProbe;
                return {
                  _tag: "Verified",
                  commandResults,
                  verifiedPostProbe,
                } as const;
              }),
            })
            .pipe(Effect.result);
          if (Result.isFailure(exclusiveResult)) {
            const terminalStateWritten = yield* Ref.get(terminalStateWrittenRef);
            if (terminalStateWritten) {
              return yield* Effect.fail(toUpdateError(exclusiveResult.failure));
            }
            const unprovenExit = findProviderProcessExitUnprovenError(exclusiveResult.failure);
            if (unprovenExit) {
              yield* maintenanceGate.latchProvider({
                provider,
                reason: unprovenExit.message,
              });
            }
            const providers = yield* markTerminal({
              status: "failed",
              message: unprovenExit
                ? `${describeUpdateCommandError(exclusiveResult.failure)} Restart Synara before using this provider again.`
                : describeUpdateCommandError(exclusiveResult.failure),
            });
            return { providers };
          }
          const maintenanceResult = exclusiveResult.success;
          const output =
            maintenanceResult.commandResults
              .flatMap((result) => [result.stderr, result.stdout])
              .filter(Boolean)
              .join("\n\n")
              .trim() || null;
          if (maintenanceResult._tag === "NonZeroExit") {
            const providers = yield* markTerminal({
              status: "failed",
              message: `Update command exited with code ${maintenanceResult.failedCommandResult.exitCode}.`,
              output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
            });
            return { providers };
          }

          const verifiedPostProbe = maintenanceResult.verifiedPostProbe;
          const afterStatus = verifiedPostProbe.status;
          const postCapabilities = verifiedPostProbe.generation.capabilities;
          const postStatus = yield* enrichProviderStatusWithVersionAdvisory(
            afterStatus,
            postCapabilities,
            { forceRefresh: true, useAdvisoryLatestVersionSource: true },
          ).pipe(Effect.catch(() => Effect.succeed(afterStatus)));
          const postDecisionGeneration = yield* readUpdateSettingsGeneration();
          const postEvidenceGenerationChanged = !updateEvidenceGenerationMatches(
            provider,
            verifiedPostProbe.generation,
            postDecisionGeneration,
          );
          const targetChanged = verifiedPostProbe.targetChanged || postEvidenceGenerationChanged;
          const afterVersion = afterStatus.version ?? null;
          const configuredBinaryUnavailable = !afterStatus.available;
          const postAdvisory = postStatus.versionAdvisory;
          const stillOutdated = postAdvisory?.status === "behind_latest";
          const stillOutdatedVersions =
            postAdvisory?.currentVersion && postAdvisory.latestVersion
              ? ` (installed ${postAdvisory.currentVersion}, latest ${postAdvisory.latestVersion})`
              : "";
          const verifiedUpgrade =
            beforeVersion !== null &&
            afterVersion !== null &&
            compareSemverVersions(afterVersion, beforeVersion) > 0;
          const outcome = classifyCompletedProviderUpdate({
            provider,
            configuredBinaryUnavailable,
            ...(afterStatus.message ? { configuredBinaryMessage: afterStatus.message } : {}),
            targetChanged,
            beforeVersion,
            afterVersion,
            verifiedUpgrade,
            stillOutdated,
            currentReported: postAdvisory?.status === "current",
            stillOutdatedVersions,
            usesExternalServer,
          });
          const finalProviders = yield* markTerminal({
            status: outcome.status,
            message: outcome.message,
            output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
            ...(!targetChanged ? { providerStatus: postStatus } : {}),
          });
          return { providers: finalProviders };
        });

        const execute = Effect.gen(function* () {
          const result = yield* commandCoordinator
            .withCommandLock({
              targetKey: provider,
              lockKey: initialUpdate.lockKey,
              canonicalInstallRoot: initialUpdate.target.canonicalInstallRoot,
              onQueued: Ref.set(jobBeganRef, true).pipe(
                Effect.andThen(
                  setProviderUpdateState(
                    provider,
                    makeUpdateState({
                      status: "queued",
                      startedAt: null,
                      finishedAt: null,
                      message: "Waiting for another provider update to finish.",
                    }),
                  ),
                ),
                Effect.asVoid,
              ),
              run,
            })
            .pipe(Effect.timeoutOption(Duration.millis(providerUpdateTimeoutMs)));
          if (Option.isSome(result)) {
            return result.value;
          }
          const teardownFailure = yield* Ref.get(teardownFailureRef);
          const providers = yield* markTerminal({
            status: "failed",
            message: teardownFailure
              ? `Update timed out and process exit could not be proven. Restart Synara before using '${provider}' again. ${teardownFailure.message}`
              : `Update job timed out after ${formatProviderUpdateTimeout(providerUpdateTimeoutMs)}. It was canceled, and any spawned updater process tree was stopped before provider access resumed.`,
          });
          return { providers };
        }).pipe(
          Effect.onExit(() =>
            Effect.gen(function* () {
              const began = yield* Ref.get(jobBeganRef);
              const terminalStateWritten = yield* Ref.get(terminalStateWrittenRef);
              if (!began || terminalStateWritten) {
                return;
              }
              const teardownFailure = yield* Ref.get(teardownFailureRef);
              yield* markTerminal({
                status: "failed",
                message: teardownFailure
                  ? `Update ended without proven process exit. Restart Synara before using '${provider}' again. ${teardownFailure.message}`
                  : "Update was interrupted before completion. Retry after checking the provider status.",
              });
            }).pipe(Effect.ignore),
          ),
        );

        return yield* execute;
      });

      return {
        // Mirror upstream's behavior here: reads consume the latest stable
        // snapshot, while refreshes happen explicitly or from provider streams.
        getStatuses: Ref.get(statusesRef).pipe(Effect.flatMap(projectStatusesForCurrentSettings)),
        refresh,
        updateProvider,
        get streamChanges() {
          return Stream.fromPubSub(changesPubSub);
        },
      } satisfies ProviderHealthShape;
    }),
  );
}

export const ProviderHealthLive = makeProviderHealthLive();
