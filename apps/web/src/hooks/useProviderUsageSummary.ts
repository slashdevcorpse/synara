// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type {
  OrchestrationThread,
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
} from "~/lib/openUsageRateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
import {
  isProviderUsageSnapshotNonOk,
  normalizeServerProviderUsageLines,
  normalizeServerProviderUsageRateLimit,
} from "~/lib/providerUsageSnapshot";
import {
  deriveProviderUsageLearnMoreHref,
  deriveRateLimitLearnMoreHref,
  deriveAccountRateLimits,
  mergeProviderRateLimits,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import {
  serverAllProviderUsageQueryOptions,
  serverProviderUsageSnapshotQueryOptions,
} from "~/lib/serverReactQuery";

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  threads?: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  codexHomePath?: string | null;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  fetchProviderData?: boolean;
  includeSupplementalData?: boolean | undefined;
}) {
  const provider = input.provider ?? null;
  const shouldFetchProviderData = input.fetchProviderData ?? true;
  const includeSupplementalData = input.includeSupplementalData ?? true;
  const shouldFetchLiveProviderUsage =
    shouldFetchProviderData && provider !== null && input.providerSnapshot === undefined;
  const shouldFetchSupplementalProviderUsage =
    shouldFetchLiveProviderUsage && includeSupplementalData;
  const allProviderUsageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: shouldFetchLiveProviderUsage,
      includeLocalUsage: includeSupplementalData,
      provider,
    }),
  );
  const localUsageSnapshotQueryOptions = serverProviderUsageSnapshotQueryOptions({
    provider,
    homePath: provider === "codex" ? input.codexHomePath || null : null,
    enabled: shouldFetchSupplementalProviderUsage,
  });
  const localUsageSnapshotQuery = useQuery(localUsageSnapshotQueryOptions);
  const openUsageSnapshotQueryOptions = openUsageProviderSnapshotQueryOptions(provider, {
    enabled: shouldFetchSupplementalProviderUsage,
  });
  const openUsageSnapshotQuery = useQuery(openUsageSnapshotQueryOptions);
  const shouldReadLocalUsageSnapshot = localUsageSnapshotQueryOptions.enabled === true;
  const shouldReadOpenUsageSnapshot = openUsageSnapshotQueryOptions.enabled === true;
  const liveProviderSnapshot = shouldFetchLiveProviderUsage
    ? (allProviderUsageQuery.data ?? []).find((snapshot) => snapshot.provider === provider)
    : undefined;
  const authoritativeLiveSnapshot = input.providerSnapshot ?? liveProviderSnapshot ?? null;
  // Explicit live failures are authoritative; only fall back when no live snapshot exists.
  const blocksProviderUsageFallback = isProviderUsageSnapshotNonOk(authoritativeLiveSnapshot);
  const accountRateLimits = includeSupplementalData
    ? (input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []))
    : [];

  let rateLimits: ReadonlyArray<ProviderRateLimit> = [];
  if (!blocksProviderUsageFallback) {
    const localSnapshot = shouldReadLocalUsageSnapshot
      ? (localUsageSnapshotQuery.data ?? null)
      : null;
    const derivedRateLimits = accountRateLimits.filter((rateLimit) =>
      provider ? rateLimit.provider === provider : true,
    );
    const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(authoritativeLiveSnapshot);
    const localUsageRateLimit = normalizeServerProviderUsageRateLimit(localSnapshot);
    const openUsageSnapshot = shouldReadOpenUsageSnapshot
      ? normalizeOpenUsageSnapshot(openUsageSnapshotQuery.data, provider)
      : null;
    rateLimits = mergeProviderRateLimits(
      derivedRateLimits,
      mergeProviderRateLimits(
        liveUsageRateLimit ? [liveUsageRateLimit] : [],
        mergeProviderRateLimits(
          localUsageRateLimit ? [localUsageRateLimit] : [],
          openUsageSnapshot ? [openUsageSnapshot] : [],
        ),
      ),
    );
  }

  let usageLines: ReturnType<typeof normalizeServerProviderUsageLines> = [];
  if (!blocksProviderUsageFallback) {
    const liveUsageLines = normalizeServerProviderUsageLines(authoritativeLiveSnapshot);
    if (liveUsageLines.length > 0) {
      usageLines = liveUsageLines;
    } else {
      const localUsageLines = shouldReadLocalUsageSnapshot
        ? normalizeServerProviderUsageLines(localUsageSnapshotQuery.data)
        : [];
      usageLines =
        localUsageLines.length > 0
          ? localUsageLines
          : shouldReadOpenUsageSnapshot
            ? normalizeOpenUsageUsageLines(openUsageSnapshotQuery.data)
            : [];
    }
  }

  // A throttle/staleness note the server rides on an otherwise-ok snapshot (e.g. Claude serving the
  // last values while Anthropic rate-limits). Only surfaced when the snapshot is actually shown —
  // non-ok snapshots hide the section entirely, so their `detail` would never be seen anyway.
  const detail = blocksProviderUsageFallback
    ? undefined
    : authoritativeLiveSnapshot?.detail?.trim();
  const usageNotice = detail ? detail : undefined;

  const learnMoreHref =
    deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(provider);

  const isLoading =
    shouldFetchLiveProviderUsage &&
    allProviderUsageQuery.isPending &&
    (!shouldReadLocalUsageSnapshot || localUsageSnapshotQuery.isPending) &&
    rateLimits.length === 0 &&
    usageLines.length === 0;

  const snapshotStatus = authoritativeLiveSnapshot?.status ?? null;
  const snapshotDetail = authoritativeLiveSnapshot?.detail?.trim() || null;
  const planName = authoritativeLiveSnapshot?.planName?.trim() || null;

  return {
    isLoading,
    learnMoreHref,
    planName,
    rateLimits,
    snapshotDetail,
    snapshotStatus,
    usageLines,
    usageNotice,
  } as const;
}
