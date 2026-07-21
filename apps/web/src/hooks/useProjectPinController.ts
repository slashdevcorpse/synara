// FILE: useProjectPinController.ts
// Purpose: Coordinates project pin mutations and server reconciliation across project surfaces.
// Layer: Shared web hook

import { MAX_PINNED_PROJECTS, type ProjectId } from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { usePinnedProjectsStore } from "../pinnedProjectsStore";
import type { Project } from "../types";
import { newCommandId } from "../lib/utils";

type ProjectPinRow = Pick<Project, "id" | "kind" | "isPinned" | "serverSequence">;
type ProjectPinApi = NonNullable<ReturnType<typeof readNativeApi>>;

const pumpingProjectIds = new Set<ProjectId>();

async function runProjectPinPump(projectId: ProjectId, api: ProjectPinApi): Promise<void> {
  try {
    while (true) {
      const mutation = usePinnedProjectsStore.getState().takeNextProjectPinMutation(projectId);
      if (!mutation) return;

      try {
        const result = await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          isPinned: mutation.isPinned,
        });
        usePinnedProjectsStore.getState().succeedProjectPinMutation({
          mutation,
          resultSequence: result.sequence,
        });
      } catch (error) {
        const shouldReportFailure = usePinnedProjectsStore
          .getState()
          .failProjectPinMutation(mutation);
        if (!shouldReportFailure) continue;
        console.error("Failed to update pinned project state", { projectId, error });
        toastManager.add({
          type: "error",
          title: mutation.isPinned ? "Unable to pin project" : "Unable to unpin project",
          description: error instanceof Error ? error.message : undefined,
        });
      }
    }
  } finally {
    pumpingProjectIds.delete(projectId);
  }
}

function pumpProjectPinCommands(projectId: ProjectId, api: ProjectPinApi): void {
  if (pumpingProjectIds.has(projectId)) return;
  pumpingProjectIds.add(projectId);
  void runProjectPinPump(projectId, api);
}

export function useProjectPinController(input: {
  readonly projects: readonly ProjectPinRow[];
  readonly shouldReconcile: boolean;
}) {
  const pinnedProjectIds = usePinnedProjectsStore((state) => state.pinnedProjectIds);
  const optimisticPinnedStateByProjectId = usePinnedProjectsStore(
    (state) => state.optimisticPinnedStateByProjectId,
  );
  const beginProjectPinMutation = usePinnedProjectsStore((state) => state.beginProjectPinMutation);
  const reconcileProjectPins = usePinnedProjectsStore((state) => state.reconcileProjectPins);
  const projectById = useMemo(
    () => new Map(input.projects.map((project) => [project.id, project] as const)),
    [input.projects],
  );
  const projectByIdRef = useRef<ReadonlyMap<ProjectId, ProjectPinRow>>(projectById);

  useLayoutEffect(() => {
    projectByIdRef.current = projectById;
  }, [projectById]);

  useEffect(() => {
    if (!input.shouldReconcile) return;
    reconcileProjectPins(input.projects);
  }, [input.projects, input.shouldReconcile, reconcileProjectPins]);

  const setProjectPinned = useCallback(
    (projectId: ProjectId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectByIdRef.current.get(projectId);
      if (!project || project.kind !== "project") return;

      const mutation = beginProjectPinMutation(projectId, isPinned, {
        id: projectId,
        isPinned: project.isPinned,
        serverSequence: project.serverSequence,
      });
      if (!mutation) {
        if (isPinned) {
          toastManager.add({
            type: "warning",
            title: "Project pin limit reached",
            description: `You can pin up to ${MAX_PINNED_PROJECTS} projects.`,
          });
        }
        return;
      }
      pumpProjectPinCommands(projectId, api);
    },
    [beginProjectPinMutation],
  );

  const toggleProjectPinned = useCallback(
    (projectId: ProjectId) => {
      const state = usePinnedProjectsStore.getState();
      const optimisticPinned = state.optimisticPinnedStateByProjectId.get(projectId);
      const locallyPinned = state.pinnedProjectIds.includes(projectId);
      const serverPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
      const isPinned = optimisticPinned ?? (locallyPinned || serverPinned);
      setProjectPinned(projectId, !isPinned);
    },
    [setProjectPinned],
  );

  return {
    optimisticPinnedStateByProjectId,
    pinnedProjectIds,
    toggleProjectPinned,
  };
}
