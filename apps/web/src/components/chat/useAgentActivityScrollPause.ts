// FILE: useAgentActivityScrollPause.ts
// Purpose: Pause ambient agent activity motion while the transcript is actively scrolling.
// Layer: Chat presentation hook
// Exports: an imperative chat-scope ref and scroll activity callback

import { useCallback, useEffect, useRef, type RefObject } from "react";

export const AGENT_ACTIVITY_SCROLL_QUIET_MS = 140;

export interface AgentActivityScrollPauseController {
  scopeRef: RefObject<HTMLDivElement | null>;
  markTranscriptScrollActivity: () => void;
}

/**
 * Mutates one data attribute at the chat-pane boundary instead of putting scroll
 * activity in React state. The pulse and composer accent can both pause through
 * CSS without rerendering ChatView or entering the transcript measurement path.
 */
export function useAgentActivityScrollPause(): AgentActivityScrollPauseController {
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const lastScrollAtRef = useRef(0);
  const quietFrameRef = useRef<number | null>(null);

  const cancelQuietFrame = useCallback(() => {
    if (quietFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(quietFrameRef.current);
    quietFrameRef.current = null;
  }, []);

  const markTranscriptScrollActivity = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope) {
      return;
    }

    scope.dataset.agentActivityScrollPaused = "true";
    lastScrollAtRef.current = performance.now();
    if (quietFrameRef.current !== null) {
      return;
    }

    const waitForQuietWindow = (now: number) => {
      if (now - lastScrollAtRef.current < AGENT_ACTIVITY_SCROLL_QUIET_MS) {
        quietFrameRef.current = window.requestAnimationFrame(waitForQuietWindow);
        return;
      }
      quietFrameRef.current = null;
      delete scope.dataset.agentActivityScrollPaused;
    };

    quietFrameRef.current = window.requestAnimationFrame(waitForQuietWindow);
  }, []);

  useEffect(
    () => () => {
      cancelQuietFrame();
      const scope = scopeRef.current;
      if (scope) {
        delete scope.dataset.agentActivityScrollPaused;
      }
    },
    [cancelQuietFrame],
  );

  return { scopeRef, markTranscriptScrollActivity };
}
