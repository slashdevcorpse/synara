// FILE: ThreadHoverCardContent.tsx
// Purpose: Pure rich-content view for a sidebar thread hover card: thread/model
//          identity, live agent state, permissions, workspace/PR context, and actions.
// Layer: Sidebar UI component
// Exports: ThreadHoverCardContent, its props, and its public presentation unions.
// Why: Pinned and nested thread rows share one presentation while their connected
//      wrappers retain ownership of store reads, navigation, and interruption.

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { useId, useState, type MouseEvent, type ReactNode } from "react";

import { formatClockDuration } from "~/session-logic";
import {
  agentStatusPresentation,
  agentStatusToSubagentStatusKind,
} from "~/lib/agentStatusPresentation";
import { ArrowRightIcon, StopIcon, WorktreeIcon } from "~/lib/icons";
import { summarizeSettledSubagents } from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import {
  isLiveAgentStatus,
  type AgentStatus,
  type AgentThreadTreeNode,
} from "~/lib/workspaceAgentActivity";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequest/pullRequestStatePresentation";
import { ProviderIcon } from "./ProviderIcon";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import {
  SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME,
  SIDEBAR_HOVER_CARD_ROW_CLASS_NAME,
} from "./sidebarHoverCardStyles";

export type ThreadHoverCardPermissionMode = "full-access" | "approval-required" | "plan";

export type ThreadHoverCardPrState = "open" | "draft" | "conflicting" | "merged" | "closed";

export type ThreadHoverCardContentProps = {
  threadTitle: string;
  timeLabel: string | null;
  provider: ProviderKind;
  modelLabel: string;
  parentThreadTitle: string | null;
  status: AgentStatus;
  duration: number | null;
  toolLabel: string | null;
  permissionMode: ThreadHoverCardPermissionMode;
  subagentCount: number;
  subagentRunningCount: number;
  subagentTree?: readonly AgentThreadTreeNode[];
  worktreeLabel: string | null;
  prTitle: string | null;
  prState: ThreadHoverCardPrState | null;
  onOpenThread: () => void;
  onInterrupt: (() => void) | null;
};

const ROW_CLASS_NAME = SIDEBAR_HOVER_CARD_ROW_CLASS_NAME;
const META_ROW_CLASS_NAME = cn(ROW_CLASS_NAME, "text-foreground/80");
const META_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";
const DIVIDER_CLASS_NAME = "-mx-0.5 my-0.5 h-px bg-[color:var(--color-border)]";

const PR_INPUT_BY_STATE = {
  open: { state: "open" },
  draft: { state: "open", isDraft: true },
  conflicting: { state: "open", mergeability: "conflicting" },
  merged: { state: "merged" },
  closed: { state: "closed" },
} as const;

function formatStatusCopy(
  status: AgentStatus,
  duration: number | null,
  toolLabel: string | null,
): string {
  const durationLabel = duration === null ? null : formatClockDuration(duration);
  switch (status) {
    case "thinking":
      return durationLabel ? `thinking · ${durationLabel}` : "thinking";
    case "streaming":
      return durationLabel ? `streaming · ${durationLabel}` : "streaming";
    case "tool-running": {
      const toolCopy = toolLabel ? `tool: ${toolLabel}` : "tool-running";
      return durationLabel ? `${toolCopy} · ${durationLabel}` : toolCopy;
    }
    case "completed":
      return durationLabel ? `completed · ${durationLabel} total` : "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "queued":
      return "queued";
    case "connecting":
      return "connecting";
    case "idle":
      return "idle";
  }
}

function formatSubagentCount(count: number, runningCount: number): string | null {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return null;

  const safeRunningCount = Math.min(safeCount, Math.max(0, Math.floor(runningCount)));
  const noun = safeCount === 1 ? "subagent" : "subagents";
  return safeRunningCount > 0
    ? `${safeRunningCount} of ${safeCount} ${noun} running`
    : `${safeCount} ${noun}`;
}

function invokeAction(event: MouseEvent<HTMLButtonElement>, callback: () => void) {
  event.preventDefault();
  event.stopPropagation();
  callback();
}

function Divider() {
  return <div className={DIVIDER_CLASS_NAME} aria-hidden />;
}

function TruncatedRow({
  icon,
  children,
  title,
}: {
  icon: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <div className={META_ROW_CLASS_NAME}>
      {icon}
      <span className="min-w-0 truncate" title={title}>
        {children}
      </span>
    </div>
  );
}

export function ThreadHoverCardContent({
  threadTitle,
  timeLabel,
  provider,
  modelLabel,
  parentThreadTitle,
  status,
  duration,
  toolLabel,
  permissionMode,
  subagentCount,
  subagentRunningCount,
  subagentTree = [],
  worktreeLabel,
  prTitle,
  prState,
  onOpenThread,
  onInterrupt,
}: ThreadHoverCardContentProps) {
  const providerName = PROVIDER_DISPLAY_NAMES[provider];
  const statusPresentation = agentStatusPresentation(status);
  const statusCopy = formatStatusCopy(status, duration, toolLabel);
  const settledSubagentSummary = summarizeSettledSubagents(
    flattenSubagentStatuses(subagentTree).map(agentStatusToSubagentStatusKind),
  );
  const subagentCopy =
    settledSubagentSummary?.label ?? formatSubagentCount(subagentCount, subagentRunningCount);
  const hasContext = worktreeLabel !== null || (prTitle !== null && prState !== null);
  const prPresentation = prState ? resolvePrStatePresentation(PR_INPUT_BY_STATE[prState]) : null;
  const PrIcon = prPresentation ? PR_STATE_PRESENTATION_ICONS[prPresentation.iconKind] : null;
  const subagentDetailsId = useId();
  const [subagentDetailsOpen, setSubagentDetailsOpen] = useState(false);

  return (
    <div
      className={cn("flex w-full flex-col gap-0", SIDEBAR_HOVER_CARD_CONTAINER_PADDING_CLASS_NAME)}
    >
      <div className={ROW_CLASS_NAME}>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={threadTitle}>
          {threadTitle}
        </span>
        {timeLabel ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">
            {timeLabel}
          </span>
        ) : null}
      </div>

      <div className={META_ROW_CLASS_NAME}>
        <ProviderIcon provider={provider} className="size-4 shrink-0" />
        <span className="sr-only">{providerName}: </span>
        <span className="min-w-0 truncate" title={modelLabel}>
          {modelLabel}
        </span>
      </div>

      {subagentTree.length > 0 ? (
        settledSubagentSummary ? (
          <div className="mt-1 text-[10px] text-muted-foreground/68">
            <button
              type="button"
              className="flex w-full cursor-pointer select-none items-center rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-expanded={subagentDetailsOpen}
              aria-controls={subagentDetailsId}
              onClick={(event) =>
                invokeAction(event, () => setSubagentDetailsOpen((open) => !open))
              }
            >
              <span className="min-w-0 flex-1 truncate">
                {settledSubagentSummary.label} · details
              </span>
              <DisclosureChevron open={subagentDetailsOpen} className="size-3 shrink-0" />
            </button>
            <div id={subagentDetailsId}>
              <DisclosureRegion open={subagentDetailsOpen}>
                <ul className="mt-1 space-y-1" aria-label="Subagent activity details">
                  {subagentTree.map((node) => (
                    <SubagentActivityTreeRow key={node.entry.threadId} node={node} depth={0} />
                  ))}
                </ul>
              </DisclosureRegion>
            </div>
          </div>
        ) : (
          <ul className="mt-1 space-y-1" aria-label="Subagent activity">
            {subagentTree.map((node) => (
              <SubagentActivityTreeRow key={node.entry.threadId} node={node} depth={0} />
            ))}
          </ul>
        )
      ) : null}

      {parentThreadTitle ? (
        <div className={cn(ROW_CLASS_NAME, "pl-5.5 text-muted-foreground/60")}>
          <span className="min-w-0 truncate" title={parentThreadTitle}>
            subagent of {parentThreadTitle}
          </span>
        </div>
      ) : null}

      <div className={META_ROW_CLASS_NAME}>
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            statusPresentation.dotClassName,
            isLiveAgentStatus(status) && "animate-pulse motion-reduce:animate-none",
          )}
        />
        <span
          className={cn("min-w-0 truncate", statusPresentation.textClassName)}
          title={statusCopy}
        >
          {statusCopy}
        </span>
      </div>

      <div className={META_ROW_CLASS_NAME}>
        <span className="min-w-0 truncate">
          {permissionMode}
          {subagentCopy ? ` · ${subagentCopy}` : ""}
        </span>
      </div>

      {hasContext ? <Divider /> : null}

      {worktreeLabel ? (
        <TruncatedRow
          icon={<WorktreeIcon className={META_ICON_CLASS_NAME} aria-hidden />}
          title={`workspace: ${worktreeLabel}`}
        >
          workspace: {worktreeLabel}
        </TruncatedRow>
      ) : null}

      {prTitle && prState && prPresentation && PrIcon ? (
        <div className={META_ROW_CLASS_NAME}>
          <PrIcon aria-hidden className={cn("size-3.5 shrink-0", prPresentation.colorClass)} />
          <span className="sr-only">{prPresentation.label}: </span>
          <span className="min-w-0 truncate" title={prTitle}>
            {prTitle}
          </span>
        </div>
      ) : null}

      <Divider />

      <button
        type="button"
        onClick={(event) => invokeAction(event, onOpenThread)}
        className={cn(
          ROW_CLASS_NAME,
          "cursor-pointer text-left text-foreground/80 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        )}
      >
        <span className="min-w-0 truncate">Open thread</span>
        <ArrowRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {onInterrupt ? (
        <button
          type="button"
          onClick={(event) => invokeAction(event, onInterrupt)}
          className={cn(
            ROW_CLASS_NAME,
            "cursor-pointer text-left text-destructive transition-colors hover:bg-destructive/8",
          )}
        >
          <StopIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">Interrupt</span>
        </button>
      ) : null}
    </div>
  );
}

function flattenSubagentStatuses(nodes: readonly AgentThreadTreeNode[]): AgentStatus[] {
  return nodes.flatMap((node) => [node.entry.status, ...flattenSubagentStatuses(node.children)]);
}

function SubagentActivityTreeRow({ node, depth }: { node: AgentThreadTreeNode; depth: number }) {
  const { entry } = node;
  const statusPresentation = agentStatusPresentation(entry.status);
  const label = entry.subagentNickname ?? entry.threadTitle;
  const role = entry.subagentRole ? ` · ${entry.subagentRole}` : "";
  const tool = entry.latestTool?.state === "running" ? ` · ${entry.latestTool.name}` : "";
  return (
    <li>
      <div
        className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/68"
        style={{ paddingLeft: Math.min(depth, 2) * 10 }}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            statusPresentation.dotClassName,
            isLiveAgentStatus(entry.status) && "animate-pulse motion-reduce:animate-none",
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={`${label}${role}${tool}`}>
          {label}
          {role}
          {tool}
        </span>
        <span className={cn("shrink-0", statusPresentation.textClassName)}>
          {statusPresentation.label}
        </span>
      </div>
      {node.children.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {node.children.map((child) => (
            <SubagentActivityTreeRow key={child.entry.threadId} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
