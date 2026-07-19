// FILE: useProviderUsageSummary.test.tsx
// Purpose: Verifies how the shared provider-usage summary hook arbitrates live,
// local, OpenUsage, and thread-derived fallback usage signals.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { openUsageQueryKeys } from "~/lib/openUsageReactQuery";
import type { ProviderRateLimit } from "~/lib/rateLimits";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { useProviderUsageSummary } from "./useProviderUsageSummary";

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-06-09T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    ...input,
  };
}

function fallbackSnapshot(): ServerProviderUsageSnapshot {
  return snapshot({
    limits: [
      {
        window: "Weekly",
        usedPercent: 64,
        resetsAt: "2026-06-15T12:00:00.000Z",
        windowDurationMins: 10080,
      },
    ],
    usageLines: [{ label: "24h", value: "123M tokens", subtitle: "12 recent sessions" }],
  });
}

function threadFallbackRateLimits(): ReadonlyArray<ProviderRateLimit> {
  return [
    {
      provider: "claudeAgent",
      updatedAt: "2026-06-09T12:00:00.000Z",
      limits: [{ window: "Thread cache", usedPercent: 12 }],
    },
  ];
}

function seedCachedProviderUsage(queryClient: QueryClient, input: { includeLocalUsage: boolean }) {
  queryClient.setQueryData(
    serverQueryKeys.allProviderUsage("claudeAgent", input.includeLocalUsage),
    [
      snapshot({
        status: "ok",
        planName: "Cached live plan",
        detail: "Cached live detail",
        limits: [{ window: "Cached live", usedPercent: 70 }],
        usageLines: [{ label: "Cached live", value: "70%" }],
      }),
    ],
  );
  queryClient.setQueryData(serverQueryKeys.providerUsage("claudeAgent", null), fallbackSnapshot());
  queryClient.setQueryData(openUsageQueryKeys.provider("claudeAgent"), {
    providerId: "claude",
    fetchedAt: "2026-06-09T12:00:00.000Z",
    lines: [
      { type: "progress", label: "OpenUsage cache", used: 80, limit: 100 },
      { type: "text", label: "OpenUsage cache", value: "80%" },
    ],
  });
}

function renderWithQueryClient(queryClient: QueryClient, node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

function readProviderUsageSummary(input: {
  queryClient: QueryClient;
  provider?: ProviderKind | undefined;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  providerSnapshot?: ServerProviderUsageSnapshot | undefined;
  fetchProviderData?: boolean | undefined;
  includeSupplementalData?: boolean | undefined;
}) {
  // Capture into a ref-style holder: the hook only runs inside the closure, so a
  // plain `let` would narrow to `never` after the guard (TS can't see <Probe/> run).
  const captured: { current: ReturnType<typeof useProviderUsageSummary> | null } = {
    current: null,
  };

  function Probe() {
    captured.current = useProviderUsageSummary({
      provider: input.provider ?? "claudeAgent",
      threads: [],
      threadRateLimits: input.threadRateLimits,
      providerSnapshot: input.providerSnapshot,
      ...(input.fetchProviderData === undefined
        ? {}
        : { fetchProviderData: input.fetchProviderData }),
      includeSupplementalData: input.includeSupplementalData,
    });
    return <span />;
  }

  renderWithQueryClient(input.queryClient, <Probe />);

  if (!captured.current) {
    throw new Error("Provider usage summary probe did not render.");
  }
  return captured.current;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

describe("useProviderUsageSummary", () => {
  it("scopes live snapshots to the selected provider across provider switches", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage("codex"), [
      snapshot({
        provider: "codex",
        status: "ok",
        limits: [{ window: "Weekly", usedPercent: 20 }],
      }),
    ]);
    queryClient.setQueryData(serverQueryKeys.allProviderUsage("claudeAgent"), [
      snapshot({
        provider: "claudeAgent",
        status: "ok",
        limits: [{ window: "Weekly", usedPercent: 70 }],
      }),
    ]);

    const codexSummary = readProviderUsageSummary({ queryClient, provider: "codex" });
    const claudeSummary = readProviderUsageSummary({ queryClient, provider: "claudeAgent" });

    expect(codexSummary.rateLimits).toMatchObject([
      { provider: "codex", limits: [{ window: "Weekly", usedPercent: 20 }] },
    ]);
    expect(claudeSummary.rateLimits).toMatchObject([
      { provider: "claudeAgent", limits: [{ window: "Weekly", usedPercent: 70 }] },
    ]);
  });

  it("does not show local fallback rows when the live batch reports a non-ok status", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage("claudeAgent"), [
      snapshot({ status: "needs-auth", detail: "Sign in with claude to see usage." }),
    ]);
    queryClient.setQueryData(
      serverQueryKeys.providerUsage("claudeAgent", null),
      fallbackSnapshot(),
    );

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
  });

  it("still uses local fallback rows when no live snapshot exists", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage("claudeAgent"), []);
    queryClient.setQueryData(
      serverQueryKeys.providerUsage("claudeAgent", null),
      fallbackSnapshot(),
    );

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.rateLimits[0]?.limits?.[0]?.window).toBe("Weekly");
    expect(summary.usageLines).toEqual([
      { label: "24h", value: "123M tokens", subtitle: "12 recent sessions" },
    ]);
  });

  it("accepts precomputed thread fallback rows from aggregate provider surfaces", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage("claudeAgent"), []);

    const summary = readProviderUsageSummary({
      queryClient,
      threadRateLimits: [
        {
          provider: "claudeAgent",
          updatedAt: "2026-06-09T12:00:00.000Z",
          limits: [
            {
              window: "5h",
              usedPercent: 12,
              resetsAt: "2026-06-09T17:00:00.000Z",
              windowDurationMins: 300,
            },
          ],
        },
      ],
    });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.rateLimits[0]?.limits?.[0]?.window).toBe("5h");
    expect(summary.rateLimits[0]?.limits?.[0]?.usedPercent).toBe(12);
  });

  it("surfaces the throttle notice from an ok snapshot that carries a detail", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage("claudeAgent"), [
      snapshot({
        status: "ok",
        planName: "Max (5x)",
        detail: "Anthropic is rate-limiting usage checks — showing your last values.",
        limits: [
          {
            window: "Weekly",
            usedPercent: 64,
            resetsAt: "2026-06-15T12:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      }),
    ]);

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.planName).toBe("Max (5x)");
    expect(summary.usageNotice).toContain("rate-limiting");
  });

  it("has no notice when the live snapshot is non-ok", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage("claudeAgent"), [
      snapshot({ status: "error", detail: "Usage is currently unavailable." }),
    ]);

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.usageNotice).toBeUndefined();
  });

  it("keeps an explicit non-ok snapshot authoritative over every cached fallback", () => {
    const queryClient = createQueryClient();
    seedCachedProviderUsage(queryClient, { includeLocalUsage: false });

    const summary = readProviderUsageSummary({
      queryClient,
      includeSupplementalData: false,
      threadRateLimits: threadFallbackRateLimits(),
      providerSnapshot: snapshot({
        status: "error",
        planName: "Authoritative failed plan",
        detail: "Usage is currently unavailable.",
      }),
    });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
    expect(summary.planName).toBe("Authoritative failed plan");
    expect(summary.snapshotStatus).toBe("error");
    expect(summary.snapshotDetail).toBe("Usage is currently unavailable.");
    expect(summary.usageNotice).toBeUndefined();
  });

  it("exposes only an explicit snapshot when every disabled source has cached data", () => {
    const queryClient = createQueryClient();
    seedCachedProviderUsage(queryClient, { includeLocalUsage: false });

    const summary = readProviderUsageSummary({
      queryClient,
      includeSupplementalData: false,
      threadRateLimits: threadFallbackRateLimits(),
      providerSnapshot: snapshot({
        status: "ok",
        planName: "Authoritative plan",
        detail: "Authoritative detail",
        limits: [{ window: "Weekly", usedPercent: 20 }],
        usageLines: [{ label: "Authoritative", value: "20%" }],
      }),
    });

    expect(summary.rateLimits).toMatchObject([
      { provider: "claudeAgent", limits: [{ window: "Weekly", usedPercent: 20 }] },
    ]);
    expect(summary.usageLines).toEqual([{ label: "Authoritative", value: "20%" }]);
    expect(summary.planName).toBe("Authoritative plan");
    expect(summary.snapshotStatus).toBe("ok");
    expect(summary.snapshotDetail).toBe("Authoritative detail");
  });

  it("does not leak cached supplemental data while an account-only live snapshot is pending", () => {
    const queryClient = createQueryClient();
    seedCachedProviderUsage(queryClient, { includeLocalUsage: true });

    const summary = readProviderUsageSummary({
      queryClient,
      includeSupplementalData: false,
      threadRateLimits: threadFallbackRateLimits(),
    });

    expect(
      queryClient.getQueryData(serverQueryKeys.allProviderUsage("claudeAgent", false)),
    ).toBeUndefined();
    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
    expect(summary.planName).toBeNull();
    expect(summary.snapshotStatus).toBeNull();
    expect(summary.snapshotDetail).toBeNull();
    expect(summary.isLoading).toBe(true);
  });

  it("stays loading while OpenUsage is the only pending provider-usage source", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => "true",
      },
    });

    try {
      const queryClient = createQueryClient();
      queryClient.setQueryData(serverQueryKeys.allProviderUsage("claudeAgent"), []);
      queryClient.setQueryData(
        serverQueryKeys.providerUsage("claudeAgent", null),
        snapshot({ status: "ok" }),
      );

      const summary = readProviderUsageSummary({ queryClient });

      expect(queryClient.getQueryData(openUsageQueryKeys.provider("claudeAgent"))).toBeUndefined();
      expect(summary.rateLimits).toEqual([]);
      expect(summary.usageLines).toEqual([]);
      expect(summary.isLoading).toBe(true);

      queryClient.setQueryData(openUsageQueryKeys.provider("claudeAgent"), {
        providerId: "claude",
        fetchedAt: "2026-06-09T12:00:00.000Z",
        lines: [],
      });

      expect(readProviderUsageSummary({ queryClient }).isLoading).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not read any cached query when live fetching is disabled without an explicit snapshot", () => {
    const queryClient = createQueryClient();
    seedCachedProviderUsage(queryClient, { includeLocalUsage: false });

    const summary = readProviderUsageSummary({
      queryClient,
      fetchProviderData: false,
      includeSupplementalData: false,
      threadRateLimits: threadFallbackRateLimits(),
    });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
    expect(summary.planName).toBeNull();
    expect(summary.snapshotStatus).toBeNull();
    expect(summary.snapshotDetail).toBeNull();
    expect(summary.isLoading).toBe(false);
  });
});
