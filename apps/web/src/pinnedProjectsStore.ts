// FILE: pinnedProjectsStore.ts
// Purpose: Persists project pin ids and coordinates optimistic pin mutations across surfaces.
// Layer: UI state store
// Exports: usePinnedProjectsStore

import { MAX_PINNED_PROJECTS, type ProjectId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  beginPinMutationLifecycle,
  canSettlePinMutationLifecycle,
  derivePinnedIds,
  failPinMutationLifecycle,
  normalizePinnedIds,
  observePinMutationLifecycle,
  pinId,
  prunePinnedIds,
  startPinMutationLifecycle,
  succeedPinMutationLifecycle,
  type PinMutationLifecycle,
  unpinId,
} from "./pinning.logic";

export interface ProjectPinMutation {
  readonly projectId: ProjectId;
  readonly isPinned: boolean;
  readonly requestVersion: number;
}

export interface ProjectPinServerState {
  readonly id: ProjectId;
  readonly isPinned?: boolean | undefined;
  readonly serverSequence?: number | undefined;
}

interface PinnedProjectsStoreState {
  pinnedProjectIds: ProjectId[];
  optimisticPinnedStateByProjectId: ReadonlyMap<ProjectId, boolean>;
  latestPinnedMutationVersionByProjectId: ReadonlyMap<ProjectId, number>;
  projectPinLifecycleByProjectId: ReadonlyMap<ProjectId, PinMutationLifecycle>;
  observedProjectPinStateByProjectId: ReadonlyMap<ProjectId, ProjectPinServerState>;
  pinProject: (projectId: ProjectId) => boolean;
  unpinProject: (projectId: ProjectId) => void;
  prunePinnedProjects: (projectIds: readonly ProjectId[]) => void;
  beginProjectPinMutation: (
    projectId: ProjectId,
    isPinned: boolean,
    serverState: ProjectPinServerState,
  ) => ProjectPinMutation | null;
  takeNextProjectPinMutation: (projectId: ProjectId) => ProjectPinMutation | null;
  succeedProjectPinMutation: (input: {
    readonly mutation: ProjectPinMutation;
    readonly resultSequence: number;
  }) => boolean;
  failProjectPinMutation: (mutation: ProjectPinMutation) => boolean;
  reconcileProjectPins: (projects: readonly ProjectPinServerState[]) => void;
}

const PINNED_PROJECTS_STORAGE_KEY = "synara:pinned-projects:v1";
const PINNED_PROJECTS_OPTIONS = { maxCount: MAX_PINNED_PROJECTS } as const;

function samePinnedProjectIds(left: readonly ProjectId[], right: readonly ProjectId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function applyPinnedProjectState(
  pinnedProjectIds: readonly ProjectId[],
  projectId: ProjectId,
  isPinned: boolean,
): ProjectId[] {
  if (!isPinned) {
    return unpinId(pinnedProjectIds, projectId).pinnedIds;
  }
  const result = pinId(pinnedProjectIds, projectId, PINNED_PROJECTS_OPTIONS);
  return result.rejected ? [...pinnedProjectIds] : result.pinnedIds;
}

function sameProjectPinServerState(
  left: ProjectPinServerState | undefined,
  right: ProjectPinServerState,
): boolean {
  return (
    left?.id === right.id &&
    (left.isPinned === true) === (right.isPinned === true) &&
    left.serverSequence === right.serverSequence
  );
}

function acceptProjectPinServerState(
  current: ProjectPinServerState | undefined,
  incoming: ProjectPinServerState,
): ProjectPinServerState {
  if (
    current?.serverSequence !== undefined &&
    (incoming.serverSequence === undefined || incoming.serverSequence < current.serverSequence)
  ) {
    return current;
  }
  return {
    id: incoming.id,
    isPinned: incoming.isPinned === true,
    ...(incoming.serverSequence === undefined ? {} : { serverSequence: incoming.serverSequence }),
  };
}

function isProjectPinLifecycleSettled(
  lifecycle: PinMutationLifecycle,
  serverState: ProjectPinServerState | undefined,
): boolean {
  return (
    serverState !== undefined &&
    canSettlePinMutationLifecycle({
      lifecycle,
      serverPinned: serverState.isPinned === true,
      serverSequence: serverState.serverSequence,
    })
  );
}

interface MutableProjectPinMaps {
  lifecycle: Map<ProjectId, PinMutationLifecycle>;
  optimistic: Map<ProjectId, boolean>;
}

function settleProjectPinLifecycleIfConfirmed(input: {
  readonly projectId: ProjectId;
  readonly lifecycle: PinMutationLifecycle;
  readonly serverState: ProjectPinServerState | undefined;
  readonly maps: MutableProjectPinMaps;
}): boolean {
  if (!isProjectPinLifecycleSettled(input.lifecycle, input.serverState)) {
    input.maps.lifecycle.set(input.projectId, input.lifecycle);
    input.maps.optimistic.set(input.projectId, input.lifecycle.desiredPinned);
    return false;
  }
  input.maps.lifecycle.delete(input.projectId);
  input.maps.optimistic.delete(input.projectId);
  return true;
}

export const usePinnedProjectsStore = create<PinnedProjectsStoreState>()(
  persist(
    (set, get) => ({
      pinnedProjectIds: [],
      optimisticPinnedStateByProjectId: new Map(),
      latestPinnedMutationVersionByProjectId: new Map(),
      projectPinLifecycleByProjectId: new Map(),
      observedProjectPinStateByProjectId: new Map(),
      pinProject: (projectId) => {
        if (projectId.length === 0) return false;
        const result = pinId(get().pinnedProjectIds, projectId, PINNED_PROJECTS_OPTIONS);
        if (result.rejected) {
          return false;
        }
        if (result.changed) {
          set({ pinnedProjectIds: result.pinnedIds });
        }
        return true;
      },
      unpinProject: (projectId) => {
        if (projectId.length === 0) return;
        set((state) => {
          const result = unpinId(state.pinnedProjectIds, projectId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedProjectIds: result.pinnedIds,
          };
        });
      },
      prunePinnedProjects: (projectIds) => {
        set((state) => {
          const nextPinnedProjectIds = prunePinnedIds(state.pinnedProjectIds, projectIds).slice(
            0,
            MAX_PINNED_PROJECTS,
          );
          return nextPinnedProjectIds.length === state.pinnedProjectIds.length &&
            nextPinnedProjectIds.every((id, index) => id === state.pinnedProjectIds[index])
            ? state
            : { pinnedProjectIds: nextPinnedProjectIds };
        });
      },
      beginProjectPinMutation: (projectId, isPinned, serverState) => {
        if (projectId.length === 0) return null;
        const state = get();
        const pinResult = isPinned
          ? pinId(state.pinnedProjectIds, projectId, PINNED_PROJECTS_OPTIONS)
          : unpinId(state.pinnedProjectIds, projectId);
        if (pinResult.rejected) return null;

        const requestVersion =
          (state.latestPinnedMutationVersionByProjectId.get(projectId) ?? 0) + 1;
        const optimisticPinnedStateByProjectId = new Map(state.optimisticPinnedStateByProjectId);
        optimisticPinnedStateByProjectId.set(projectId, isPinned);
        const latestPinnedMutationVersionByProjectId = new Map(
          state.latestPinnedMutationVersionByProjectId,
        );
        latestPinnedMutationVersionByProjectId.set(projectId, requestVersion);
        const observedProjectPinStateByProjectId = new Map(
          state.observedProjectPinStateByProjectId,
        );
        const acceptedServerState = acceptProjectPinServerState(
          observedProjectPinStateByProjectId.get(projectId),
          serverState,
        );
        observedProjectPinStateByProjectId.set(projectId, acceptedServerState);
        const lifecycle = beginPinMutationLifecycle({
          lifecycle: state.projectPinLifecycleByProjectId.get(projectId),
          requestVersion,
          desiredPinned: isPinned,
          serverPinned: acceptedServerState.isPinned === true,
          serverSequence: acceptedServerState.serverSequence,
        });
        const maps: MutableProjectPinMaps = {
          lifecycle: new Map(state.projectPinLifecycleByProjectId),
          optimistic: optimisticPinnedStateByProjectId,
        };
        settleProjectPinLifecycleIfConfirmed({
          projectId,
          lifecycle,
          serverState: acceptedServerState,
          maps,
        });
        set({
          pinnedProjectIds: pinResult.pinnedIds,
          optimisticPinnedStateByProjectId: maps.optimistic,
          latestPinnedMutationVersionByProjectId,
          projectPinLifecycleByProjectId: maps.lifecycle,
          observedProjectPinStateByProjectId,
        });
        return { projectId, isPinned, requestVersion };
      },
      takeNextProjectPinMutation: (projectId) => {
        const state = get();
        const lifecycle = state.projectPinLifecycleByProjectId.get(projectId);
        if (!lifecycle) return null;
        const started = startPinMutationLifecycle(lifecycle);
        if (!started) return null;
        const projectPinLifecycleByProjectId = new Map(state.projectPinLifecycleByProjectId);
        projectPinLifecycleByProjectId.set(projectId, started.lifecycle);
        set({ projectPinLifecycleByProjectId });
        return {
          projectId,
          isPinned: started.isPinned,
          requestVersion: started.requestVersion,
        };
      },
      succeedProjectPinMutation: ({ mutation, resultSequence }) => {
        const state = get();
        const lifecycle = state.projectPinLifecycleByProjectId.get(mutation.projectId);
        if (!lifecycle) return false;
        const succeeded = succeedPinMutationLifecycle({
          lifecycle,
          requestVersion: mutation.requestVersion,
          isPinned: mutation.isPinned,
          resultSequence,
        });
        if (!succeeded) return false;

        const maps: MutableProjectPinMaps = {
          lifecycle: new Map(state.projectPinLifecycleByProjectId),
          optimistic: new Map(state.optimisticPinnedStateByProjectId),
        };
        const settled = settleProjectPinLifecycleIfConfirmed({
          projectId: mutation.projectId,
          lifecycle: succeeded,
          serverState: state.observedProjectPinStateByProjectId.get(mutation.projectId),
          maps,
        });
        set({
          pinnedProjectIds: settled
            ? applyPinnedProjectState(
                state.pinnedProjectIds,
                mutation.projectId,
                succeeded.desiredPinned,
              )
            : state.pinnedProjectIds,
          projectPinLifecycleByProjectId: maps.lifecycle,
          optimisticPinnedStateByProjectId: maps.optimistic,
        });
        return true;
      },
      failProjectPinMutation: (mutation) => {
        const state = get();
        const lifecycle = state.projectPinLifecycleByProjectId.get(mutation.projectId);
        if (!lifecycle) return false;
        const failed = failPinMutationLifecycle({
          lifecycle,
          requestVersion: mutation.requestVersion,
        });
        if (!failed) return false;
        const shouldReportFailure =
          failed.isLatestFailure && failed.lifecycle.appliedPinned !== mutation.isPinned;

        const maps: MutableProjectPinMaps = {
          lifecycle: new Map(state.projectPinLifecycleByProjectId),
          optimistic: new Map(state.optimisticPinnedStateByProjectId),
        };
        settleProjectPinLifecycleIfConfirmed({
          projectId: mutation.projectId,
          lifecycle: failed.lifecycle,
          serverState: state.observedProjectPinStateByProjectId.get(mutation.projectId),
          maps,
        });
        set({
          pinnedProjectIds: failed.isLatestFailure
            ? applyPinnedProjectState(
                state.pinnedProjectIds,
                mutation.projectId,
                failed.lifecycle.desiredPinned,
              )
            : state.pinnedProjectIds,
          projectPinLifecycleByProjectId: maps.lifecycle,
          optimisticPinnedStateByProjectId: maps.optimistic,
        });
        return shouldReportFailure;
      },
      reconcileProjectPins: (projects) => {
        set((state) => {
          const projectIds = projects.map((project) => project.id);
          const projectIdSet = new Set(projectIds);
          const observedProjectPinStateByProjectId = new Map(
            state.observedProjectPinStateByProjectId,
          );
          const projectPinLifecycleByProjectId = new Map(state.projectPinLifecycleByProjectId);
          const optimisticPinnedStateByProjectId = new Map(state.optimisticPinnedStateByProjectId);
          const latestPinnedMutationVersionByProjectId = new Map(
            state.latestPinnedMutationVersionByProjectId,
          );
          let observedStateChanged = false;
          let lifecycleStateChanged = false;

          for (const project of projects) {
            const currentServerState = observedProjectPinStateByProjectId.get(project.id);
            const acceptedServerState = acceptProjectPinServerState(currentServerState, project);
            if (!sameProjectPinServerState(currentServerState, acceptedServerState)) {
              observedProjectPinStateByProjectId.set(project.id, acceptedServerState);
              observedStateChanged = true;
            }
            const lifecycle = projectPinLifecycleByProjectId.get(project.id);
            if (lifecycle) {
              const observedLifecycle = observePinMutationLifecycle({
                lifecycle,
                serverPinned: acceptedServerState.isPinned === true,
                serverSequence: acceptedServerState.serverSequence,
              });
              if (observedLifecycle !== lifecycle) {
                projectPinLifecycleByProjectId.set(project.id, observedLifecycle);
                lifecycleStateChanged = true;
              }
              if (isProjectPinLifecycleSettled(observedLifecycle, acceptedServerState)) {
                projectPinLifecycleByProjectId.delete(project.id);
                optimisticPinnedStateByProjectId.delete(project.id);
                lifecycleStateChanged = true;
              }
            }
          }

          for (const projectId of observedProjectPinStateByProjectId.keys()) {
            if (projectIdSet.has(projectId)) continue;
            observedProjectPinStateByProjectId.delete(projectId);
            projectPinLifecycleByProjectId.delete(projectId);
            optimisticPinnedStateByProjectId.delete(projectId);
            latestPinnedMutationVersionByProjectId.delete(projectId);
            observedStateChanged = true;
            lifecycleStateChanged = true;
          }

          const effectiveProjects = projects.map((project) => {
            const observed = observedProjectPinStateByProjectId.get(project.id);
            return observed ? { ...project, isPinned: observed.isPinned === true } : project;
          });
          const pinnedProjectIds = derivePinnedIds({
            items: effectiveProjects,
            persistedPinnedIds: state.pinnedProjectIds,
            optimisticPinnedStateById: optimisticPinnedStateByProjectId,
            maxCount: MAX_PINNED_PROJECTS,
          });
          const pinnedIdsChanged = !samePinnedProjectIds(pinnedProjectIds, state.pinnedProjectIds);
          if (!pinnedIdsChanged && !observedStateChanged && !lifecycleStateChanged) {
            return state;
          }
          return {
            ...state,
            pinnedProjectIds,
            optimisticPinnedStateByProjectId,
            latestPinnedMutationVersionByProjectId,
            projectPinLifecycleByProjectId,
            observedProjectPinStateByProjectId,
          };
        });
      },
    }),
    {
      name: PINNED_PROJECTS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        pinnedProjectIds: normalizePinnedIds(state.pinnedProjectIds, PINNED_PROJECTS_OPTIONS),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (
            persistedState as
              | Partial<Pick<PinnedProjectsStoreState, "pinnedProjectIds">>
              | undefined
          )?.pinnedProjectIds ?? [];
        return {
          ...currentState,
          pinnedProjectIds: normalizePinnedIds(candidate, PINNED_PROJECTS_OPTIONS),
        };
      },
    },
  ),
);
