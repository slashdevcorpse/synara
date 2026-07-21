// FILE: ThreadHoverCard.tsx
// Purpose: Owns the interactive, lazy-mounted PreviewCard boundary around sidebar thread rows.
// Layer: Sidebar UI integration
// Exports: ThreadHoverCard and ThreadHoverCardFrame

import type { GitStatusResult, ThreadId } from "@synara/contracts";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";

import {
  isLiveAgentStatus,
  type AgentThreadEntry,
  type WorkspaceAgentThreadActivity,
  useWorkspaceAgentThreadActivity,
} from "../hooks/useWorkspaceAgentActivity";
import { formatRelativeTime } from "../lib/relativeTime";
import { formatProviderModelOptionName } from "../providerModelOptions";
import type { Project, SidebarThreadSummary } from "../types";
import { resolveThreadHoverCardWorkspaceLabel } from "./Sidebar.logic";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { createThreadHoverCardAnchor } from "./sidebarHoverCardAnchors";
import { ThreadHoverCardContent, type ThreadHoverCardPrState } from "./ThreadHoverCardContent";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { stopWorkspaceAgent } from "./workspace/WorkspaceAgentSection";

type ThreadHoverCardProject = Pick<Project, "folderName" | "name">;
type ThreadHoverCardPullRequest = NonNullable<GitStatusResult["pr"]>;

export type ThreadHoverCardFrameProps = {
  anchorId: string;
  trigger: ReactElement;
  children: ReactNode;
  renderContent: (close: () => void) => ReactNode;
};

/**
 * Shared trigger/popup frame. Content mounts when opening and stays mounted
 * through the exit transition, then unmounts so closed rows do not subscribe to
 * live telemetry or the 500 ms duration clock. PreviewCard is a pointer-only
 * enhancement: the underlying row remains keyboard navigable, and interruption
 * remains available through the workspace controls.
 */
export function ThreadHoverCardFrame({
  anchorId,
  trigger,
  children,
  renderContent,
}: ThreadHoverCardFrameProps) {
  const [open, setOpen] = useState(false);
  const [contentMounted, setContentMounted] = useState(false);
  const anchor = useMemo(() => createThreadHoverCardAnchor(anchorId), [anchorId]);
  const close = () => setOpen(false);

  return (
    <PreviewCard
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setContentMounted(true);
        setOpen(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => setContentMounted(nextOpen)}
    >
      <PreviewCardTrigger {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS} render={trigger}>
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        anchor={anchor}
        className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
      >
        {contentMounted ? renderContent(close) : null}
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function resolvePullRequestState(pullRequest: ThreadHoverCardPullRequest): ThreadHoverCardPrState {
  if (pullRequest.state !== "open") {
    return pullRequest.state;
  }
  if (pullRequest.isDraft) {
    return "draft";
  }
  return pullRequest.mergeability === "conflicting" ? "conflicting" : "open";
}

export function resolveThreadHoverCardModelLabel(
  modelSelection: SidebarThreadSummary["modelSelection"],
): string {
  return formatProviderModelOptionName({
    provider: modelSelection.provider,
    slug: modelSelection.model,
  });
}

export type ThreadHoverCardActivityContentProps = {
  thread: SidebarThreadSummary;
  project: ThreadHoverCardProject | null;
  pullRequest: ThreadHoverCardPullRequest | null;
  activity: WorkspaceAgentThreadActivity;
  close: () => void;
  onOpenThread: (threadId: ThreadId) => void;
  onInterruptEntry: (entry: AgentThreadEntry) => Promise<unknown>;
};

export function ThreadHoverCardActivityContent({
  thread,
  project,
  pullRequest,
  activity,
  close,
  onOpenThread,
  onInterruptEntry,
}: ThreadHoverCardActivityContentProps) {
  const entry = activity.entry;
  const parentEntry = activity.parentEntry;
  const provider =
    parentEntry?.providerKind ?? entry?.providerKind ?? thread.modelSelection.provider;
  const modelLabel = resolveThreadHoverCardModelLabel(thread.modelSelection);
  const interruptible =
    entry !== null && entry.turnId !== null && isLiveAgentStatus(entry.status) ? entry : null;
  const permissionMode = thread.interactionMode === "plan" ? "plan" : thread.runtimeMode;
  const worktreeLabel = resolveThreadHoverCardWorkspaceLabel({ thread, project });

  return (
    <ThreadHoverCardContent
      threadTitle={thread.title}
      timeLabel={formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
      provider={provider}
      modelLabel={modelLabel}
      parentThreadTitle={parentEntry?.threadTitle ?? null}
      status={entry?.status ?? "idle"}
      duration={entry?.duration ?? null}
      toolLabel={entry?.latestTool?.state === "running" ? entry.latestTool.name : null}
      permissionMode={permissionMode}
      subagentCount={activity.subagentCount}
      subagentRunningCount={activity.subagentRunningCount}
      subagentTree={activity.subagentTree}
      worktreeLabel={worktreeLabel}
      prTitle={pullRequest ? `#${pullRequest.number}: ${pullRequest.title}` : null}
      prState={pullRequest ? resolvePullRequestState(pullRequest) : null}
      onOpenThread={() => {
        close();
        onOpenThread(thread.id);
      }}
      onInterrupt={
        interruptible
          ? () => {
              close();
              void onInterruptEntry(interruptible).catch(() => undefined);
            }
          : null
      }
    />
  );
}

function ConnectedThreadHoverCardContent({
  thread,
  project,
  pullRequest,
  close,
  onOpenThread,
}: {
  thread: SidebarThreadSummary;
  project: ThreadHoverCardProject | null;
  pullRequest: ThreadHoverCardPullRequest | null;
  close: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const activity = useWorkspaceAgentThreadActivity(thread.id);

  return (
    <ThreadHoverCardActivityContent
      thread={thread}
      project={project}
      pullRequest={pullRequest}
      activity={activity}
      close={close}
      onOpenThread={onOpenThread}
      onInterruptEntry={stopWorkspaceAgent}
    />
  );
}

export type ThreadHoverCardProps = {
  anchorId: string;
  thread: SidebarThreadSummary;
  project: ThreadHoverCardProject | null;
  pullRequest: ThreadHoverCardPullRequest | null;
  trigger: ReactElement;
  children: ReactNode;
  onOpenThread: (threadId: ThreadId) => void;
};

export function ThreadHoverCard({
  anchorId,
  thread,
  project,
  pullRequest,
  trigger,
  children,
  onOpenThread,
}: ThreadHoverCardProps) {
  return (
    <ThreadHoverCardFrame
      anchorId={anchorId}
      trigger={trigger}
      renderContent={(close) => (
        <ConnectedThreadHoverCardContent
          thread={thread}
          project={project}
          pullRequest={pullRequest}
          close={close}
          onOpenThread={onOpenThread}
        />
      )}
    >
      {children}
    </ThreadHoverCardFrame>
  );
}
