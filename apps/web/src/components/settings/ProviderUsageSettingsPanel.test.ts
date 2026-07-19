import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allProviderUsageKey: vi.fn(
    (provider: unknown = null, includeLocalUsage = true) =>
      ["server", "allProviderUsage", provider ?? null, includeLocalUsage] as const,
  ),
  fetchAllProviderUsage: vi.fn(),
  serverAllProviderUsageQueryOptions: vi.fn((input: { includeLocalUsage: boolean }) => ({
    queryKey: ["server", "allProviderUsage", null, input.includeLocalUsage] as const,
  })),
  setQueryData: vi.fn(),
  updateSettings: vi.fn(),
  useMutation: vi.fn(),
  useProviderUsageSummary: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: mocks.useMutation,
  useQuery: mocks.useQuery,
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
}));

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({
    settings: { showComposerProviderUsage: true },
    updateSettings: mocks.updateSettings,
  }),
}));

vi.mock("~/hooks/useProviderUsageSummary", () => ({
  useProviderUsageSummary: mocks.useProviderUsageSummary,
}));

vi.mock("~/components/ProviderIcon", () => ({
  ProviderIcon: () => null,
}));

vi.mock("~/lib/icons", () => ({
  RotateCcwIcon: () => null,
  TriangleAlertIcon: () => null,
}));

vi.mock("~/lib/serverReactQuery", () => ({
  fetchAllProviderUsage: mocks.fetchAllProviderUsage,
  serverAllProviderUsageQueryOptions: mocks.serverAllProviderUsageQueryOptions,
  serverQueryKeys: { allProviderUsage: mocks.allProviderUsageKey },
}));

import {
  completeProviderUsageRefresh,
  ProviderUsageSettingsPanel,
} from "./ProviderUsageSettingsPanel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useQuery.mockReturnValue({
    data: [],
    isFetching: false,
    isPending: false,
  });
  mocks.useMutation.mockReturnValue({
    isPending: false,
    mutate: vi.fn(),
  });
  mocks.useProviderUsageSummary.mockReturnValue({
    rateLimits: [],
    usageLines: [],
    usageNotice: undefined,
  });
});

describe("completeProviderUsageRefresh", () => {
  it("returns only supported providers and replaces omitted snapshots", () => {
    const claudeSnapshot: ServerProviderUsageSnapshot = {
      provider: "claudeAgent",
      updatedAt: "2026-07-18T12:00:00.000Z",
      limits: [{ window: "Weekly", usedPercent: 42 }],
      usageLines: [],
      source: "test",
      status: "ok",
    };

    const snapshots = completeProviderUsageRefresh([claudeSnapshot]);

    expect(snapshots.map((snapshot) => snapshot.provider)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
    ]);
    expect(snapshots.find((snapshot) => snapshot.provider === "claudeAgent")).toBe(claudeSnapshot);
    expect(snapshots.find((snapshot) => snapshot.provider === "codex")).toMatchObject({
      status: "error",
      detail: "Usage is currently unavailable.",
    });
    expect(snapshots.some((snapshot) => snapshot.provider === "antigravity")).toBe(false);
  });
});

describe("ProviderUsageSettingsPanel account-only query contract", () => {
  it("uses the non-local cache for the initial query and forced refresh", async () => {
    renderToStaticMarkup(createElement(ProviderUsageSettingsPanel));

    expect(mocks.serverAllProviderUsageQueryOptions).toHaveBeenCalledOnce();
    expect(mocks.serverAllProviderUsageQueryOptions).toHaveBeenCalledWith({
      includeLocalUsage: false,
    });
    expect(mocks.useQuery).toHaveBeenCalledWith({
      queryKey: ["server", "allProviderUsage", null, false],
    });

    const mutationOptions = mocks.useMutation.mock.calls[0]?.[0] as
      | {
          mutationFn: () => Promise<readonly ServerProviderUsageSnapshot[]>;
          onSuccess: (data: readonly ServerProviderUsageSnapshot[]) => void;
        }
      | undefined;
    expect(mutationOptions).toBeDefined();

    const refreshedSnapshot: ServerProviderUsageSnapshot = {
      provider: "codex",
      updatedAt: "2026-07-19T12:00:00.000Z",
      limits: [{ window: "Weekly", usedPercent: 25 }],
      usageLines: [],
      source: "test",
      status: "ok",
    };
    mocks.fetchAllProviderUsage.mockResolvedValue([refreshedSnapshot]);

    await expect(mutationOptions?.mutationFn()).resolves.toEqual([refreshedSnapshot]);
    expect(mocks.fetchAllProviderUsage).toHaveBeenCalledWith({
      forceRefresh: true,
      includeLocalUsage: false,
    });

    mutationOptions?.onSuccess([refreshedSnapshot]);
    expect(mocks.allProviderUsageKey).toHaveBeenCalledWith(null, false);
    expect(mocks.setQueryData).toHaveBeenCalledWith(
      ["server", "allProviderUsage", null, false],
      completeProviderUsageRefresh([refreshedSnapshot]),
    );
  });

  it("keeps every settings card on its explicit account snapshot", () => {
    renderToStaticMarkup(createElement(ProviderUsageSettingsPanel));

    expect(mocks.useProviderUsageSummary).toHaveBeenCalledTimes(3);
    for (const [input] of mocks.useProviderUsageSummary.mock.calls) {
      expect(input).toEqual(
        expect.objectContaining({
          fetchProviderData: false,
          includeSupplementalData: false,
          providerSnapshot: expect.objectContaining({ provider: expect.any(String) }),
        }),
      );
      expect(input).not.toHaveProperty("codexHomePath");
      expect(input).not.toHaveProperty("threadRateLimits");
      expect(input).not.toHaveProperty("threads");
    }
  });
});
