// FILE: WorkspaceAgentPanel.test.tsx
// Purpose: Static presentation and accessibility coverage for workspace agent components.
// Layer: Workspace agent sidebar tests

import { PROVIDER_DISPLAY_NAMES, ThreadId, type ProviderKind } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentStatus } from "../../hooks/useWorkspaceAgentActivity";
import { AgentThreadRow } from "./AgentThreadRow";
import { AgentToolPreview } from "./AgentToolPreview";
import { WorkspaceAgentPanel } from "./WorkspaceAgentPanel";
import {
  makeWorkspaceAgentActivity as makeActivity,
  makeWorkspaceAgentEntry as makeEntry,
} from "./WorkspaceAgentPanel.testFixtures";
const INTERRUPT_ACTION_CASES = [
  ["idle", false],
  ["connecting", true],
  ["thinking", true],
  ["streaming", true],
  ["tool-running", true],
  ["queued", false],
  ["completed", false],
  ["failed", false],
  ["stopped", false],
] satisfies Array<[AgentStatus, boolean]>;

describe("AgentToolPreview", () => {
  it("renders non-announcing reduced-motion-safe tool progress", () => {
    const running = renderToStaticMarkup(
      <AgentToolPreview tool={{ name: "Read file", state: "running" }} />,
    );
    const done = renderToStaticMarkup(
      <AgentToolPreview tool={{ name: "Read file", state: "done" }} />,
    );

    expect(running).toContain('aria-hidden="true"');
    expect(running).not.toContain('role="progressbar"');
    expect(running).not.toContain("aria-valuetext");
    expect(running).toContain("motion-reduce:animate-none");
    expect(done).toContain('aria-hidden="true"');
    expect(done).toContain("bg-emerald-300/70");
  });
});

describe("AgentThreadRow", () => {
  it("renders every compact metadata field and accessible provider identity", () => {
    const markup = renderToStaticMarkup(
      <AgentThreadRow
        entry={makeEntry({
          isSubagent: true,
          subagentNickname: "Scout",
          subagentRole: "reviewer",
          status: "tool-running",
          latestTool: { name: "Search files", state: "running" },
          streamPreview: "Checking the sidebar interaction seams",
          associatedWorktreeBranch: "feature/workspace-agents",
        })}
        depth={2}
        onOpenThread={vi.fn()}
        onStopThread={vi.fn()}
      />,
    );

    expect(markup).toContain("Implement workspace agents");
    expect(markup).toContain("GPT-5.6 · high");
    expect(markup).toContain("Scout · reviewer");
    expect(markup).toContain("feature/workspace-agents");
    expect(markup).toContain("Tool running");
    expect(markup).toContain("1m 1s");
    expect(markup).toContain("Search files");
    expect(markup).toContain("Checking the sidebar interaction seams");
    expect(markup).toContain("Codex: ");
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain(
      "Codex. model GPT-5.6. effort high. Scout, reviewer. status Tool running. duration 1m 1s",
    );
    expect(markup).toContain("tool Search files running");
    expect(markup).toContain('data-agent-depth="2"');
    expect(markup).toContain("motion-reduce:animate-none");
  });

  it("exposes every provider name alongside its decorative icon", () => {
    for (const [provider, name] of Object.entries(PROVIDER_DISPLAY_NAMES) as Array<
      [ProviderKind, string]
    >) {
      const markup = renderToStaticMarkup(
        <AgentThreadRow
          entry={makeEntry({ providerKind: provider })}
          depth={0}
          onOpenThread={vi.fn()}
          onStopThread={vi.fn()}
        />,
      );
      expect(markup).toContain(`${name}: `);
    }
  });

  it.each(INTERRUPT_ACTION_CASES)(
    "renders the interrupt action for %s only when interruptible",
    (status, interruptible) => {
      const markup = renderToStaticMarkup(
        <AgentThreadRow
          entry={makeEntry({ status })}
          depth={0}
          onOpenThread={vi.fn()}
          onStopThread={vi.fn()}
        />,
      );

      expect(markup.includes('aria-label="Stop Implement workspace agents"')).toBe(interruptible);
    },
  );

  it("does not expose an interrupt action until an exact turn id is available", () => {
    const markup = renderToStaticMarkup(
      <AgentThreadRow
        entry={makeEntry({ status: "thinking", turnId: null })}
        depth={0}
        onOpenThread={vi.fn()}
        onStopThread={vi.fn()}
      />,
    );

    expect(markup).not.toContain('aria-label="Stop Implement workspace agents"');
  });
});

describe("WorkspaceAgentPanel", () => {
  it("keeps queued work visible without exposing interrupt actions", () => {
    const queued = makeEntry({ status: "queued", threadTitle: "Queued agent" });
    const markup = renderToStaticMarkup(
      <WorkspaceAgentPanel
        activity={makeActivity([queued], [{ entry: queued, children: [] }])}
        onOpenThread={vi.fn()}
        onStopThread={vi.fn()}
        onStopAll={vi.fn()}
      />,
    );

    expect(markup).toContain("1 queued");
    expect(markup).toContain('aria-label="Collapse workspace agents"');
    expect(markup).not.toContain('aria-label="Stop Queued agent"');
    expect(markup).not.toContain('aria-label="Stop all agents"');
  });

  it("renders project hierarchy, aggregate live region, shared disclosures, and leaf dismissal", () => {
    const parent = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-parent"),
      status: "completed",
      threadTitle: "Parent thread",
    });
    const child = makeEntry({
      threadId: ThreadId.makeUnsafe("thread-child"),
      parentThreadId: parent.threadId,
      isSubagent: true,
      status: "failed",
      threadTitle: "Child thread",
    });
    const markup = renderToStaticMarkup(
      <WorkspaceAgentPanel
        activity={makeActivity(
          [parent, child],
          [{ entry: parent, children: [{ entry: child, children: [] }] }],
        )}
        onOpenThread={vi.fn()}
        onStopThread={vi.fn()}
        onStopAll={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Workspace agents"');
    expect(markup.match(/aria-live="polite"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Expand workspace agents"');
    expect(markup).toContain('aria-label="Collapse Synara agents"');
    expect(markup).toContain('aria-label="Dismiss Child thread"');
    expect(markup).not.toContain('aria-label="Dismiss Parent thread"');
    expect(markup).toContain("1 subagent (0 running)");
    expect(markup).not.toContain("1 subagents");
    expect(markup).toContain("grid-rows-[0fr]");
    expect(markup).toContain("Parent thread");
    expect(markup).toContain("Child thread");
  });
});
