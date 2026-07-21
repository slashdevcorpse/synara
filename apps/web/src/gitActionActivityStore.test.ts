import type { GitActionProgressEvent } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  projectGitActionProgress,
  subscribeGitActionActivityProjection,
  useGitActionActivityStore,
} from "./gitActionActivityStore";

const CWD = "C:\\code\\synara";

function started(actionId: string, cwd = CWD): GitActionProgressEvent {
  return { kind: "action_started", actionId, cwd, action: "push", phases: ["push"] };
}

function failed(actionId: string, cwd = CWD): GitActionProgressEvent {
  return {
    kind: "action_failed",
    actionId,
    cwd,
    action: "push",
    phase: "push",
    message: "Push failed",
  };
}

function finished(actionId: string, cwd = CWD): GitActionProgressEvent {
  return {
    kind: "action_finished",
    actionId,
    cwd,
    action: "push",
    result: {
      action: "push",
      branch: { status: "skipped_not_requested" },
      commit: { status: "skipped_not_requested" },
      push: { status: "pushed" },
      pr: { status: "skipped_not_requested" },
    },
  };
}

describe("gitActionActivityStore", () => {
  beforeEach(() => {
    useGitActionActivityStore.setState({ activeActionIdsByCwd: new Map() });
  });

  it("marks action, phase, and hook progress active even if the start event was missed", () => {
    const events: GitActionProgressEvent[] = [
      started("action-started"),
      {
        kind: "phase_started",
        actionId: "action-phase",
        cwd: CWD,
        action: "commit",
        phase: "commit",
        label: "Committing...",
      },
      {
        kind: "hook_started",
        actionId: "action-hook",
        cwd: CWD,
        action: "commit",
        hookName: "pre-commit",
      },
      {
        kind: "hook_output",
        actionId: "action-output",
        cwd: CWD,
        action: "commit",
        hookName: "pre-commit",
        stream: "stdout",
        text: "Checking files",
      },
      {
        kind: "hook_finished",
        actionId: "action-hook-finished",
        cwd: CWD,
        action: "commit",
        hookName: "pre-commit",
        exitCode: 0,
        durationMs: 100,
      },
    ];

    for (const event of events) useGitActionActivityStore.getState().applyProgressEvent(event);

    expect([...useGitActionActivityStore.getState().activeActionIdsByCwd.get(CWD)!]).toEqual([
      "action-started",
      "action-phase",
      "action-hook",
      "action-output",
      "action-hook-finished",
    ]);
  });

  it("clears only the exact settled action while concurrent actions remain active", () => {
    const apply = useGitActionActivityStore.getState().applyProgressEvent;
    apply(started("action-a"));
    apply(started("action-b"));
    apply(finished("action-a"));

    expect([...useGitActionActivityStore.getState().activeActionIdsByCwd.get(CWD)!]).toEqual([
      "action-b",
    ]);

    apply(failed("action-b"));
    expect(useGitActionActivityStore.getState().activeActionIdsByCwd.has(CWD)).toBe(false);
  });

  it("keeps identical action ids isolated by cwd", () => {
    const apply = useGitActionActivityStore.getState().applyProgressEvent;
    apply(started("shared-action", "C:\\code\\one"));
    apply(started("shared-action", "C:\\code\\two"));
    apply(failed("shared-action", "C:\\code\\one"));

    const projection = useGitActionActivityStore.getState().activeActionIdsByCwd;
    expect(projection.has("C:\\code\\one")).toBe(false);
    expect(projection.get("C:\\code\\two")).toEqual(new Set(["shared-action"]));
  });

  it("reuses the projection for duplicate progress and unknown terminal events", () => {
    const first = projectGitActionProgress(new Map(), started("action-a"));
    expect(projectGitActionProgress(first, started("action-a"))).toBe(first);
    expect(projectGitActionProgress(first, failed("unknown"))).toBe(first);
  });

  it("keeps projecting terminal events through the global subscription lifecycle", () => {
    let listener: ((event: GitActionProgressEvent) => void) | null = null;
    let transportListener: ((state: "connecting" | "open" | "closed") => void) | null = null;
    let welcomeListener: (() => void) | null = null;
    const unsubscribeProgress = vi.fn();
    const unsubscribeTransport = vi.fn();
    const unsubscribeWelcome = vi.fn();
    const stopProjection = subscribeGitActionActivityProjection({
      gitApi: {
        onActionProgress: (nextListener) => {
          listener = nextListener;
          return unsubscribeProgress;
        },
      },
      addTransportStateListener: (nextListener) => {
        transportListener = nextListener;
        return unsubscribeTransport;
      },
      onServerWelcome: (nextListener) => {
        welcomeListener = nextListener;
        return unsubscribeWelcome;
      },
    });

    listener?.(started("action-a"));
    expect(useGitActionActivityStore.getState().activeActionIdsByCwd.get(CWD)).toEqual(
      new Set(["action-a"]),
    );

    // The root subscription remains mounted while route-local controls can unmount.
    listener?.(finished("action-a"));
    expect(useGitActionActivityStore.getState().activeActionIdsByCwd.has(CWD)).toBe(false);

    listener?.(started("action-interrupted"));
    transportListener?.("connecting");
    expect(useGitActionActivityStore.getState().activeActionIdsByCwd.size).toBe(0);

    listener?.(started("action-before-welcome"));
    welcomeListener?.();
    expect(useGitActionActivityStore.getState().activeActionIdsByCwd.size).toBe(0);

    stopProjection();
    expect(unsubscribeProgress).toHaveBeenCalledOnce();
    expect(unsubscribeTransport).toHaveBeenCalledOnce();
    expect(unsubscribeWelcome).toHaveBeenCalledOnce();
  });
});
