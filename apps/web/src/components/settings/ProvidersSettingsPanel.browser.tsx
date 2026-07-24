// FILE: ProvidersSettingsPanel.browser.tsx
// Purpose: Browser regressions for foreground provider-status reconciliation in Settings.
// Layer: Browser component test

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type NativeApi,
  type ServerConfig,
  type ServerProviderStatus,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type AppSettingsBinding, AppSettingsSchema } from "~/appSettings";
import { serverQueryKeys } from "~/lib/serverReactQuery";

const harness = vi.hoisted(() => ({
  api: undefined as NativeApi | undefined,
  toast: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => harness.api,
  readNativeApi: () => harness.api,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
}

const mountedCleanups: Array<() => Promise<void>> = [];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

function settingsBinding(): AppSettingsBinding {
  const settings = AppSettingsSchema.makeUnsafe({});
  return {
    settings,
    defaults: settings,
    updateSettings: vi.fn(),
  };
}

function ProvidersActivityHarness() {
  const [active, setActive] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setActive(false)}>
        Leave Providers
      </button>
      <button type="button" onClick={() => setActive(true)}>
        Return to Providers
      </button>
      <ProvidersSettingsPanel active={active} resetEpoch={0} {...settingsBinding()} />
    </>
  );
}

async function mountProvidersPanel(input: {
  refreshProviders: () => Promise<{ providers: readonly ServerProviderStatus[] }>;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const stale = providerStatus("0.52.1", "behind_latest");
  queryClient.setQueryData(serverQueryKeys.config(), {
    providers: [stale],
  } as unknown as ServerConfig);
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS);
  const refreshProviders = vi.fn(input.refreshProviders);
  harness.api = {
    server: { refreshProviders },
  } as unknown as NativeApi;

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ProvidersActivityHarness />
    </QueryClientProvider>,
  );
  mountedCleanups.push(async () => {
    await screen.unmount();
    queryClient.clear();
  });
  return { refreshProviders, screen };
}

beforeEach(() => {
  harness.api = undefined;
  harness.toast.mockReset();
});

afterEach(async () => {
  for (const cleanup of mountedCleanups.splice(0).reverse()) {
    await cleanup();
  }
  harness.api = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ProvidersSettingsPanel foreground status refresh", () => {
  it("reconciles an external CLI update on activation without repeat probes", async () => {
    const refresh = deferred<{ providers: readonly ServerProviderStatus[] }>();
    const { refreshProviders, screen } = await mountProvidersPanel({
      refreshProviders: () => refresh.promise,
    });

    await screen.getByRole("button", { name: "Return to Providers" }).click();
    await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());
    expect(document.body.textContent).toContain("1 update available");
    expect(document.body.textContent).toContain("v0.52.1 -> v1.3.1");

    refresh.resolve({ providers: [providerStatus("1.3.1", "current")] });
    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("v0.52.1 -> v1.3.1");
      expect(document.body.textContent).toContain(
        "No updates detected among providers with a supported update channel",
      );
    });

    await screen.getByRole("button", { name: "Leave Providers" }).click();
    await screen.getByRole("button", { name: "Return to Providers" }).click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(refreshProviders).toHaveBeenCalledOnce();
  });

  it("keeps the Providers UI usable and cached status visible when refresh fails", async () => {
    const { refreshProviders, screen } = await mountProvidersPanel({
      refreshProviders: async () => {
        throw new Error("Provider refresh unavailable");
      },
    });

    await screen.getByRole("button", { name: "Return to Providers" }).click();
    await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledOnce());

    expect(document.body.textContent).toContain("1 update available");
    expect(document.body.textContent).toContain("v0.52.1 -> v1.3.1");
    expect(screen.getByRole("button", { name: "Leave Providers" }).element()).toBeEnabled();
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
