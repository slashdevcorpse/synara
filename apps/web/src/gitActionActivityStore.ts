// FILE: gitActionActivityStore.ts
// Purpose: Project live Git action progress into shared client state keyed by cwd and action id.
// Layer: Web UI state

import type { GitActionProgressEvent, NativeApi } from "@synara/contracts";
import { create } from "zustand";

export type ActiveGitActionsByCwd = ReadonlyMap<string, ReadonlySet<string>>;

interface GitActionActivityStoreState {
  activeActionIdsByCwd: ActiveGitActionsByCwd;
  applyProgressEvent: (event: GitActionProgressEvent) => void;
  reset: () => void;
}

function isTerminalProgressEvent(event: GitActionProgressEvent): boolean {
  return event.kind === "action_finished" || event.kind === "action_failed";
}

export function projectGitActionProgress(
  current: ActiveGitActionsByCwd,
  event: GitActionProgressEvent,
): ActiveGitActionsByCwd {
  const currentActionIds = current.get(event.cwd);
  if (isTerminalProgressEvent(event)) {
    if (!currentActionIds?.has(event.actionId)) return current;

    const next = new Map(current);
    if (currentActionIds.size === 1) {
      next.delete(event.cwd);
    } else {
      const nextActionIds = new Set(currentActionIds);
      nextActionIds.delete(event.actionId);
      next.set(event.cwd, nextActionIds);
    }
    return next;
  }

  if (currentActionIds?.has(event.actionId)) return current;
  const next = new Map(current);
  next.set(event.cwd, new Set([...(currentActionIds ?? []), event.actionId]));
  return next;
}

export const useGitActionActivityStore = create<GitActionActivityStoreState>((set) => ({
  activeActionIdsByCwd: new Map(),
  applyProgressEvent: (event) =>
    set((state) => {
      const activeActionIdsByCwd = projectGitActionProgress(state.activeActionIdsByCwd, event);
      return activeActionIdsByCwd === state.activeActionIdsByCwd
        ? state
        : { activeActionIdsByCwd };
    }),
  reset: () => set({ activeActionIdsByCwd: new Map() }),
}));

export interface GitActionActivityProjectionDependencies {
  gitApi: Pick<NativeApi["git"], "onActionProgress">;
  addTransportStateListener: (
    listener: (state: "connecting" | "open" | "closed" | "incompatible" | "disposed") => void,
  ) => () => void;
  onServerWelcome: (listener: () => void) => () => void;
}

export function subscribeGitActionActivityProjection(
  dependencies: GitActionActivityProjectionDependencies,
): () => void {
  const reset = () => useGitActionActivityStore.getState().reset();
  const unsubscribeProgress = dependencies.gitApi.onActionProgress((event) => {
    useGitActionActivityStore.getState().applyProgressEvent(event);
  });
  const unsubscribeTransport = dependencies.addTransportStateListener((state) => {
    if (state !== "open") reset();
  });
  const unsubscribeWelcome = dependencies.onServerWelcome(reset);
  return () => {
    unsubscribeProgress();
    unsubscribeTransport();
    unsubscribeWelcome();
  };
}
