// FILE: pinning.logic.test.ts
// Purpose: Verifies shared sidebar pin normalization, limits, and ordering.
// Layer: UI state logic test

import { describe, expect, it } from "vitest";
import {
  beginPinMutationLifecycle,
  canSettlePinMutationLifecycle,
  derivePinnedIds,
  failPinMutationLifecycle,
  observePinMutationLifecycle,
  orderPinnedItemsFirst,
  pinId,
  prunePinnedIds,
  reconcileOptimisticPinState,
  startPinMutationLifecycle,
  succeedPinMutationLifecycle,
} from "./pinning.logic";

describe("pinning.logic", () => {
  it("pins newest ids first and rejects ids beyond the configured cap", () => {
    const existing = ["project-3", "project-2", "project-1"];

    expect(pinId(existing, "project-4", { maxCount: 3 })).toEqual({
      pinnedIds: existing,
      changed: false,
      rejected: true,
    });
    expect(pinId(existing, "project-2", { maxCount: 3 })).toEqual({
      pinnedIds: existing,
      changed: false,
      rejected: false,
    });
    expect(pinId(["project-2"], "project-1", { maxCount: 3 }).pinnedIds).toEqual([
      "project-1",
      "project-2",
    ]);
  });

  it("derives pinned ids from persisted order, server pins, and optimistic overrides", () => {
    const items = [
      { id: "project-1", isPinned: true },
      { id: "project-2", isPinned: true },
      { id: "project-3", isPinned: false },
      { id: "project-4", isPinned: true },
    ];

    expect(
      derivePinnedIds({
        items,
        persistedPinnedIds: ["project-3", "project-missing"],
        optimisticPinnedStateById: new Map([
          ["project-1", false],
          ["project-3", true],
        ]),
        maxCount: 3,
      }),
    ).toEqual(["project-3", "project-2", "project-4"]);
  });

  it("orders pinned items first without changing unpinned item order", () => {
    const items: Array<{ id: string }> = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

    expect(
      orderPinnedItemsFirst<string, { id: string }>(items, ["c", "a"]).map((item) => item.id),
    ).toEqual(["c", "a", "b", "d"]);
  });

  it("prunes missing ids and removes duplicates", () => {
    expect(prunePinnedIds(["a", "b", "a", "c"], ["c", "a"])).toEqual(["a", "c"]);
  });

  it("settles confirmed and missing optimistic pins while retaining server disagreements", () => {
    const pending = new Map([
      ["confirmed", true],
      ["disagrees", true],
      ["missing", false],
    ]);

    const result = reconcileOptimisticPinState({
      optimisticPinnedStateById: pending,
      serverPinnedStateById: new Map([
        ["confirmed", true],
        ["disagrees", false],
      ]),
    });

    expect(result.optimisticPinnedStateById).toEqual(new Map([["disagrees", true]]));
    expect(result.settledIds).toEqual(["confirmed", "missing"]);
  });

  it("preserves map identity while no optimistic pin has settled", () => {
    const pending = new Map([["thread", true]]);

    const result = reconcileOptimisticPinState({
      optimisticPinnedStateById: pending,
      serverPinnedStateById: new Map([["thread", false]]),
    });

    expect(result.optimisticPinnedStateById).toBe(pending);
    expect(result.settledIds).toEqual([]);
  });

  it("sequence-fences rapid pin then unpin through stale and coalesced server rows", () => {
    let lifecycle = beginPinMutationLifecycle({
      lifecycle: undefined,
      requestVersion: 1,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 10,
    });
    const first = startPinMutationLifecycle(lifecycle);
    expect(first).not.toBeNull();
    if (!first) return;
    lifecycle = first.lifecycle;
    lifecycle = beginPinMutationLifecycle({
      lifecycle,
      requestVersion: 2,
      desiredPinned: false,
      serverPinned: false,
      serverSequence: 10,
    });

    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: false,
        serverSequence: 10,
      }),
    ).toBe(false);

    lifecycle = succeedPinMutationLifecycle({
      lifecycle,
      requestVersion: first.requestVersion,
      isPinned: first.isPinned,
      resultSequence: 11,
    })!;
    const second = startPinMutationLifecycle(lifecycle);
    expect(second).not.toBeNull();
    if (!second) return;
    lifecycle = second.lifecycle;

    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: false,
        serverSequence: 10,
      }),
    ).toBe(false);
    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: true,
        serverSequence: 11,
      }),
    ).toBe(false);

    lifecycle = succeedPinMutationLifecycle({
      lifecycle,
      requestVersion: second.requestVersion,
      isPinned: second.isPinned,
      resultSequence: 12,
    })!;

    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: true,
        serverSequence: 11,
      }),
    ).toBe(false);
    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: false,
        serverSequence: 12,
      }),
    ).toBe(true);
  });

  it("rolls a failed latest command back to the prior successful effective state", () => {
    let lifecycle = beginPinMutationLifecycle({
      lifecycle: undefined,
      requestVersion: 1,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 20,
    });
    const first = startPinMutationLifecycle(lifecycle);
    expect(first).not.toBeNull();
    if (!first) return;
    lifecycle = first.lifecycle;
    lifecycle = beginPinMutationLifecycle({
      lifecycle,
      requestVersion: 2,
      desiredPinned: false,
      serverPinned: false,
      serverSequence: 20,
    });
    lifecycle = succeedPinMutationLifecycle({
      lifecycle,
      requestVersion: first.requestVersion,
      isPinned: first.isPinned,
      resultSequence: 21,
    })!;
    const second = startPinMutationLifecycle(lifecycle);
    expect(second).not.toBeNull();
    if (!second) return;
    lifecycle = second.lifecycle;

    const failed = failPinMutationLifecycle({
      lifecycle,
      requestVersion: second.requestVersion,
    });
    expect(failed).not.toBeNull();
    if (!failed) return;

    expect(failed.isLatestFailure).toBe(true);
    expect(failed.lifecycle.desiredPinned).toBe(true);
    expect(failed.lifecycle.settlementSequence).toBe(21);
    expect(
      canSettlePinMutationLifecycle({
        lifecycle: failed.lifecycle,
        serverPinned: false,
        serverSequence: 20,
      }),
    ).toBe(false);
    expect(
      canSettlePinMutationLifecycle({
        lifecycle: failed.lifecycle,
        serverPinned: true,
        serverSequence: 21,
      }),
    ).toBe(true);
  });

  it("settles an idle resolved lifecycle to a newer authoritative observation", () => {
    let lifecycle = beginPinMutationLifecycle({
      lifecycle: undefined,
      requestVersion: 1,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 20,
    });
    const mutation = startPinMutationLifecycle(lifecycle);
    expect(mutation).not.toBeNull();
    if (!mutation) return;
    lifecycle = succeedPinMutationLifecycle({
      lifecycle: mutation.lifecycle,
      requestVersion: mutation.requestVersion,
      isPinned: mutation.isPinned,
      resultSequence: 21,
    })!;

    lifecycle = observePinMutationLifecycle({
      lifecycle,
      serverPinned: false,
      serverSequence: 22,
    });

    expect(lifecycle).toEqual(
      expect.objectContaining({
        appliedPinned: false,
        appliedSequence: 22,
        desiredPinned: false,
        latestSettled: true,
        settlementSequence: 22,
      }),
    );
    expect(startPinMutationLifecycle(lifecycle)).toBeNull();
    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: false,
        serverSequence: 22,
      }),
    ).toBe(true);
  });

  it("settles to a newer conflicting observation when an older success arrives", () => {
    let lifecycle = beginPinMutationLifecycle({
      lifecycle: undefined,
      requestVersion: 1,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 10,
    });
    const mutation = startPinMutationLifecycle(lifecycle);
    expect(mutation).not.toBeNull();
    if (!mutation) return;

    lifecycle = observePinMutationLifecycle({
      lifecycle: mutation.lifecycle,
      serverPinned: false,
      serverSequence: 12,
    });
    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: false,
        serverSequence: 12,
      }),
    ).toBe(false);

    lifecycle = succeedPinMutationLifecycle({
      lifecycle,
      requestVersion: mutation.requestVersion,
      isPinned: mutation.isPinned,
      resultSequence: 11,
    })!;

    expect(lifecycle).toEqual(
      expect.objectContaining({
        appliedPinned: false,
        appliedSequence: 12,
        desiredPinned: false,
        inFlightRequestVersion: null,
        latestSettled: true,
        settlementSequence: 12,
      }),
    );
    expect(startPinMutationLifecycle(lifecycle)).toBeNull();
    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: false,
        serverSequence: 12,
      }),
    ).toBe(true);
  });

  it("settles when a successful result matches an observation at the same sequence", () => {
    let lifecycle = beginPinMutationLifecycle({
      lifecycle: undefined,
      requestVersion: 1,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 10,
    });
    const mutation = startPinMutationLifecycle(lifecycle);
    expect(mutation).not.toBeNull();
    if (!mutation) return;
    lifecycle = observePinMutationLifecycle({
      lifecycle: mutation.lifecycle,
      serverPinned: true,
      serverSequence: 11,
    });

    lifecycle = succeedPinMutationLifecycle({
      lifecycle,
      requestVersion: mutation.requestVersion,
      isPinned: mutation.isPinned,
      resultSequence: 11,
    })!;

    expect(lifecycle).toEqual(
      expect.objectContaining({
        appliedPinned: true,
        appliedSequence: 11,
        desiredPinned: true,
        latestSettled: true,
        settlementSequence: 11,
      }),
    );
    expect(startPinMutationLifecycle(lifecycle)).toBeNull();
  });

  it("preserves a newer queued intent when an older success loses to an observation", () => {
    let lifecycle = beginPinMutationLifecycle({
      lifecycle: undefined,
      requestVersion: 1,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 10,
    });
    const first = startPinMutationLifecycle(lifecycle);
    expect(first).not.toBeNull();
    if (!first) return;
    lifecycle = beginPinMutationLifecycle({
      lifecycle: first.lifecycle,
      requestVersion: 2,
      desiredPinned: false,
      serverPinned: false,
      serverSequence: 10,
    });
    lifecycle = observePinMutationLifecycle({
      lifecycle,
      serverPinned: true,
      serverSequence: 12,
    });

    lifecycle = succeedPinMutationLifecycle({
      lifecycle,
      requestVersion: first.requestVersion,
      isPinned: first.isPinned,
      resultSequence: 11,
    })!;

    expect(lifecycle).toEqual(
      expect.objectContaining({
        appliedPinned: true,
        appliedSequence: 12,
        desiredPinned: false,
        latestRequestVersion: 2,
        latestSettled: false,
      }),
    );
    expect(startPinMutationLifecycle(lifecycle)).toEqual(
      expect.objectContaining({ requestVersion: 2, isPinned: false }),
    );
  });

  it("coalesces pin then unpin then pin to the latest desired state", () => {
    let lifecycle = beginPinMutationLifecycle({
      lifecycle: undefined,
      requestVersion: 1,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 30,
    });
    const first = startPinMutationLifecycle(lifecycle);
    expect(first).not.toBeNull();
    if (!first) return;
    lifecycle = first.lifecycle;
    lifecycle = beginPinMutationLifecycle({
      lifecycle,
      requestVersion: 2,
      desiredPinned: false,
      serverPinned: false,
      serverSequence: 30,
    });
    lifecycle = beginPinMutationLifecycle({
      lifecycle,
      requestVersion: 3,
      desiredPinned: true,
      serverPinned: false,
      serverSequence: 30,
    });

    lifecycle = succeedPinMutationLifecycle({
      lifecycle,
      requestVersion: first.requestVersion,
      isPinned: first.isPinned,
      resultSequence: 31,
    })!;

    expect(lifecycle.desiredPinned).toBe(true);
    expect(lifecycle.latestRequestVersion).toBe(3);
    expect(lifecycle.latestSettled).toBe(true);
    expect(lifecycle.settlementSequence).toBe(31);
    expect(startPinMutationLifecycle(lifecycle)).toBeNull();
    expect(
      canSettlePinMutationLifecycle({
        lifecycle,
        serverPinned: true,
        serverSequence: 31,
      }),
    ).toBe(true);
  });
});
