// FILE: AgentActivityPulse.tsx
// Purpose: Shared visual treatment for the current coding-agent activity phase.
// Layer: Chat UI primitive
// Exports: AgentActivityPulse

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type CSSProperties,
  type TransitionEvent,
} from "react";

import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";

import type { AgentActivityPhase, AgentActivityState } from "./agentActivityPulse.logic";

const TOOL_PATTERN_SEGMENT_COUNT = 12;

const PHASE_LABELS: Record<Exclude<AgentActivityPhase, "tool-running">, string> = {
  idle: "Agent is idle",
  thinking: "Agent is thinking",
  streaming: "Agent is responding",
  interrupted: "Agent was interrupted",
  completed: "Agent completed",
  failed: "Agent failed",
};

export type AgentActivityVisualState = Pick<
  AgentActivityState,
  "phase" | "toolCount" | "subagentCount"
> &
  Partial<Pick<AgentActivityState, "lastEventTimestamp">> & {
    presentationThreadId?: string | null;
  };

interface AgentActivityRenderableState extends AgentActivityVisualState {
  motionIdentity: string;
}

export interface AgentActivityBarPresence {
  state: AgentActivityRenderableState;
  open: boolean;
}

export type AgentActivityBarPresenceAction =
  | { type: "sync"; state: AgentActivityRenderableState }
  | { type: "open" }
  | { type: "close-complete" };

const AGENT_ACTIVITY_DISCLOSURE_DURATION_MS = 220;

export function createInitialAgentActivityBarPresence(
  state: AgentActivityRenderableState,
): AgentActivityBarPresence | null {
  return state.phase === "idle" ? null : { state, open: false };
}

export function agentActivityBarPresenceReducer(
  current: AgentActivityBarPresence | null,
  action: AgentActivityBarPresenceAction,
): AgentActivityBarPresence | null {
  if (action.type === "close-complete") {
    return current?.open === false ? null : current;
  }
  if (action.type === "open") {
    return current && !current.open ? { ...current, open: true } : current;
  }
  if (action.state.phase === "idle") {
    return current ? { ...current, open: false } : null;
  }
  return { state: action.state, open: current?.open ?? false };
}

type AgentActivityPulseCommonProps = {
  variant: "bar" | "composer" | "dot";
  className?: string;
  announce?: boolean;
};

export type AgentActivityPulseProps = AgentActivityPulseCommonProps &
  (
    | {
        state: AgentActivityVisualState;
        phase?: never;
      }
    | {
        state?: never;
        phase: AgentActivityPhase;
      }
  );

function activityLabel(state: AgentActivityVisualState): string {
  if (state.phase !== "tool-running") {
    return PHASE_LABELS[state.phase];
  }

  const parts: string[] = [];
  if (state.toolCount > 0) {
    parts.push(`${state.toolCount} ${state.toolCount === 1 ? "tool" : "tools"}`);
  }
  if (state.subagentCount > 0) {
    parts.push(`${state.subagentCount} ${state.subagentCount === 1 ? "subagent" : "subagents"}`);
  }

  return parts.length > 0 ? `Agent is running ${parts.join(" and ")}` : "Agent is running tools";
}

type AgentActivitySegmentStyle = CSSProperties & {
  "--agent-activity-segment-delay": string;
};

function ActivityVisual({ state }: { state: AgentActivityRenderableState }) {
  const phase = state.phase as Exclude<AgentActivityPhase, "idle">;

  return (
    <span
      key={state.motionIdentity}
      className="agent-activity__visual"
      data-agent-activity-motion-identity={state.motionIdentity}
      aria-hidden="true"
    >
      {phase === "tool-running" ? (
        <span className="agent-activity__segments">
          {Array.from({ length: TOOL_PATTERN_SEGMENT_COUNT }, (_, index) => (
            <span
              // The segments are a fixed cadence pattern, not a progress meter.
              key={index}
              className="agent-activity__motion agent-activity__segment"
              data-agent-activity-segment="true"
              data-agent-activity-segment-index={index}
              style={
                {
                  "--agent-activity-segment-delay": `${(index - (TOOL_PATTERN_SEGMENT_COUNT - 1)) * 100}ms`,
                } as AgentActivitySegmentStyle
              }
            />
          ))}
        </span>
      ) : (
        <span className="agent-activity__motion" />
      )}
    </span>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function AgentActivityBar({
  state,
  className,
  announce,
}: {
  state: AgentActivityRenderableState;
  className?: string;
  announce: boolean;
}) {
  const { phase, toolCount, subagentCount, lastEventTimestamp, motionIdentity } = state;
  const synchronizedState = useMemo<AgentActivityRenderableState>(
    () => ({
      phase,
      toolCount,
      subagentCount,
      motionIdentity,
      ...(lastEventTimestamp !== undefined ? { lastEventTimestamp } : {}),
    }),
    [lastEventTimestamp, motionIdentity, phase, subagentCount, toolCount],
  );
  const [presence, dispatch] = useReducer(
    agentActivityBarPresenceReducer,
    synchronizedState,
    createInitialAgentActivityBarPresence,
  );
  const presenceRef = useRef(presence);
  const requestedStateRef = useRef(synchronizedState);
  const enterFrameRef = useRef<number | null>(null);
  const exitFrameRef = useRef<number | null>(null);
  presenceRef.current = presence;
  requestedStateRef.current = synchronizedState;

  const cancelEnterFrame = useCallback(() => {
    if (enterFrameRef.current !== null) {
      window.cancelAnimationFrame(enterFrameRef.current);
      enterFrameRef.current = null;
    }
  }, []);
  const cancelExitFrame = useCallback(() => {
    if (exitFrameRef.current !== null) {
      window.cancelAnimationFrame(exitFrameRef.current);
      exitFrameRef.current = null;
    }
  }, []);
  const completeClose = useCallback(() => {
    cancelExitFrame();
    if (requestedStateRef.current.phase === "idle") {
      dispatch({ type: "close-complete" });
    }
  }, [cancelExitFrame]);

  useEffect(() => {
    cancelEnterFrame();
    cancelExitFrame();

    if (synchronizedState.phase !== "idle") {
      dispatch({ type: "sync", state: synchronizedState });
      if (prefersReducedMotion()) {
        dispatch({ type: "open" });
      } else {
        enterFrameRef.current = window.requestAnimationFrame(() => {
          enterFrameRef.current = null;
          if (requestedStateRef.current.phase !== "idle") {
            dispatch({ type: "open" });
          }
        });
      }
      return;
    }

    if (!presenceRef.current) {
      return;
    }
    if (prefersReducedMotion() || !presenceRef.current.open) {
      dispatch({ type: "sync", state: synchronizedState });
      dispatch({ type: "close-complete" });
      return;
    }

    dispatch({ type: "sync", state: synchronizedState });
    const closeDeadline = performance.now() + AGENT_ACTIVITY_DISCLOSURE_DURATION_MS;
    const waitForDisclosureClose = (now: number) => {
      if (now < closeDeadline) {
        exitFrameRef.current = window.requestAnimationFrame(waitForDisclosureClose);
        return;
      }
      exitFrameRef.current = null;
      if (requestedStateRef.current.phase === "idle") {
        dispatch({ type: "close-complete" });
      }
    };
    exitFrameRef.current = window.requestAnimationFrame(waitForDisclosureClose);
  }, [cancelEnterFrame, cancelExitFrame, synchronizedState]);

  useEffect(
    () => () => {
      cancelEnterFrame();
      cancelExitFrame();
    },
    [cancelEnterFrame, cancelExitFrame],
  );

  if (!presence) {
    return null;
  }

  const label = activityLabel(presence.state);
  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target && event.propertyName === "opacity") {
      completeClose();
    }
  };

  return (
    <div
      data-agent-activity-phase={presence.state.phase}
      data-agent-activity-variant="bar"
      data-agent-activity-open={presence.open ? "true" : "false"}
      className={disclosureShellClassName(
        presence.open,
        cn("agent-activity agent-activity--bar", className),
      )}
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-atomic={announce ? true : undefined}
      aria-hidden={announce && presence.open ? undefined : true}
      onTransitionEnd={handleTransitionEnd}
      onTransitionCancel={handleTransitionEnd}
    >
      <div className={DISCLOSURE_INNER_CLASS}>
        <div className={disclosureContentClassName(presence.open, "agent-activity__bar-content")}>
          <ActivityVisual state={presence.state} />
          {announce ? <span className="sr-only">{label}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function AgentActivityPulse(props: AgentActivityPulseProps) {
  const visualState: AgentActivityVisualState =
    props.state !== undefined
      ? props.state
      : { phase: props.phase, toolCount: 0, subagentCount: 0 };
  const state: AgentActivityRenderableState = {
    ...visualState,
    motionIdentity:
      props.state !== undefined
        ? `${visualState.phase}:${visualState.lastEventTimestamp ?? "stable"}`
        : "phase-only",
  };

  if (props.variant === "bar") {
    return (
      <AgentActivityBar
        key={state.presentationThreadId ?? undefined}
        state={state}
        announce={props.announce === true}
        {...(props.className !== undefined ? { className: props.className } : {})}
      />
    );
  }

  if (state.phase === "idle") {
    return null;
  }

  const commonAttributes = {
    "data-agent-activity-phase": state.phase,
    "data-agent-activity-variant": props.variant,
  } as const;

  return (
    <span
      {...commonAttributes}
      className={cn("agent-activity", `agent-activity--${props.variant}`, props.className)}
      aria-hidden="true"
    >
      <ActivityVisual state={state} />
    </span>
  );
}
