// FILE: pinnedProjectsStore.test.ts
// Purpose: Verifies the capped pinned-project store mutates ids predictably.
// Layer: UI state store test

import { beforeEach, describe, expect, it } from "vitest";
import { ProjectId } from "@synara/contracts";
import { usePinnedProjectsStore } from "./pinnedProjectsStore";

describe("usePinnedProjectsStore", () => {
  beforeEach(() => {
    usePinnedProjectsStore.setState({
      pinnedProjectIds: [],
      optimisticPinnedStateByProjectId: new Map(),
      latestPinnedMutationVersionByProjectId: new Map(),
      projectPinLifecycleByProjectId: new Map(),
      observedProjectPinStateByProjectId: new Map(),
    });
  });

  it("pins newest project ids first and rejects a fourth pin", () => {
    expect(usePinnedProjectsStore.getState().pinProject("project-1" as ProjectId)).toBe(true);
    expect(usePinnedProjectsStore.getState().pinProject("project-2" as ProjectId)).toBe(true);
    expect(usePinnedProjectsStore.getState().pinProject("project-3" as ProjectId)).toBe(true);
    expect(usePinnedProjectsStore.getState().pinProject("project-4" as ProjectId)).toBe(false);

    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([
      "project-3",
      "project-2",
      "project-1",
    ]);
  });

  it("unpins and prunes project ids that are no longer present", () => {
    usePinnedProjectsStore.setState({
      pinnedProjectIds: [
        "project-3" as ProjectId,
        "project-2" as ProjectId,
        "project-1" as ProjectId,
      ],
    });

    usePinnedProjectsStore.getState().unpinProject("project-2" as ProjectId);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual(["project-3", "project-1"]);

    usePinnedProjectsStore.getState().prunePinnedProjects(["project-1" as ProjectId]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual(["project-1"]);
  });

  it("preserves persisted order before appending server-only pins during reconciliation", () => {
    const p1 = "project-1" as ProjectId;
    const p2 = "project-2" as ProjectId;
    const p3 = "project-3" as ProjectId;
    const p4 = "project-4" as ProjectId;
    usePinnedProjectsStore.setState({
      pinnedProjectIds: [p3, p1],
      optimisticPinnedStateByProjectId: new Map([[p1, false]]),
    });

    usePinnedProjectsStore.getState().reconcileProjectPins([
      { id: p1, isPinned: true, serverSequence: 10 },
      { id: p2, isPinned: true, serverSequence: 10 },
      { id: p3, isPinned: true, serverSequence: 10 },
      { id: p4, isPinned: true, serverSequence: 10 },
    ]);

    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([p3, p2, p4]);
  });

  it("retains optimistic pin intent across stale server rows and settles after confirmation", () => {
    const projectId = "project-1" as ProjectId;
    const intent = usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 10,
    });
    const mutation = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);

    expect(intent).toMatchObject({ projectId, isPinned: true, requestVersion: 1 });
    expect(mutation).toEqual(intent);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([projectId]);

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 10 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([projectId]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, true]]),
    );

    expect(mutation).not.toBeNull();
    if (!mutation) return;
    usePinnedProjectsStore.getState().succeedProjectPinMutation({ mutation, resultSequence: 11 });
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 11 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([projectId]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
  });

  it("adopts a newer server observation before the latest pin command rejects", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 10,
    });
    const mutation = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    expect(mutation).not.toBeNull();
    if (!mutation) return;

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 11 }]);
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId.get(projectId)).toEqual(
      expect.objectContaining({
        appliedPinned: true,
        appliedSequence: 11,
        inFlightRequestVersion: 1,
        latestSettled: false,
      }),
    );
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, true]]),
    );

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 10 }]);
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId.get(projectId)).toEqual(
      expect.objectContaining({ appliedPinned: true, appliedSequence: 11 }),
    );

    expect(usePinnedProjectsStore.getState().failProjectPinMutation(mutation)).toBe(false);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([projectId]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId).toEqual(new Map());
    expect(
      usePinnedProjectsStore.getState().observedProjectPinStateByProjectId.get(projectId),
    ).toEqual({ id: projectId, isPinned: true, serverSequence: 11 });
  });

  it("dispatches a queued unpin after a newer observation and nonlatest pin failure", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 10,
    });
    const first = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, false, {
      id: projectId,
      isPinned: false,
      serverSequence: 10,
    });
    expect(first).not.toBeNull();
    if (!first) return;

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 11 }]);
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId.get(projectId)).toEqual(
      expect.objectContaining({
        appliedPinned: true,
        appliedSequence: 11,
        desiredPinned: false,
        inFlightRequestVersion: 1,
      }),
    );

    expect(usePinnedProjectsStore.getState().failProjectPinMutation(first)).toBe(false);
    const second = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    expect(second).toEqual({ projectId, isPinned: false, requestVersion: 2 });
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, false]]),
    );

    if (!second) return;
    usePinnedProjectsStore
      .getState()
      .succeedProjectPinMutation({ mutation: second, resultSequence: 12 });
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 12 }]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId).toEqual(new Map());
  });

  it("settles to a newer conflicting observation instead of replaying an older success", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 10,
    });
    const mutation = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    expect(mutation).not.toBeNull();
    if (!mutation) return;

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 12 }]);
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId.get(projectId)).toEqual(
      expect.objectContaining({
        appliedPinned: false,
        appliedSequence: 12,
        desiredPinned: true,
        inFlightRequestVersion: 1,
      }),
    );

    expect(
      usePinnedProjectsStore.getState().succeedProjectPinMutation({ mutation, resultSequence: 11 }),
    ).toBe(true);
    expect(usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId)).toBeNull();
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId).toEqual(new Map());
    expect(
      usePinnedProjectsStore.getState().observedProjectPinStateByProjectId.get(projectId),
    ).toEqual({ id: projectId, isPinned: false, serverSequence: 12 });
  });

  it("dispatches a newer queued intent after an older success loses to an observation", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 10,
    });
    const first = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, false, {
      id: projectId,
      isPinned: false,
      serverSequence: 10,
    });
    expect(first).not.toBeNull();
    if (!first) return;

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 12 }]);
    usePinnedProjectsStore
      .getState()
      .succeedProjectPinMutation({ mutation: first, resultSequence: 11 });

    const second = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    expect(second).toEqual({ projectId, isPinned: false, requestVersion: 2 });
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, false]]),
    );

    if (!second) return;
    usePinnedProjectsStore
      .getState()
      .succeedProjectPinMutation({ mutation: second, resultSequence: 13 });
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 13 }]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
    expect(usePinnedProjectsStore.getState().projectPinLifecycleByProjectId).toEqual(new Map());
  });

  it("retains optimistic unpin intent across stale server rows and settles after confirmation", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.setState({ pinnedProjectIds: [projectId] });
    const intent = usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, false, {
      id: projectId,
      isPinned: true,
      serverSequence: 20,
    });
    const mutation = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);

    expect(intent).toMatchObject({ projectId, isPinned: false, requestVersion: 1 });
    expect(mutation).toEqual(intent);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 20 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, false]]),
    );

    expect(mutation).not.toBeNull();
    if (!mutation) return;
    usePinnedProjectsStore.getState().succeedProjectPinMutation({ mutation, resultSequence: 21 });
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 21 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
  });

  it("does not settle a rapid unpin from a stale match or delayed pin confirmation", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 30,
    });
    const first = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, false, {
      id: projectId,
      isPinned: false,
      serverSequence: 30,
    });
    expect(first).not.toBeNull();
    if (!first) return;

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 30 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, false]]),
    );

    usePinnedProjectsStore
      .getState()
      .succeedProjectPinMutation({ mutation: first, resultSequence: 31 });
    const second = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    expect(second).toMatchObject({ projectId, isPinned: false, requestVersion: 2 });
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 31 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, false]]),
    );

    if (!second) return;
    usePinnedProjectsStore
      .getState()
      .succeedProjectPinMutation({ mutation: second, resultSequence: 32 });
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 32 }]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
  });

  it("rolls a failed rapid unpin back to the successful pin rather than a stale row", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 40,
    });
    const first = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, false, {
      id: projectId,
      isPinned: false,
      serverSequence: 40,
    });
    expect(first).not.toBeNull();
    if (!first) return;

    usePinnedProjectsStore
      .getState()
      .succeedProjectPinMutation({ mutation: first, resultSequence: 41 });
    const second = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    expect(second).not.toBeNull();
    if (!second) return;

    expect(usePinnedProjectsStore.getState().failProjectPinMutation(second)).toBe(true);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([projectId]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(
      new Map([[projectId, true]]),
    );

    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: false, serverSequence: 40 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([projectId]);
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 41 }]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
  });

  it("coalesces pin then unpin then pin into one successful command", () => {
    const projectId = "project-1" as ProjectId;
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 50,
    });
    const first = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, false, {
      id: projectId,
      isPinned: false,
      serverSequence: 50,
    });
    usePinnedProjectsStore.getState().beginProjectPinMutation(projectId, true, {
      id: projectId,
      isPinned: false,
      serverSequence: 50,
    });
    expect(first).not.toBeNull();
    if (!first) return;

    usePinnedProjectsStore
      .getState()
      .succeedProjectPinMutation({ mutation: first, resultSequence: 51 });

    expect(usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId)).toBeNull();
    usePinnedProjectsStore
      .getState()
      .reconcileProjectPins([{ id: projectId, isPinned: true, serverSequence: 51 }]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([projectId]);
    expect(usePinnedProjectsStore.getState().optimisticPinnedStateByProjectId).toEqual(new Map());
  });
});
