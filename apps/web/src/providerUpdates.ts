// FILE: providerUpdates.ts
// Purpose: Shared provider-update filtering and refresh cadence for global toasts and settings.
// Layer: Web settings/notification utility
// Exports: update candidate helpers, notification keys, and auto-refresh timing.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
} from "@synara/contracts";

export const PROVIDER_UPDATE_INITIAL_REFRESH_DELAY_MS = 10_000;
export const PROVIDER_UPDATE_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
// The server stops provider commands after two minutes. This slightly longer
// client watchdog also covers a stalled transport so loading UI always settles.
export const PROVIDER_UPDATE_REQUEST_TIMEOUT_MS = 2 * 60_000 + 15_000;

function formatUpdateTimeout(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = timeoutMs / 1_000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export async function withProviderUpdateTimeout<T>(input: {
  readonly provider: ProviderKind;
  readonly request: Promise<T>;
  readonly timeoutMs?: number;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? PROVIDER_UPDATE_REQUEST_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `${PROVIDER_DISPLAY_NAMES[input.provider]} update timed out after ${formatUpdateTimeout(timeoutMs)}.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([input.request, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

type ProviderUpdateFilterInput = {
  readonly providers: ReadonlyArray<ServerProviderStatus>;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly serverSettings?:
    | Pick<ServerSettings, "providers" | "enableProviderUpdateChecks">
    | null
    | undefined;
  readonly oneClickOnly?: boolean;
};

type ProviderUpdateVisibilityInput = {
  readonly provider: ServerProviderStatus;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly hiddenProviderSet?: ReadonlySet<ProviderKind>;
  readonly serverSettings?:
    | Pick<ServerSettings, "providers" | "enableProviderUpdateChecks">
    | null
    | undefined;
  readonly oneClickOnly?: boolean;
};

export function isProviderUpdateActive(provider: ServerProviderStatus): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

const INCOMPLETE_PROVIDER_UPDATE_STATES: ReadonlySet<
  NonNullable<ServerProviderStatus["updateState"]>["status"]
> = new Set(["failed", "still_outdated", "unchanged", "unverified"]);

export function isProviderUpdateIncomplete(provider: ServerProviderStatus): boolean {
  const status = provider.updateState?.status;
  return status !== undefined && INCOMPLETE_PROVIDER_UPDATE_STATES.has(status);
}

export function providerUpdateIncompleteMessage(
  provider: ServerProviderStatus | undefined,
): string | null {
  if (!provider || !isProviderUpdateIncomplete(provider)) {
    return null;
  }
  const state = provider.updateState;
  const message = state?.message?.trim() || null;
  const output = state?.output?.trim() || null;
  if (state?.status === "failed" && output) {
    return message && message !== output ? `${message}\n\n${output}` : output;
  }
  return message || output || "The provider update could not be verified.";
}

export type ProviderUpdatePresentationKind =
  | NonNullable<ServerProviderStatus["updateState"]>["status"]
  | "behind_latest"
  | "current"
  | "unknown";

export interface ProviderUpdatePresentation {
  readonly kind: ProviderUpdatePresentationKind;
  readonly label: string | null;
  readonly message: string | null;
  readonly manualCommand: string | null;
  readonly isVerifiedSuccess: boolean;
  readonly severity: "error" | "success" | "warning";
}

export function resolveProviderUpdateManualCommand(
  ...providers: ReadonlyArray<ServerProviderStatus | undefined>
): string | null {
  for (const provider of providers) {
    const command = provider?.versionAdvisory?.updateCommand?.trim();
    if (command) {
      return command;
    }
  }
  return null;
}

function formatProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function behindLatestLabel(provider: ServerProviderStatus): string {
  const advisory = provider.versionAdvisory;
  const currentVersion = formatProviderVersion(advisory?.currentVersion);
  const latestVersion = formatProviderVersion(advisory?.latestVersion);
  if (currentVersion && latestVersion) {
    return `${currentVersion} -> ${latestVersion}`;
  }
  if (latestVersion) {
    return `Latest ${latestVersion}`;
  }
  return "Update available";
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function hasNewerVersionAdvisory(
  provider: ServerProviderStatus,
  status: "behind_latest" | "current",
): boolean {
  if (provider.versionAdvisory?.status !== status) {
    return false;
  }
  const advisoryCheckedAt = parseIsoTimestamp(provider.versionAdvisory.checkedAt);
  if (advisoryCheckedAt === null) {
    return false;
  }
  const updateFinishedAt = parseIsoTimestamp(provider.updateState?.finishedAt);
  return updateFinishedAt === null || advisoryCheckedAt > updateFinishedAt;
}

/**
 * Resolves the provider-update state once for settings labels and update toasts.
 * Active work stays authoritative. A later verified-current advisory can clear
 * a stale incomplete result, while a later release can supersede a completed
 * success without erasing meaningful incomplete failure semantics.
 */
export function getProviderUpdatePresentation(
  provider: ServerProviderStatus | undefined,
): ProviderUpdatePresentation {
  if (!provider) {
    return {
      kind: "unknown",
      label: null,
      message: "The server returned without a verified terminal update result.",
      manualCommand: null,
      isVerifiedSuccess: false,
      severity: "error",
    };
  }

  const state = provider.updateState;
  const manualCommand = resolveProviderUpdateManualCommand(provider);
  if (state?.status === "queued") {
    return {
      kind: "queued",
      label: "Update queued",
      message: state.message,
      manualCommand,
      isVerifiedSuccess: false,
      severity: "warning",
    };
  }
  if (state?.status === "running") {
    return {
      kind: "running",
      label: "Updating",
      message: state.message,
      manualCommand,
      isVerifiedSuccess: false,
      severity: "warning",
    };
  }
  const currentVersion = formatProviderVersion(provider.version);
  if (
    state &&
    INCOMPLETE_PROVIDER_UPDATE_STATES.has(state.status) &&
    hasNewerVersionAdvisory(provider, "current")
  ) {
    return {
      kind: "current",
      label: currentVersion ? `Current ${currentVersion}` : null,
      message: provider.versionAdvisory?.message ?? null,
      manualCommand,
      isVerifiedSuccess: false,
      severity: "warning",
    };
  }
  if (state && INCOMPLETE_PROVIDER_UPDATE_STATES.has(state.status)) {
    const labels = {
      failed: "Update failed",
      still_outdated: "Still outdated",
      unchanged: "No version change",
      unverified: "Update unverified",
    } as const;
    const kind = state.status as keyof typeof labels;
    return {
      kind,
      label: labels[kind],
      message: providerUpdateIncompleteMessage(provider),
      manualCommand,
      isVerifiedSuccess: false,
      severity: kind === "failed" ? "error" : "warning",
    };
  }

  const completedSuccessfully =
    state?.status === "succeeded" || state?.status === "already_current";
  if (
    provider.versionAdvisory?.status === "behind_latest" &&
    (!completedSuccessfully || hasNewerVersionAdvisory(provider, "behind_latest"))
  ) {
    return {
      kind: "behind_latest",
      label: behindLatestLabel(provider),
      message: provider.versionAdvisory.message ?? "A newer provider version is available.",
      manualCommand,
      isVerifiedSuccess: false,
      severity: "warning",
    };
  }

  if (state?.status === "succeeded") {
    return {
      kind: "succeeded",
      label: "Updated",
      message: state.message,
      manualCommand,
      isVerifiedSuccess: true,
      severity: "success",
    };
  }
  if (state?.status === "already_current") {
    return {
      kind: "already_current",
      label: "Already current",
      message: state.message,
      manualCommand,
      isVerifiedSuccess: true,
      severity: "success",
    };
  }

  const isCurrent = provider.versionAdvisory?.status === "current";
  return {
    kind: isCurrent ? "current" : (state?.status ?? "unknown"),
    label: currentVersion ? `${isCurrent ? "Current" : "Installed"} ${currentVersion}` : null,
    message: state?.message ?? provider.versionAdvisory?.message ?? null,
    manualCommand,
    isVerifiedSuccess: false,
    severity: "warning",
  };
}

export function shouldOfferProviderUpdateAction(provider: ServerProviderStatus): boolean {
  const advisory = provider.versionAdvisory;
  return (
    advisory?.canUpdate === true &&
    advisory.updateCommand !== null &&
    (advisory.status === "behind_latest" || advisory.status === "unknown")
  );
}

function isProviderEnabled(
  provider: ProviderKind,
  serverSettings: Pick<ServerSettings, "providers"> | null | undefined,
): boolean {
  if (!serverSettings) {
    return false;
  }
  return serverSettings.providers[provider]?.enabled !== false;
}

// Central visibility gate used by both global toasts and Settings update rows.
export function shouldShowProviderUpdateStatus(input: ProviderUpdateVisibilityInput): boolean {
  const advisory = input.provider.versionAdvisory;
  const hiddenProviderSet = input.hiddenProviderSet ?? new Set(input.hiddenProviders ?? []);
  if (
    !advisory ||
    input.serverSettings?.enableProviderUpdateChecks === false ||
    advisory.status !== "behind_latest" ||
    advisory.latestVersion === null ||
    hiddenProviderSet.has(input.provider.provider) ||
    !isProviderEnabled(input.provider.provider, input.serverSettings)
  ) {
    return false;
  }

  return input.oneClickOnly === true
    ? advisory.canUpdate === true && advisory.updateCommand !== null
    : true;
}

export function getVisibleProviderUpdateStatuses(
  input: ProviderUpdateFilterInput,
): ServerProviderStatus[] {
  const hiddenProviderSet = new Set(input.hiddenProviders ?? []);
  const oneClickOnly = input.oneClickOnly ?? false;

  return input.providers.filter((provider) =>
    shouldShowProviderUpdateStatus({
      provider,
      serverSettings: input.serverSettings,
      hiddenProviderSet,
      oneClickOnly,
    }),
  );
}

export function providerUpdateNotificationKey(
  providers: ReadonlyArray<ServerProviderStatus>,
): string | null {
  const parts = providers
    .map((provider) =>
      [
        provider.provider,
        provider.versionAdvisory?.latestVersion ?? "unknown",
        isProviderUpdateActive(provider)
          ? "active"
          : shouldOfferProviderUpdateAction(provider)
            ? "actionable"
            : "manual",
      ].join(":"),
    )
    .toSorted();

  return parts.length > 0 ? parts.join("|") : null;
}
