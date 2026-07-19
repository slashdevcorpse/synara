import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAllThreadsSelector: vi.fn(() => () => ["supplemental-thread"]),
  useProviderUsageSummary: vi.fn((_input: { threads: unknown }) => ({
    isLoading: false,
    planName: null,
    rateLimits: [],
    snapshotDetail: null,
    snapshotStatus: "ok" as const,
    usageLines: [],
    usageNotice: undefined,
  })),
  useStore: vi.fn((selector: () => unknown) => selector()),
}));

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: { codexHomePath: "" } }),
}));

vi.mock("~/hooks/useProviderUsageSummary", () => ({
  useProviderUsageSummary: mocks.useProviderUsageSummary,
}));

vi.mock("~/store", () => ({
  useStore: mocks.useStore,
}));

vi.mock("~/storeSelectors", () => ({
  createAllThreadsSelector: mocks.createAllThreadsSelector,
}));

import { useProviderUsageMenuModel } from "./ProviderUsageMenuControl";

describe("ProviderUsageMenuControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one stable empty thread selection when supplemental data is disabled", () => {
    const options = {
      includeEmptyState: true as const,
      includeSupplementalData: false,
    };

    useProviderUsageMenuModel("codex", options);
    useProviderUsageMenuModel("codex", options);

    expect(mocks.createAllThreadsSelector).not.toHaveBeenCalled();
    expect(mocks.useStore).toHaveBeenCalledTimes(2);
    expect(mocks.useStore.mock.calls[1]![0]).toBe(mocks.useStore.mock.calls[0]![0]);
    expect(mocks.useProviderUsageSummary).toHaveBeenCalledTimes(2);
    const firstThreads = mocks.useProviderUsageSummary.mock.calls[0]![0].threads;
    const secondThreads = mocks.useProviderUsageSummary.mock.calls[1]![0].threads;
    expect(firstThreads).toEqual([]);
    expect(secondThreads).toBe(firstThreads);
  });
});
