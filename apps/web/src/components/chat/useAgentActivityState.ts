// FILE: useAgentActivityState.ts
// Purpose: Present activity phases with flicker control and one-shot terminal transitions.
// Layer: Chat presentation hook
// Exports: useAgentActivityState and timing constants

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  deriveAgentActivityState,
  IDLE_AGENT_ACTIVITY_STATE,
  isLiveAgentActivityPhase,
  isTerminalAgentActivityPhase,
  type AgentActivityInput,
  type AgentActivityState,
} from "./agentActivityPulse.logic";

export const AGENT_ACTIVITY_MIN_PHASE_DWELL_MS = 100;
export const AGENT_ACTIVITY_TERMINAL_DISPLAY_MS = 440;

interface ObservedLiveTurn {
  threadId: string;
  turnKey: string | null;
}

function initialDisplayState(target: AgentActivityState): AgentActivityState {
  return isTerminalAgentActivityPhase(target.phase) ? IDLE_AGENT_ACTIVITY_STATE : target;
}

function activityStatesEqual(left: AgentActivityState, right: AgentActivityState): boolean {
  return (
    left.phase === right.phase &&
    left.toolCount === right.toolCount &&
    left.subagentCount === right.subagentCount &&
    left.lastEventTimestamp === right.lastEventTimestamp &&
    left.turnKey === right.turnKey
  );
}

/**
 * Adds presentation memory to the pure projection: old terminal turns never
 * replay on mount, active phase churn has a short minimum dwell, and terminal
 * states appear once for a turn before successful/failed work dissolves.
 */
export function useAgentActivityState(input: AgentActivityInput): AgentActivityState {
  const target = useMemo(
    () => deriveAgentActivityState(input),
    [
      input.activities,
      input.hasMessages,
      input.hasPendingApproval,
      input.hasPendingUserInput,
      input.latestTurn,
      input.localDispatchPending,
      input.messages,
      input.session,
      input.threadError,
      input.threadId,
    ],
  );
  const [displayState, setDisplayState] = useState<AgentActivityState>(() =>
    initialDisplayState(target),
  );
  const displayStateRef = useRef(displayState);
  const activeThreadIdRef = useRef(input.threadId);
  const observedLiveTurnRef = useRef<ObservedLiveTurn | null>(null);
  const presentedTerminalKeyRef = useRef<string | null>(null);
  const lastPhaseChangeAtRef = useRef(performance.now());
  const phaseFrameRef = useRef<number | null>(null);
  const terminalFrameRef = useRef<number | null>(null);

  const cancelPhaseFrame = useCallback(() => {
    if (phaseFrameRef.current !== null) {
      window.cancelAnimationFrame(phaseFrameRef.current);
      phaseFrameRef.current = null;
    }
  }, []);
  const cancelTerminalFrame = useCallback(() => {
    if (terminalFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalFrameRef.current);
      terminalFrameRef.current = null;
    }
  }, []);
  const commit = useCallback((next: AgentActivityState, now = performance.now()) => {
    const previous = displayStateRef.current;
    if (previous.phase !== next.phase || previous.turnKey !== next.turnKey) {
      lastPhaseChangeAtRef.current = now;
    }
    displayStateRef.current = next;
    setDisplayState((current) => (activityStatesEqual(current, next) ? current : next));
  }, []);

  const schedulePhaseCommit = useCallback(
    (next: AgentActivityState, notBefore: number) => {
      cancelPhaseFrame();
      const waitForDwell = (now: number) => {
        if (now < notBefore) {
          phaseFrameRef.current = window.requestAnimationFrame(waitForDwell);
          return;
        }
        phaseFrameRef.current = null;
        commit(next, now);
      };
      phaseFrameRef.current = window.requestAnimationFrame(waitForDwell);
    },
    [cancelPhaseFrame, commit],
  );

  const scheduleTerminalDismissal = useCallback(
    (notBefore: number) => {
      cancelTerminalFrame();
      const waitForDissolve = (now: number) => {
        if (now < notBefore) {
          terminalFrameRef.current = window.requestAnimationFrame(waitForDissolve);
          return;
        }
        terminalFrameRef.current = null;
        commit(IDLE_AGENT_ACTIVITY_STATE, now);
      };
      terminalFrameRef.current = window.requestAnimationFrame(waitForDissolve);
    },
    [cancelTerminalFrame, commit],
  );

  // Layout timing prevents an outgoing thread's pulse from painting once on the
  // incoming thread before the thread-local presentation memory is reset.
  useLayoutEffect(() => {
    const now = performance.now();
    const threadChanged = activeThreadIdRef.current !== input.threadId;
    if (threadChanged) {
      activeThreadIdRef.current = input.threadId;
      observedLiveTurnRef.current = null;
      presentedTerminalKeyRef.current = null;
      cancelPhaseFrame();
      cancelTerminalFrame();

      if (isLiveAgentActivityPhase(target.phase) && input.threadId) {
        observedLiveTurnRef.current = { threadId: input.threadId, turnKey: target.turnKey };
        commit(target, now);
      } else {
        commit(IDLE_AGENT_ACTIVITY_STATE, now);
      }
      return;
    }

    if (isLiveAgentActivityPhase(target.phase) && input.threadId) {
      cancelTerminalFrame();
      const previousObservedTurn = observedLiveTurnRef.current;
      const isNewTurn =
        previousObservedTurn === null || previousObservedTurn.turnKey !== target.turnKey;
      observedLiveTurnRef.current = { threadId: input.threadId, turnKey: target.turnKey };

      const current = displayStateRef.current;
      if (
        isNewTurn ||
        !isLiveAgentActivityPhase(current.phase) ||
        current.turnKey !== target.turnKey
      ) {
        cancelPhaseFrame();
        commit(target, now);
        return;
      }

      if (current.phase !== target.phase) {
        const notBefore = lastPhaseChangeAtRef.current + AGENT_ACTIVITY_MIN_PHASE_DWELL_MS;
        if (now < notBefore) {
          schedulePhaseCommit(target, notBefore);
          return;
        }
      }
      cancelPhaseFrame();
      commit(target, now);
      return;
    }

    if (isTerminalAgentActivityPhase(target.phase) && input.threadId) {
      cancelPhaseFrame();
      const observed = observedLiveTurnRef.current;
      const terminalKey = `${input.threadId}:${target.turnKey ?? "unknown"}:${target.phase}`;
      const observedThisThread = observed?.threadId === input.threadId;
      const observedThisTurn =
        observedThisThread &&
        (observed?.turnKey === target.turnKey ||
          observed?.turnKey?.startsWith("pending:") === true);

      if (!observedThisTurn || presentedTerminalKeyRef.current === terminalKey) {
        return;
      }

      presentedTerminalKeyRef.current = terminalKey;
      observedLiveTurnRef.current = null;
      cancelTerminalFrame();
      commit(target, now);
      if (target.phase === "completed" || target.phase === "failed") {
        scheduleTerminalDismissal(now + AGENT_ACTIVITY_TERMINAL_DISPLAY_MS);
      }
      return;
    }

    cancelPhaseFrame();

    // An interruption is intentionally sticky until another lifecycle begins.
    if (displayStateRef.current.phase === "interrupted") {
      return;
    }

    // Preserve an already-presented one-shot terminal phase until its scheduled
    // 440ms dismissal even if projection cleanup removes latestTurn first.
    if (
      terminalFrameRef.current !== null &&
      (displayStateRef.current.phase === "completed" || displayStateRef.current.phase === "failed")
    ) {
      return;
    }
    cancelTerminalFrame();

    // Pending approval/input is visually idle but still belongs to the live
    // turn. Preserve that evidence so a fast post-approval terminal event can
    // still present its one-shot result without an intermediate active render.
    if (!input.hasPendingApproval && !input.hasPendingUserInput) {
      observedLiveTurnRef.current = null;
    }
    commit(IDLE_AGENT_ACTIVITY_STATE, now);
  }, [
    cancelPhaseFrame,
    cancelTerminalFrame,
    commit,
    input.hasPendingApproval,
    input.hasPendingUserInput,
    input.threadId,
    schedulePhaseCommit,
    scheduleTerminalDismissal,
    target,
  ]);

  useEffect(
    () => () => {
      cancelPhaseFrame();
      cancelTerminalFrame();
    },
    [cancelPhaseFrame, cancelTerminalFrame],
  );

  return displayState;
}
