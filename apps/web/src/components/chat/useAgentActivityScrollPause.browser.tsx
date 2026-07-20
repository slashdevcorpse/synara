import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AgentActivityPulse } from "./AgentActivityPulse";
import { useAgentActivityScrollPause } from "./useAgentActivityScrollPause";

function ScrollPauseHarness() {
  const { scopeRef, markTranscriptScrollActivity } = useAgentActivityScrollPause();
  return (
    <div ref={scopeRef} data-testid="activity-scope" className="relative h-48 w-80">
      <AgentActivityPulse variant="bar" phase="streaming" />
      <AgentActivityPulse variant="composer" phase="streaming" />
      <div
        data-testid="transcript-scroll"
        className="h-20 overflow-y-auto"
        onScroll={markTranscriptScrollActivity}
      >
        <div className="h-96">Scrollable transcript</div>
      </div>
    </div>
  );
}

describe("useAgentActivityScrollPause", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pauses transcript and composer activity from a real scroll event, then resumes", async () => {
    const screen = await render(<ScrollPauseHarness />);
    try {
      const scroll = screen.container.querySelector<HTMLElement>(
        "[data-testid='transcript-scroll']",
      );
      const scope = screen.container.querySelector<HTMLElement>("[data-testid='activity-scope']");
      const motions = Array.from(
        screen.container.querySelectorAll<HTMLElement>(".agent-activity__motion"),
      );
      expect(scroll).not.toBeNull();
      expect(motions).toHaveLength(2);

      if (scroll) {
        scroll.scrollTop = 40;
        scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      }

      expect(scope?.dataset.agentActivityScrollPaused).toBe("true");
      expect(motions.map((motion) => getComputedStyle(motion).animationPlayState)).toEqual([
        "paused",
        "paused",
      ]);
      await vi.waitFor(
        () => {
          expect(scope?.dataset.agentActivityScrollPaused).toBeUndefined();
          expect(motions.map((motion) => getComputedStyle(motion).animationPlayState)).toEqual([
            "running",
            "running",
          ]);
        },
        { timeout: 1_000 },
      );
    } finally {
      await screen.unmount();
    }
  });
});
