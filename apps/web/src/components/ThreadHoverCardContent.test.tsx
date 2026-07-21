// FILE: ThreadHoverCardContent.test.tsx
// Purpose: Exhaustive server-rendered presentation coverage for the thread hover-card body.
// Layer: Sidebar UI component tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentStatus } from "~/lib/workspaceAgentActivity";
import { makeWorkspaceAgentEntry } from "./workspace/WorkspaceAgentPanel.testFixtures";
import {
  ThreadHoverCardContent,
  type ThreadHoverCardContentProps,
  type ThreadHoverCardPermissionMode,
  type ThreadHoverCardPrState,
} from "./ThreadHoverCardContent";

const BASE_PROPS: ThreadHoverCardContentProps = {
  threadTitle: "Fix authentication refresh",
  timeLabel: "2h",
  provider: "codex",
  modelLabel: "gpt-5.6-sol",
  parentThreadTitle: null,
  status: "idle",
  duration: null,
  toolLabel: null,
  permissionMode: "full-access",
  subagentCount: 0,
  subagentRunningCount: 0,
  subagentTree: [],
  worktreeLabel: null,
  prTitle: null,
  prState: null,
  onOpenThread: vi.fn(),
  onInterrupt: null,
};

function renderCard(overrides: Partial<ThreadHoverCardContentProps> = {}): string {
  return renderToStaticMarkup(<ThreadHoverCardContent {...BASE_PROPS} {...overrides} />);
}

describe("ThreadHoverCardContent", () => {
  it("renders the thread title, relative time, and provider/model identity", () => {
    const markup = renderCard();

    expect(markup).toContain("Fix authentication refresh");
    expect(markup).toContain("2h");
    expect(markup).toContain("Codex: ");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain('title="Fix authentication refresh"');
    expect(markup).toContain('title="gpt-5.6-sol"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("preserves aggregate-only legacy props when no subagent tree is supplied", () => {
    const { subagentTree: _subagentTree, ...legacyProps } = BASE_PROPS;
    const markup = renderToStaticMarkup(
      <ThreadHoverCardContent {...legacyProps} subagentCount={2} subagentRunningCount={1} />,
    );

    expect(markup).toContain("1 of 2 subagents running");
    expect(markup).not.toContain('aria-label="Subagent activity"');
  });

  it("omits the relative time when it is unavailable", () => {
    expect(renderCard({ timeLabel: null })).not.toContain(">2h<");
  });

  it.each<{
    status: AgentStatus;
    duration: number | null;
    toolLabel: string | null;
    copy: string;
    dotClass: string;
    pulses?: boolean;
  }>([
    {
      status: "idle",
      duration: 720_000,
      toolLabel: null,
      copy: "idle",
      dotClass: "bg-muted-foreground/25",
    },
    {
      status: "thinking",
      duration: 720_000,
      toolLabel: null,
      copy: "thinking · 12m",
      dotClass: "bg-warning",
      pulses: true,
    },
    {
      status: "streaming",
      duration: 180_000,
      toolLabel: null,
      copy: "streaming · 3m",
      dotClass: "bg-primary",
      pulses: true,
    },
    {
      status: "tool-running",
      duration: 480_000,
      toolLabel: "bun run test",
      copy: "tool: bun run test · 8m",
      dotClass: "bg-primary",
      pulses: true,
    },
    {
      status: "completed",
      duration: 300_000,
      toolLabel: null,
      copy: "completed · 5m total",
      dotClass: "bg-success",
    },
    {
      status: "failed",
      duration: 300_000,
      toolLabel: null,
      copy: "failed",
      dotClass: "bg-destructive",
    },
    {
      status: "stopped",
      duration: 300_000,
      toolLabel: null,
      copy: "stopped",
      dotClass: "bg-warning",
    },
    {
      status: "queued",
      duration: 300_000,
      toolLabel: null,
      copy: "queued",
      dotClass: "bg-violet-300/80",
    },
    {
      status: "connecting",
      duration: 300_000,
      toolLabel: null,
      copy: "connecting",
      dotClass: "bg-info",
      pulses: true,
    },
    {
      status: "interrupted",
      duration: 300_000,
      toolLabel: null,
      copy: "interrupted",
      dotClass: "bg-warning",
    },
  ])("renders exact $status status copy and shared dot treatment", (testCase) => {
    const markup = renderCard({
      status: testCase.status,
      duration: testCase.duration,
      toolLabel: testCase.toolLabel,
    });

    expect(markup).toContain(testCase.copy);
    expect(markup).toContain(testCase.dotClass);
    if (testCase.pulses) {
      expect(markup).toContain("animate-pulse");
    } else {
      expect(markup).not.toContain("animate-pulse");
    }
  });

  it("omits duration for active states when no duration is available", () => {
    expect(renderCard({ status: "thinking", duration: null })).toContain('title="thinking"');
    expect(renderCard({ status: "tool-running", duration: null, toolLabel: null })).toContain(
      'title="tool-running"',
    );
    expect(renderCard({ status: "completed", duration: null })).toContain('title="completed"');
  });

  it.each<ThreadHoverCardPermissionMode>(["full-access", "approval-required", "plan"])(
    "renders the exact lower-case %s permission mode",
    (permissionMode) => {
      const markup = renderCard({ permissionMode });
      expect(markup).toContain(`>${permissionMode}<`);
    },
  );

  it.each([
    { count: 0, running: 0, expected: null },
    { count: 1, running: 0, expected: "1 subagent" },
    { count: 3, running: 0, expected: "3 subagents" },
    { count: 3, running: 2, expected: "2 of 3 subagents running" },
  ])("formats $running running of $count direct subagents", ({ count, running, expected }) => {
    const markup = renderCard({ subagentCount: count, subagentRunningCount: running });
    if (expected) {
      expect(markup).toContain(expected);
    } else {
      expect(markup).not.toContain("subagent");
    }
  });

  it("renders separate subdued parent context only for subagent threads", () => {
    expect(renderCard()).not.toContain("subagent of");

    const markup = renderCard({ parentThreadTitle: "Release coordinator" });
    expect(markup).toContain("subagent of Release coordinator");
    expect(markup).toContain('title="Release coordinator"');
    expect(markup).toContain("text-muted-foreground/60");
  });

  it.each([
    {
      statuses: ["completed", "completed"] as const,
      summary: "2 subagents completed",
    },
    { statuses: ["failed", "failed"] as const, summary: "2 subagents failed" },
    {
      statuses: ["completed", "failed"] as const,
      summary: "2 subagents settled · 1 completed · 1 failed",
    },
  ])("compacts $summary while retaining subagent details", ({ statuses, summary }) => {
    const subagentTree = statuses.map((status, index) => ({
      entry: makeWorkspaceAgentEntry({
        threadId: `hover-child-${index}` as never,
        threadTitle: `Child ${index + 1}`,
        status,
        activityState: { ...makeWorkspaceAgentEntry().activityState, phase: status },
      }),
      children: [],
    }));
    const markup = renderCard({
      subagentCount: subagentTree.length,
      subagentRunningCount: 0,
      subagentTree,
    });

    expect(markup).toContain(`<summary`);
    expect(markup).toContain(`${summary} · details`);
    expect(markup).toContain("Subagent activity details");
    expect(markup).toContain("Child 1");
    expect(markup).toContain("Child 2");
  });

  it("renders and truncates workspace context only when supplied", () => {
    expect(renderCard()).not.toContain("workspace:");

    const markup = renderCard({ worktreeLabel: "feature/a-very-long-authentication-branch" });
    expect(markup).toContain("workspace: feature/a-very-long-authentication-branch");
    expect(markup).toContain('title="workspace: feature/a-very-long-authentication-branch"');
    expect(markup).toContain("truncate");
  });

  it.each<{
    state: ThreadHoverCardPrState;
    colorClass: string;
    accessibleLabel: string;
  }>([
    { state: "open", colorClass: "text-status-open", accessibleLabel: "PR open" },
    { state: "draft", colorClass: "text-status-neutral", accessibleLabel: "PR draft" },
    {
      state: "conflicting",
      colorClass: "text-status-failure",
      accessibleLabel: "PR has conflicts",
    },
    { state: "merged", colorClass: "text-status-merged", accessibleLabel: "PR merged" },
    { state: "closed", colorClass: "text-status-neutral", accessibleLabel: "PR closed" },
  ])("renders the shared $state PR presentation", ({ state, colorClass, accessibleLabel }) => {
    const markup = renderCard({ prState: state, prTitle: "#22: fix release authentication" });

    expect(markup).toContain(`${accessibleLabel}: `);
    expect(markup).toContain("#22: fix release authentication");
    expect(markup).toContain('title="#22: fix release authentication"');
    expect(markup).toContain(colorClass);
  });

  it("omits an incomplete PR row when either PR field is absent", () => {
    expect(renderCard()).not.toContain("#22: fix release authentication");
    expect(renderCard({ prTitle: "#22: fix release authentication" })).not.toContain(
      "#22: fix release authentication",
    );
    expect(renderCard({ prState: "open" })).not.toContain("PR open");
  });

  it("always renders Open thread and only renders Interrupt when supplied", () => {
    const inactiveMarkup = renderCard();
    expect(inactiveMarkup).toContain('<button type="button"');
    expect(inactiveMarkup).toContain("Open thread");
    expect(inactiveMarkup).not.toContain("Interrupt");

    const activeMarkup = renderCard({ onInterrupt: vi.fn() });
    expect(activeMarkup).toContain("Open thread");
    expect(activeMarkup).toContain("Interrupt");
    expect(activeMarkup.match(/<button type="button"/g)).toHaveLength(2);
    expect(activeMarkup).toContain("text-destructive");
  });
});
