// FILE: useProviderStatusRefresh.test.ts
// Purpose: Locks provider refresh cache reconciliation, single-flight, throttling, and failure policy.
// Layer: Web hook tests

import type { NativeApi, ServerConfig, ServerProviderStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serverQueryKeys } from "../lib/serverReactQuery";

const harness = vi.hoisted(() => ({
  api: undefined as NativeApi | undefined,
  queryClient: undefined as QueryClient | undefined,
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => harness.queryClient,
  };
});

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => harness.api,
}));

import {
  PROVIDER_STATUS_FOREGROUND_REFRESH_MIN_INTERVAL_MS,
  useRefreshProviderStatusesNow,
} from "./useProviderStatusRefresh";

function providerStatus(
  version: string,
  advisoryStatus: "behind_latest" | "current",
): ServerProviderStatus {
  return {
    provider: "commandCode",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    version,
    checkedAt: "2026-07-23T12:00:00.000Z",
    versionAdvisory: {
      status: advisoryStatus,
      currentVersion: version,
      latestVersion: "1.3.1",
      updateCommand:
        advisoryStatus === "behind_latest" ? "npm install -g @commandcode/cli@latest" : null,
      canUpdate: advisoryStatus === "behind_latest",
      checkedAt: "2026-07-23T12:00:00.000Z",
      message: advisoryStatus === "behind_latest" ? "Update available." : null,
    },
  };
}

function serverConfig(providers: readonly ServerProviderStatus[]): ServerConfig {
  return { providers } as unknown as ServerConfig;
}

function setRefreshImplementation(
  implementation: () => Promise<{ providers: readonly ServerProviderStatus[] }>,
) {
  const refreshProviders = vi.fn(implementation);
  harness.api = {
    server: { refreshProviders },
  } as unknown as NativeApi;
  return refreshProviders;
}

beforeEach(() => {
  harness.queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  harness.toast.mockReset();
  harness.api = undefined;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
});

afterEach(() => {
  harness.queryClient?.clear();
  harness.queryClient = undefined;
  harness.api = undefined;
  vi.useRealTimers();
});

describe("provider status refresh", () => {
  it("reconciles a stale external CLI version and rate-limits repeat foreground probes", async () => {
    const stale = providerStatus("0.52.1", "behind_latest");
    const current = providerStatus("1.3.1", "current");
    harness.queryClient!.setQueryData(serverQueryKeys.config(), serverConfig([stale]));
    const refreshProviders = setRefreshImplementation(async () => ({ providers: [current] }));
    const refresh = useRefreshProviderStatusesNow();

    await expect(
      refresh({
        minIntervalMs: PROVIDER_STATUS_FOREGROUND_REFRESH_MIN_INTERVAL_MS,
        silent: true,
      }),
    ).resolves.toEqual([current]);
    await expect(
      refresh({
        minIntervalMs: PROVIDER_STATUS_FOREGROUND_REFRESH_MIN_INTERVAL_MS,
        silent: true,
      }),
    ).resolves.toBeNull();

    expect(refreshProviders).toHaveBeenCalledOnce();
    expect(
      harness.queryClient!.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers,
    ).toEqual([current]);
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("shares an in-flight provider probe between concurrent callers", async () => {
    const current = providerStatus("1.3.1", "current");
    let resolveRefresh!: (result: { providers: readonly ServerProviderStatus[] }) => void;
    const pendingRefresh = new Promise<{ providers: readonly ServerProviderStatus[] }>(
      (resolve) => {
        resolveRefresh = resolve;
      },
    );
    const refreshProviders = setRefreshImplementation(() => pendingRefresh);
    const refresh = useRefreshProviderStatusesNow();

    const first = refresh({ silent: true });
    const second = refresh({ silent: true });
    resolveRefresh({ providers: [current] });

    await expect(first).resolves.toEqual([current]);
    await expect(second).resolves.toEqual([current]);
    expect(refreshProviders).toHaveBeenCalledOnce();
  });

  it("keeps cached status intact and stays silent when a foreground probe fails", async () => {
    const stale = providerStatus("0.52.1", "behind_latest");
    harness.queryClient!.setQueryData(serverQueryKeys.config(), serverConfig([stale]));
    const refreshProviders = setRefreshImplementation(async () => {
      throw new Error("Provider refresh unavailable");
    });
    const refresh = useRefreshProviderStatusesNow();

    await expect(
      refresh({
        minIntervalMs: PROVIDER_STATUS_FOREGROUND_REFRESH_MIN_INTERVAL_MS,
        silent: true,
      }),
    ).resolves.toBeNull();

    expect(refreshProviders).toHaveBeenCalledOnce();
    expect(
      harness.queryClient!.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers,
    ).toEqual([stale]);
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
