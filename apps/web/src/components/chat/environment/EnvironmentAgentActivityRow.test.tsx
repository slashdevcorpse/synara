import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentActivityState } from "../agentActivityPulse.logic";
import { EnvironmentAgentActivityRow } from "./EnvironmentAgentActivityRow";

function state(phase: AgentActivityState["phase"]): AgentActivityState {
  return {
    phase,
    toolCount: phase === "tool-running" ? 2 : 0,
    subagentCount: 0,
    lastEventTimestamp: "2026-07-20T12:00:00.000Z",
    turnKey: phase === "idle" ? null : "turn-1",
  };
}

describe("EnvironmentAgentActivityRow", () => {
  it("shows a muted idle Agent row", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentAgentActivityRow provider="codex" state={state("idle")} />,
    );

    expect(markup).toContain("Agent status: Idle");
    expect(markup).toContain('role="group"');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('aria-live="polite"');
    expect(markup).toContain(">Agent<");
    expect(markup).not.toContain("Agent (active)");
  });

  it("synchronizes the active label and pulse phase", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentAgentActivityRow provider="codex" state={state("tool-running")} />,
    );

    expect(markup).toContain("Agent status: Running tools");
    expect(markup).toContain("Agent (active)");
    expect(markup).toContain('data-agent-activity-phase="tool-running"');
    expect(markup).toContain('data-agent-activity-variant="dot"');
  });
});
