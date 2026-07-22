import { describe, expect, it } from "vitest";

import {
  isLocalPreviewGrantUsable,
  isProjectReadFileCapacityError,
  LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS,
  localPreviewGrantRefetchIntervalMs,
  projectLocalHtmlPreviewGrantQueryOptions,
  projectLocalPreviewGrantQueryOptions,
  projectReadFileQueryOptions,
} from "./projectReactQuery";

describe("project file-read query options", () => {
  const capacityError = Object.assign(new Error("capacity exceeded"), {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
  });

  it("recognizes direct and wrapped retryable capacity errors", () => {
    expect(isProjectReadFileCapacityError(capacityError)).toBe(true);
    expect(isProjectReadFileCapacityError(new Error("wrapped", { cause: capacityError }))).toBe(
      true,
    );
    expect(
      isProjectReadFileCapacityError({
        code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
        retryable: false,
      }),
    ).toBe(false);
  });

  it("retries transient capacity errors longer than generic failures", () => {
    const options = projectReadFileQueryOptions({ cwd: "C:/workspace", relativePath: "README.md" });
    const retry = options.retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") {
      throw new Error("Expected retry to be a function.");
    }

    expect(retry(11, capacityError)).toBe(true);
    expect(retry(12, capacityError)).toBe(false);
    expect(retry(2, new Error("disk failure"))).toBe(true);
    expect(retry(3, new Error("disk failure"))).toBe(false);
  });

  it("uses bounded backoff for transient capacity errors", () => {
    const options = projectReadFileQueryOptions({ cwd: "C:/workspace", relativePath: "README.md" });
    const retryDelay = options.retryDelay;
    expect(typeof retryDelay).toBe("function");
    if (typeof retryDelay !== "function") {
      throw new Error("Expected retryDelay to be a function.");
    }

    expect(retryDelay(0, capacityError)).toBe(250);
    expect(retryDelay(8, capacityError)).toBe(2_000);
    expect(retryDelay(0, new Error("disk failure"))).toBe(1_000);
    expect(retryDelay(8, new Error("disk failure"))).toBe(30_000);
  });
});

describe("local preview grant query options", () => {
  it("refreshes active preview grants before the server-side token expires", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 120_000).toISOString() },
        nowMs,
      ),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 20_000).toISOString() },
        nowMs,
      ),
    ).toBe(5_000);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs - 1_000).toISOString() },
        nowMs,
      ),
    ).toBe(1_000);
  });

  it("does not treat expired cached grants as usable preview URLs", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 2_000).toISOString() }, nowMs),
    ).toBe(true);
    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 500).toISOString() }, nowMs),
    ).toBe(false);
  });

  it("wires the refresh interval into the React Query options", () => {
    const options = projectLocalPreviewGrantQueryOptions({ path: "/Users/me/Downloads/shot.png" });
    const refetchInterval = options.refetchInterval;

    expect(typeof refetchInterval).toBe("function");
    if (typeof refetchInterval !== "function") {
      throw new Error("Expected refetchInterval to be a function.");
    }
    expect(
      refetchInterval({
        state: { data: { grant: "grant-token", expiresAt: "not-a-date" } },
      } as never),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
  });

  it("keeps directory HTML grants purpose-scoped and free of background polling", () => {
    const options = projectLocalHtmlPreviewGrantQueryOptions({
      path: "docs/demo.html",
      cwd: "/repo/worktree",
      purpose: "preview",
    });

    expect(options.queryKey).toEqual([
      "projects",
      "local-html-preview-grant",
      "docs/demo.html",
      "/repo/worktree",
      "preview",
    ]);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
  });
});
