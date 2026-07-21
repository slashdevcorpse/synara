import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentActivityPulse,
  agentActivityBarPresenceReducer,
  createInitialAgentActivityBarPresence,
} from "./AgentActivityPulse";
import type { AgentActivityPhase, AgentActivityState } from "./agentActivityPulse.logic";

const AGENT_ACTIVITY_CSS = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function activityState(
  phase: AgentActivityPhase,
  counts: Partial<
    Pick<AgentActivityState, "toolCount" | "subagentCount" | "subagentRunningCount">
  > = {},
): Pick<
  AgentActivityState,
  "phase" | "toolCount" | "subagentCount" | "subagentRunningCount"
> {
  return {
    phase,
    toolCount: counts.toolCount ?? 0,
    subagentCount: counts.subagentCount ?? 0,
    subagentRunningCount: counts.subagentRunningCount ?? counts.subagentCount ?? 0,
  };
}

describe("AgentActivityPulse", () => {
  it("renders nothing while idle", () => {
    expect(
      renderToStaticMarkup(<AgentActivityPulse variant="bar" state={activityState("idle")} />),
    ).toBe("");
    expect(renderToStaticMarkup(<AgentActivityPulse variant="dot" phase="idle" />)).toBe("");
    expect(renderToStaticMarkup(<AgentActivityPulse variant="bar" phase="stopped" />)).toBe("");
  });

  it("renders every non-idle phase with stable phase and variant hooks", () => {
    const phases = [
      "connecting",
      "thinking",
      "streaming",
      "tool-running",
      "interrupted",
      "completed",
      "failed",
    ] as const satisfies ReadonlyArray<Exclude<AgentActivityPhase, "idle" | "stopped">>;

    for (const phase of phases) {
      const markup = renderToStaticMarkup(
        <AgentActivityPulse variant="bar" state={activityState(phase)} />,
      );
      expect(markup).toContain(`data-agent-activity-phase="${phase}"`);
      expect(markup).toContain('data-agent-activity-variant="bar"');
    }
  });

  it("uses shared disclosure timing for the transcript bar", () => {
    const markup = renderToStaticMarkup(
      <AgentActivityPulse
        variant="bar"
        state={activityState("thinking")}
        className="absolute inset-x-0 top-0"
      />,
    );

    expect(markup).toContain("duration-220");
    expect(markup).toContain("ease-out");
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain("absolute inset-x-0 top-0");
    expect(markup).toContain('data-agent-activity-open="false"');
    expect(markup).toContain("grid-rows-[0fr]");
  });

  it("moves the bar through closed, open, closed, and unmounted presence states", () => {
    const activeState = {
      ...activityState("thinking"),
      lastEventTimestamp: "2026-07-20T12:00:00.000Z",
      motionIdentity: "thinking:2026-07-20T12:00:00.000Z",
    };
    const idleState = {
      ...activityState("idle"),
      lastEventTimestamp: null,
      motionIdentity: "idle:stable",
    };

    let presence = createInitialAgentActivityBarPresence(activeState);
    expect(presence).toMatchObject({ open: false, state: { phase: "thinking" } });
    presence = agentActivityBarPresenceReducer(presence, { type: "open" });
    expect(presence?.open).toBe(true);
    presence = agentActivityBarPresenceReducer(presence, { type: "sync", state: idleState });
    expect(presence).toMatchObject({ open: false, state: { phase: "thinking" } });
    presence = agentActivityBarPresenceReducer(presence, { type: "close-complete" });
    expect(presence).toBeNull();
    expect(createInitialAgentActivityBarPresence(idleState)).toBeNull();
  });

  it("announces bar status politely only when requested", () => {
    const announced = renderToStaticMarkup(
      <AgentActivityPulse
        variant="bar"
        state={activityState("tool-running", { toolCount: 2, subagentCount: 1 })}
        announce
      />,
    );
    const decorative = renderToStaticMarkup(
      <AgentActivityPulse variant="bar" state={activityState("streaming")} />,
    );

    expect(announced).toContain('role="status"');
    expect(announced).toContain('aria-live="polite"');
    expect(announced).toContain('aria-atomic="true"');
    expect(announced).toContain("Agent is running 2 tools and 1 subagent");
    expect(decorative).not.toContain('role="status"');
    expect(decorative).toContain('aria-hidden="true"');
  });

  it("renders one primary segment plus one segment per running subagent", () => {
    const markup = renderToStaticMarkup(
      <AgentActivityPulse
        variant="bar"
        state={activityState("tool-running", { toolCount: 3, subagentCount: 2 })}
      />,
    );

    expect(markup.match(/data-agent-activity-segment="true"/g)).toHaveLength(3);
    expect(markup).toContain('data-agent-activity-segment-index="0"');
    expect(markup).toContain('data-agent-activity-segment-index="2"');
    expect(markup).toContain('data-agent-activity-segment-role="primary"');
    expect(markup.match(/data-agent-activity-segment-role="subagent"/g)).toHaveLength(2);
    expect(markup).not.toContain('data-agent-activity-segment-role="overflow"');
    expect(markup).toContain("--agent-activity-segment-delay:-200ms");
    expect(markup).toContain("--agent-activity-segment-delay:0ms");
  });

  it("bounds large subagent groups behind one overflow segment", () => {
    const markup = renderToStaticMarkup(
      <AgentActivityPulse
        variant="bar"
        state={activityState("tool-running", {
          subagentCount: 20,
          subagentRunningCount: 20,
        })}
      />,
    );

    expect(markup.match(/data-agent-activity-segment="true"/g)).toHaveLength(8);
    expect(markup.match(/data-agent-activity-segment-role="subagent"/g)).toHaveLength(6);
    expect(markup.match(/data-agent-activity-segment-role="overflow"/g)).toHaveLength(1);
  });

  it("keys state-driven motion to new event timestamps and keeps shorthand motion stable", () => {
    const timestamp = "2026-07-20T12:05:00.000Z";
    const stateMarkup = renderToStaticMarkup(
      <AgentActivityPulse
        variant="composer"
        state={{ ...activityState("streaming"), lastEventTimestamp: timestamp }}
      />,
    );
    const shorthandMarkup = renderToStaticMarkup(
      <AgentActivityPulse variant="composer" phase="streaming" />,
    );

    expect(stateMarkup).toContain(`data-agent-activity-motion-identity="streaming:${timestamp}"`);
    expect(shorthandMarkup).toContain('data-agent-activity-motion-identity="phase-only"');
  });

  it("keeps live motion running indefinitely and preserves one-shot terminal motion", () => {
    expect(AGENT_ACTIVITY_CSS).toContain(
      "animation: agent-activity-motion 1.5s ease-in-out infinite;",
    );
    expect(AGENT_ACTIVITY_CSS).toMatch(
      /data-agent-activity-phase="streaming"\] \.agent-activity__motion \{[\s\S]*?animation-iteration-count: infinite;/u,
    );
    expect(AGENT_ACTIVITY_CSS).toMatch(
      /\.agent-activity__segment \{[\s\S]*?animation-delay: var\(--agent-activity-segment-delay\);[\s\S]*?animation-iteration-count: infinite;/u,
    );
    expect(AGENT_ACTIVITY_CSS).toContain("animation-iteration-count: 1;");
    expect(AGENT_ACTIVITY_CSS).toContain("animation-fill-mode: forwards;");
  });

  it("assigns every visible lifecycle group an explicit semantic color", () => {
    expect(AGENT_ACTIVITY_CSS).toContain(
      '.agent-activity[data-agent-activity-phase="connecting"]',
    );
    expect(AGENT_ACTIVITY_CSS).toMatch(
      /data-agent-activity-phase="thinking"\] \{[\s\S]*?--agent-activity-color: var\(--warning\);/u,
    );
    expect(AGENT_ACTIVITY_CSS).toMatch(
      /data-agent-activity-phase="streaming"\],[\s\S]*?data-agent-activity-phase="tool-running"\] \{[\s\S]*?--agent-activity-color: var\(--primary\);/u,
    );
    expect(AGENT_ACTIVITY_CSS).toContain("--agent-activity-color: var(--success);");
    expect(AGENT_ACTIVITY_CSS).toContain("--agent-activity-color: var(--destructive);");
  });

  it("removes terminal track backgrounds so the one-shot fill fully dissolves", () => {
    expect(AGENT_ACTIVITY_CSS).toMatch(
      /data-agent-activity-phase="completed"\] \.agent-activity__visual,[\s\S]*?background: transparent;/u,
    );
    expect(AGENT_ACTIVITY_CSS).toContain(
      '.agent-activity--dot[data-agent-activity-phase="failed"]',
    );
  });

  it("renders decorative composer and dot variants without status semantics", () => {
    for (const variant of ["composer", "dot"] as const) {
      const markup = renderToStaticMarkup(
        <AgentActivityPulse variant={variant} phase="completed" className="custom-class" />,
      );

      expect(markup).toContain(`data-agent-activity-variant="${variant}"`);
      expect(markup).toContain('data-agent-activity-phase="completed"');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain("custom-class");
      expect(markup).not.toContain('role="status"');
    }
  });

  it.each([
    ["connecting", "Agent is connecting"],
    ["thinking", "Agent is thinking"],
    ["streaming", "Agent is responding"],
    ["interrupted", "Agent was interrupted"],
    ["completed", "Agent completed"],
    ["failed", "Agent failed"],
  ] as const)("announces the %s phase as %s", (phase, label) => {
    const markup = renderToStaticMarkup(
      <AgentActivityPulse variant="bar" state={activityState(phase)} announce />,
    );

    expect(markup).toContain(label);
  });
});
