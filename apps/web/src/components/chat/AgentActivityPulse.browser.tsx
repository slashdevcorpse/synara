import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AgentActivityPulse } from "./AgentActivityPulse";
import type { AgentActivityInput } from "./agentActivityPulse.logic";
import { useAgentActivityState } from "./useAgentActivityState";

const TURN_ID = "turn-browser-1" as never;

function input(overrides: Partial<AgentActivityInput> = {}): AgentActivityInput {
  return {
    threadId: "thread-browser",
    hasMessages: true,
    localDispatchPending: false,
    session: {
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: TURN_ID,
      updatedAt: "2026-07-20T12:00:01.000Z",
    },
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: "2026-07-20T12:00:00.000Z",
      startedAt: "2026-07-20T12:00:01.000Z",
      completedAt: null,
    },
    messages: [
      {
        role: "user",
        text: "Implement it",
        streaming: false,
        turnId: TURN_ID,
        createdAt: "2026-07-20T12:00:00.000Z",
      },
    ],
    activities: [],
    hasPendingApproval: false,
    hasPendingUserInput: false,
    threadError: null,
    ...overrides,
  };
}

function ActivityHarness({ value }: { value: AgentActivityInput }) {
  const state = useAgentActivityState(value);
  return <AgentActivityPulse state={state} variant="bar" announce />;
}

function currentPhase(container: HTMLElement): string | null {
  return (
    container
      .querySelector<HTMLElement>("[data-agent-activity-phase]")
      ?.getAttribute("data-agent-activity-phase") ?? null
  );
}

describe("AgentActivityPulse lifecycle", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("moves through thinking, streaming, tools, and a one-shot completed dissolve", async () => {
    const screen = await render(<ActivityHarness value={input()} />);
    try {
      expect(currentPhase(screen.container)).toBe("thinking");

      const streamingMessage = {
        role: "assistant" as const,
        text: "Inspecting",
        streaming: true,
        turnId: TURN_ID,
        createdAt: "2026-07-20T12:00:02.000Z",
      };
      await screen.rerender(
        <ActivityHarness value={input({ messages: [...input().messages, streamingMessage] })} />,
      );
      await vi.waitFor(() => expect(currentPhase(screen.container)).toBe("streaming"));

      await screen.rerender(
        <ActivityHarness
          value={input({
            messages: [...input().messages, streamingMessage],
            activities: [
              {
                kind: "tool.started",
                payload: { data: { toolCallId: "browser-call" } },
                summary: "Read file",
                turnId: TURN_ID,
                createdAt: "2026-07-20T12:00:03.000Z",
              },
            ],
          })}
        />,
      );
      await vi.waitFor(() => expect(currentPhase(screen.container)).toBe("tool-running"));

      await screen.rerender(
        <ActivityHarness
          value={input({
            session: {
              ...input().session!,
              status: "ready",
              orchestrationStatus: "ready",
              activeTurnId: undefined,
            },
            latestTurn: {
              ...input().latestTurn!,
              state: "completed",
              completedAt: "2026-07-20T12:00:04.000Z",
            },
          })}
        />,
      );
      await vi.waitFor(() => expect(currentPhase(screen.container)).toBe("completed"));
      await vi.waitFor(() => expect(currentPhase(screen.container)).toBeNull(), { timeout: 1_200 });
    } finally {
      await screen.unmount();
    }
  });

  it("does not replay historical terminal turns on mount", async () => {
    const screen = await render(
      <ActivityHarness
        value={input({
          session: {
            ...input().session!,
            status: "ready",
            orchestrationStatus: "ready",
            activeTurnId: undefined,
          },
          latestTurn: {
            ...input().latestTurn!,
            state: "completed",
            completedAt: "2026-07-20T12:00:04.000Z",
          },
        })}
      />,
    );
    try {
      expect(currentPhase(screen.container)).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("does not paint the previous thread's phase when switching to historical terminal state", async () => {
    const screen = await render(<ActivityHarness value={input()} />);
    try {
      expect(currentPhase(screen.container)).toBe("thinking");
      await screen.rerender(
        <ActivityHarness
          value={input({
            threadId: "thread-browser-history",
            session: {
              ...input().session!,
              status: "ready",
              orchestrationStatus: "ready",
              activeTurnId: undefined,
            },
            latestTurn: {
              ...input().latestTurn!,
              state: "completed",
              completedAt: "2026-07-20T12:00:04.000Z",
            },
          })}
        />,
      );
      expect(currentPhase(screen.container)).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("cancels a terminal dissolve immediately when the next local lifecycle begins", async () => {
    const screen = await render(<ActivityHarness value={input()} />);
    try {
      const completedInput = input({
        session: {
          ...input().session!,
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        latestTurn: {
          ...input().latestTurn!,
          state: "completed",
          completedAt: "2026-07-20T12:00:04.000Z",
        },
      });
      await screen.rerender(<ActivityHarness value={completedInput} />);
      await vi.waitFor(() => expect(currentPhase(screen.container)).toBe("completed"));

      await screen.rerender(
        <ActivityHarness value={{ ...completedInput, localDispatchPending: true }} />,
      );
      expect(currentPhase(screen.container)).toBe("thinking");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      expect(currentPhase(screen.container)).toBe("thinking");
    } finally {
      await screen.unmount();
    }
  });

  it.each(["hasPendingApproval", "hasPendingUserInput"] as const)(
    "retains observed-turn evidence while %s is visually idle",
    async (pendingKey) => {
      const screen = await render(<ActivityHarness value={input()} />);
      try {
        await screen.rerender(<ActivityHarness value={input({ [pendingKey]: true })} />);
        await vi.waitFor(() => expect(currentPhase(screen.container)).toBeNull());

        await screen.rerender(
          <ActivityHarness
            value={input({
              session: {
                ...input().session!,
                status: "ready",
                orchestrationStatus: "ready",
                activeTurnId: undefined,
              },
              latestTurn: {
                ...input().latestTurn!,
                state: "completed",
                completedAt: "2026-07-20T12:00:04.000Z",
              },
            })}
          />,
        );
        await vi.waitFor(() => expect(currentPhase(screen.container)).toBe("completed"));
      } finally {
        await screen.unmount();
      }
    },
  );

  it("does not restart active-phase dwell for same-phase payload refreshes", async () => {
    const screen = await render(<ActivityHarness value={input()} />);
    try {
      for (let index = 1; index <= 3; index += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 45));
        await screen.rerender(
          <ActivityHarness
            value={input({
              session: {
                ...input().session!,
                updatedAt: `2026-07-20T12:00:0${index + 1}.000Z`,
              },
            })}
          />,
        );
      }

      await screen.rerender(
        <ActivityHarness
          value={input({
            messages: [
              ...input().messages,
              {
                role: "assistant",
                text: "Now responding",
                streaming: true,
                turnId: TURN_ID,
                createdAt: "2026-07-20T12:00:06.000Z",
              },
            ],
          })}
        />,
      );
      expect(currentPhase(screen.container)).toBe("streaming");
    } finally {
      await screen.unmount();
    }
  });

  it("holds interruption until the next live turn", async () => {
    const screen = await render(<ActivityHarness value={input()} />);
    try {
      await screen.rerender(
        <ActivityHarness
          value={input({
            latestTurn: { ...input().latestTurn!, state: "interrupted" },
            session: {
              ...input().session!,
              status: "ready",
              orchestrationStatus: "interrupted",
              activeTurnId: undefined,
            },
          })}
        />,
      );
      await vi.waitFor(() => expect(currentPhase(screen.container)).toBe("interrupted"));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 520));
      expect(currentPhase(screen.container)).toBe("interrupted");

      const nextTurnId = "turn-browser-2" as never;
      await screen.rerender(
        <ActivityHarness
          value={input({
            session: { ...input().session!, activeTurnId: nextTurnId },
            latestTurn: {
              ...input().latestTurn!,
              turnId: nextTurnId,
              state: "running",
              completedAt: null,
            },
            messages: [{ ...input().messages[0]!, turnId: nextTurnId }],
          })}
        />,
      );
      await vi.waitFor(() => expect(currentPhase(screen.container)).toBe("thinking"));
    } finally {
      await screen.unmount();
    }
  });

  it("ships a parsed prefers-reduced-motion fallback for activity motion", async () => {
    const screen = await render(<AgentActivityPulse variant="bar" phase="streaming" />);
    try {
      const mediaRules = Array.from(document.styleSheets).flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules).filter(
            (rule): rule is CSSMediaRule => rule instanceof CSSMediaRule,
          );
        } catch {
          return [];
        }
      });
      const reducedMotionRule = mediaRules.find(
        (rule) =>
          rule.conditionText.includes("prefers-reduced-motion: reduce") &&
          Array.from(rule.cssRules).some(
            (nestedRule) =>
              nestedRule instanceof CSSStyleRule &&
              nestedRule.selectorText.includes("agent-activity__motion"),
          ),
      );
      expect(reducedMotionRule).toBeDefined();
      expect(
        Array.from(reducedMotionRule?.cssRules ?? []).some(
          (rule) =>
            rule instanceof CSSStyleRule &&
            rule.selectorText.includes("agent-activity__motion") &&
            (rule.style.animationName === "none" || rule.cssText.includes("animation: none")),
        ),
      ).toBe(true);
      await expect.element(page.getByText("Agent is responding")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
