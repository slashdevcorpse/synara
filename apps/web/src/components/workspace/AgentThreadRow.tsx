// FILE: AgentThreadRow.tsx
// Purpose: Compact workspace-wide agent row with separate navigation and action controls.
// Layer: Workspace agent sidebar presentation
// Exports: AgentThreadRow

import { PROVIDER_DISPLAY_NAMES, type ThreadId } from "@synara/contracts";
import { useId } from "react";

import { formatClockDuration } from "~/session-logic";
import { GitBranchIcon, LoaderIcon, StopIcon, XIcon } from "~/lib/icons";
import {
  subagentStatusDotClassName,
  subagentStatusTextToneClassName,
  type SubagentStatusKind,
} from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";

import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import {
  isLiveAgentStatus,
  type AgentStatus,
  type AgentThreadEntry,
} from "../../hooks/useWorkspaceAgentActivity";
import { AgentStreamPreview } from "./AgentStreamPreview";
import { AgentToolPreview } from "./AgentToolPreview";

export interface AgentThreadRowProps {
  entry: AgentThreadEntry;
  depth: number;
  onOpenThread: (threadId: ThreadId) => void;
  onStopThread: (entry: AgentThreadEntry) => Promise<void> | void;
  stopping?: boolean | undefined;
  onDismiss?: (() => void) | undefined;
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Idle",
  thinking: "Thinking",
  streaming: "Streaming",
  "tool-running": "Tool running",
  queued: "Queued",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

function coarseStatus(status: AgentStatus): SubagentStatusKind {
  switch (status) {
    case "thinking":
    case "streaming":
    case "tool-running":
      return "running";
    case "queued":
    case "completed":
    case "failed":
    case "stopped":
    case "idle":
      return status;
  }
}

export function AgentThreadRow({
  entry,
  depth,
  onOpenThread,
  onStopThread,
  stopping = false,
  onDismiss,
}: AgentThreadRowProps) {
  const descriptionId = useId();
  const interruptible = isLiveAgentStatus(entry.status) && entry.turnId !== null;
  const statusKind = coarseStatus(entry.status);
  const providerName = PROVIDER_DISPLAY_NAMES[entry.providerKind];
  const cappedDepth = Math.min(Math.max(0, depth), 6);
  const actionLabel = entry.subagentNickname ?? entry.threadTitle;
  const identityParts = [entry.subagentNickname, entry.subagentRole].filter(
    (value): value is string => value !== null,
  );
  const durationLabel = formatClockDuration(entry.duration);
  const accessibleDescription = [
    providerName,
    `model ${entry.modelLabel}`,
    entry.effortLabel ? `effort ${entry.effortLabel}` : null,
    identityParts.length > 0 ? identityParts.join(", ") : null,
    `status ${STATUS_LABEL[entry.status]}`,
    `duration ${durationLabel}`,
    entry.associatedWorktreeBranch ? `worktree ${entry.associatedWorktreeBranch}` : null,
    entry.latestTool
      ? `tool ${entry.latestTool.name} ${entry.latestTool.state === "running" ? "running" : "finished"}`
      : null,
    entry.streamPreview ? `latest response ${entry.streamPreview}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(". ");

  const stop = async () => {
    if (stopping) return;
    try {
      await onStopThread(entry);
    } catch {
      // The stateful section surfaces the failure and releases its pending key.
    }
  };

  return (
    <div
      data-testid="workspace-agent-thread-row"
      data-thread-id={entry.threadId}
      data-agent-depth={depth}
      data-agent-status={entry.status}
      className="group/thread-row relative flex min-w-0 items-stretch rounded-md transition-colors hover:bg-[var(--sidebar-accent)] focus-within:bg-[var(--sidebar-accent)]"
      style={{ paddingInlineStart: `${8 + cappedDepth * 12}px` }}
    >
      {depth > 0 ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-2 w-px bg-border/45"
          style={{ insetInlineStart: `${3 + (cappedDepth - 1) * 12}px` }}
        />
      ) : null}

      <button
        type="button"
        className="min-w-0 flex-1 rounded-md px-1.5 py-1 text-left outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`Open agent thread ${entry.threadTitle}`}
        aria-describedby={descriptionId}
        data-workspace-agent-open=""
        title={entry.threadTitle}
        onClick={() => onOpenThread(entry.threadId)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              subagentStatusDotClassName(statusKind),
              isLiveAgentStatus(entry.status) && "animate-pulse motion-reduce:animate-none",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/90">
            {entry.threadTitle}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">
            {durationLabel}
          </span>
        </span>

        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px]">
          <ProviderIcon provider={entry.providerKind} className="size-3.5 shrink-0" />
          <span className="sr-only">{providerName}: </span>
          <span className="min-w-0 truncate text-muted-foreground/60">
            {entry.modelLabel}
            {entry.effortLabel ? ` · ${entry.effortLabel}` : ""}
          </span>
          <span className={cn("ml-auto shrink-0", subagentStatusTextToneClassName(statusKind))}>
            {STATUS_LABEL[entry.status]}
          </span>
        </span>

        {identityParts.length > 0 || entry.associatedWorktreeBranch ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/55">
            {identityParts.length > 0 ? (
              <span className="min-w-0 truncate">{identityParts.join(" · ")}</span>
            ) : null}
            {entry.associatedWorktreeBranch ? (
              <span
                className="ml-auto flex min-w-0 shrink items-center gap-0.5 rounded bg-muted-foreground/8 px-1"
                title={entry.associatedWorktreeBranch}
              >
                <GitBranchIcon className="size-2.5 shrink-0" />
                <span className="min-w-0 truncate">{entry.associatedWorktreeBranch}</span>
              </span>
            ) : null}
          </span>
        ) : null}

        {entry.latestTool ? (
          <span className="mt-0.5 block min-w-0">
            <AgentToolPreview tool={entry.latestTool} />
          </span>
        ) : null}
        {entry.streamPreview ? (
          <span className="mt-0.5 block min-w-0">
            <AgentStreamPreview preview={entry.streamPreview} />
          </span>
        ) : null}
      </button>

      <span id={descriptionId} className="sr-only">
        {accessibleDescription}
      </span>

      {interruptible ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-chip"
          disabled={stopping}
          className="my-1 mr-1 self-start opacity-100 transition-opacity md:opacity-0 md:group-hover/thread-row:opacity-100 md:group-focus-within/thread-row:opacity-100"
          aria-label={stopping ? `Stopping ${actionLabel}` : `Stop ${actionLabel}`}
          title={stopping ? `Stopping ${actionLabel}` : `Stop ${actionLabel}`}
          onClick={() => void stop()}
        >
          {stopping ? (
            <LoaderIcon className="size-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <StopIcon className="size-3" />
          )}
        </Button>
      ) : onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-chip"
          className="my-1 mr-1 self-start opacity-100 transition-opacity md:opacity-0 md:group-hover/thread-row:opacity-100 md:group-focus-within/thread-row:opacity-100"
          aria-label={`Dismiss ${actionLabel}`}
          title={`Dismiss ${actionLabel}`}
          onClick={(event) => {
            const item = event.currentTarget.closest("li");
            const sibling =
              item?.previousElementSibling?.querySelector<HTMLButtonElement>(
                "[data-workspace-agent-open]",
              ) ??
              item?.nextElementSibling?.querySelector<HTMLButtonElement>(
                "[data-workspace-agent-open]",
              );
            const parent = item?.parentElement
              ?.closest("li")
              ?.querySelector<HTMLButtonElement>("[data-workspace-agent-open]");
            const projectToggle = item
              ?.closest("section")
              ?.querySelector<HTMLButtonElement>("[data-workspace-agent-project-toggle]");
            (sibling ?? parent ?? projectToggle)?.focus();
            onDismiss();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}
