// FILE: useProviderStatusRefresh.ts
// Purpose: Shared provider-status refresh hooks — focus/periodic version checks plus an
//          imperative refresh callback for UI affordances (voice auth retry, banners).
// Layer: Web hooks
// Exports: useProviderStatusRefresh, useRefreshProviderStatusesNow

import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ServerConfig, ServerProviderStatus } from "@synara/contracts";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { serverQueryKeys } from "../lib/serverReactQuery";

export type RefreshProviderStatusesOptions = {
  readonly minIntervalMs?: number;
  readonly silent?: boolean;
};

export type RefreshProviderStatusesNow = (
  options?: RefreshProviderStatusesOptions,
) => Promise<readonly ServerProviderStatus[] | null>;

export const PROVIDER_STATUS_FOREGROUND_REFRESH_MIN_INTERVAL_MS = 15_000;

type ProviderStatusRefreshState = {
  inFlight: Promise<readonly ServerProviderStatus[]> | null;
  lastStartedAtMs: number | null;
};

const providerStatusRefreshStateByQueryClient = new WeakMap<
  QueryClient,
  ProviderStatusRefreshState
>();

function writeProviderStatusesToConfigCache(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
) {
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) =>
    current ? { ...current, providers } : current,
  );
}

function getProviderStatusRefreshState(queryClient: QueryClient): ProviderStatusRefreshState {
  const existing = providerStatusRefreshStateByQueryClient.get(queryClient);
  if (existing) return existing;

  const created: ProviderStatusRefreshState = {
    inFlight: null,
    lastStartedAtMs: null,
  };
  providerStatusRefreshStateByQueryClient.set(queryClient, created);
  return created;
}

async function refreshProviderStatusesNow(
  queryClient: QueryClient,
  options?: RefreshProviderStatusesOptions,
): Promise<readonly ServerProviderStatus[] | null> {
  const api = readNativeApi();
  if (!api) return null;

  const state = getProviderStatusRefreshState(queryClient);
  const minIntervalMs = options?.minIntervalMs ?? 0;
  const nowMs = Date.now();
  const refreshPromise =
    state.inFlight ??
    (minIntervalMs > 0 &&
    state.lastStartedAtMs !== null &&
    nowMs - state.lastStartedAtMs < minIntervalMs
      ? null
      : Promise.resolve()
          .then(() => api.server.refreshProviders())
          .then((result) => {
            writeProviderStatusesToConfigCache(queryClient, result.providers);
            return result.providers;
          })
          .finally(() => {
            state.inFlight = null;
          }));

  if (!refreshPromise) return null;
  if (!state.inFlight) {
    state.lastStartedAtMs = nowMs;
    state.inFlight = refreshPromise;
  }

  try {
    return await refreshPromise;
  } catch (error) {
    if (!options?.silent) {
      toastManager.add({
        type: "error",
        title: "Unable to refresh provider status",
        description:
          error instanceof Error ? error.message : "Unknown error refreshing provider status.",
      });
    }
    return null;
  }
}

/**
 * Imperative one-shot provider-status refresh: re-checks providers on the server
 * and folds the result into the cached server config. Surfaces failures as a toast.
 */
export function useRefreshProviderStatusesNow(): RefreshProviderStatusesNow {
  const queryClient = useQueryClient();
  return (options?: RefreshProviderStatusesOptions) =>
    refreshProviderStatusesNow(queryClient, options);
}

type ProviderStatusRefreshOptions = {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly minIntervalMs?: number;
  readonly refreshOnFocus?: boolean;
};

export function useProviderStatusRefresh(options: ProviderStatusRefreshOptions): void {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const initialDelayMs = options.initialDelayMs;
  const intervalMs = options.intervalMs;
  const minIntervalMs = options.minIntervalMs ?? 0;
  const refreshOnFocus = options.refreshOnFocus ?? false;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const triggerProviderStatusRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshProviderStatusesNow(queryClient, {
        minIntervalMs,
        silent: true,
      });
    };

    const initialRefreshId =
      typeof initialDelayMs === "number" && initialDelayMs >= 0
        ? window.setTimeout(triggerProviderStatusRefresh, initialDelayMs)
        : null;
    const refreshIntervalId =
      typeof intervalMs === "number" && intervalMs > 0
        ? window.setInterval(triggerProviderStatusRefresh, intervalMs)
        : null;

    if (refreshOnFocus) {
      window.addEventListener("focus", triggerProviderStatusRefresh);
      document.addEventListener("visibilitychange", triggerProviderStatusRefresh);
    }

    return () => {
      if (initialRefreshId !== null) {
        window.clearTimeout(initialRefreshId);
      }
      if (refreshIntervalId !== null) {
        window.clearInterval(refreshIntervalId);
      }
      if (refreshOnFocus) {
        window.removeEventListener("focus", triggerProviderStatusRefresh);
        document.removeEventListener("visibilitychange", triggerProviderStatusRefresh);
      }
    };
  }, [enabled, initialDelayMs, intervalMs, minIntervalMs, queryClient, refreshOnFocus]);
}
