// FILE: WorkspaceAgentPanel.tsx
// Purpose: Workspace-wide, project-grouped agent activity panel for the shared sidebar.
// Layer: Workspace agent sidebar presentation
// Exports: WorkspaceAgentPanel

import type { ThreadId } from "@synara/contracts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../../sidebarRowStyles";
import { BotIcon, LoaderIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { FolderClosed } from "../FolderClosed";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Button } from "../ui/button";
import {
  isLiveAgentStatus,
  type AgentProjectGroup,
  type AgentThreadEntry,
  type AgentThreadTreeNode,
  type WorkspaceAgentActivity,
  type WorkspaceAgentSummary,
} from "../../hooks/useWorkspaceAgentActivity";
import { AgentThreadRow } from "./AgentThreadRow";

export interface WorkspaceAgentPanelProps {
  activity: WorkspaceAgentActivity;
  terminalProcessCount?: number;
  onOpenThread: (threadId: ThreadId) => void;
  onStopThread: (entry: AgentThreadEntry) => Promise<WorkspaceAgentStopResult>;
  onStopAll: (entries: AgentThreadEntry[]) => Promise<WorkspaceAgentStopAllResult>;
  onStartChat?: () => void;
  onStartTerminalWorkstream?: () => void;
}

const INTERRUPT_PENDING_RELEASE_MS = 15_000;

interface PendingInterrupt {
  durationAtDispatch: number;
  releaseAt: number;
}

export type WorkspaceAgentStopResult = "dispatched" | "not-running";

export interface WorkspaceAgentStopAllResult {
  attemptedThreadIds: ThreadId[];
  dispatchedThreadIds: ThreadId[];
  skippedThreadIds: ThreadId[];
  failures: Array<{ threadId: ThreadId; reason: unknown }>;
}

function terminalLeafDismissalKey(entry: AgentThreadEntry): string {
  return `${entry.threadId}:terminal`;
}

function interruptPendingKey(entry: AgentThreadEntry): string {
  return `${entry.threadId}:${entry.turnId ?? "active"}`;
}

function pendingInterrupt(entry: AgentThreadEntry): PendingInterrupt {
  return {
    durationAtDispatch: entry.duration,
    releaseAt: Date.now() + INTERRUPT_PENDING_RELEASE_MS,
  };
}

function isTerminalStatus(entry: AgentThreadEntry): boolean {
  return entry.status === "completed" || entry.status === "failed" || entry.status === "stopped";
}

function collectTerminalLeafKeys(
  nodes: ReadonlyArray<AgentThreadTreeNode>,
  keys = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    if (node.children.length === 0 && isTerminalStatus(node.entry)) {
      keys.add(terminalLeafDismissalKey(node.entry));
    }
    collectTerminalLeafKeys(node.children, keys);
  }
  return keys;
}

function filterDismissedNodes(
  nodes: ReadonlyArray<AgentThreadTreeNode>,
  dismissed: ReadonlySet<string>,
): AgentThreadTreeNode[] {
  return nodes.flatMap((node) => {
    if (
      node.children.length === 0 &&
      isTerminalStatus(node.entry) &&
      dismissed.has(terminalLeafDismissalKey(node.entry))
    ) {
      return [];
    }
    return [{ ...node, children: filterDismissedNodes(node.children, dismissed) }];
  });
}

function countTreeNodes(nodes: ReadonlyArray<AgentThreadTreeNode>): number {
  return nodes.reduce((total, node) => total + 1 + countTreeNodes(node.children), 0);
}

function liveCount(summary: WorkspaceAgentSummary): number {
  return summary.running + summary.queued;
}

function summaryLabel(summary: WorkspaceAgentSummary, visibleCount = summary.total): string {
  if (summary.running > 0) {
    return `${summary.running} active${summary.queued > 0 ? ` · ${summary.queued} queued` : ""}`;
  }
  if (summary.queued > 0) {
    return `${summary.queued} queued`;
  }
  if (visibleCount > 0) {
    return `${visibleCount} recent`;
  }
  return "No activity";
}

function aggregateSummaryLabel(
  summary: WorkspaceAgentSummary,
  latestLiveEntry: AgentThreadEntry | undefined,
  visibleCount: number,
): string {
  if (summary.running > 0) {
    return [
      `${summary.running} active`,
      latestLiveEntry?.threadTitle,
      summary.queued > 0 ? `${summary.queued} queued` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  }
  if (summary.queued > 0) {
    return `${summary.queued} queued`;
  }
  return visibleCount > 0 ? `${visibleCount} recent` : "No active agents";
}

function AgentTree({
  nodes,
  depth,
  dismissibleTerminalKeys,
  onOpenThread,
  onStopThread,
  pendingStopKeys,
  onDismiss,
}: {
  nodes: ReadonlyArray<AgentThreadTreeNode>;
  depth: number;
  dismissibleTerminalKeys: ReadonlySet<string>;
  onOpenThread: (threadId: ThreadId) => void;
  onStopThread: (entry: AgentThreadEntry) => Promise<void> | void;
  pendingStopKeys: ReadonlySet<string>;
  onDismiss: (entry: AgentThreadEntry) => void;
}) {
  return (
    <ul className="min-w-0" aria-label={depth === 0 ? "Agent threads" : undefined}>
      {nodes.map((node) => {
        const canDismiss = dismissibleTerminalKeys.has(terminalLeafDismissalKey(node.entry));
        return (
          <li key={node.entry.threadId} className="min-w-0">
            <AgentThreadRow
              entry={node.entry}
              depth={depth}
              onOpenThread={onOpenThread}
              onStopThread={onStopThread}
              stopping={pendingStopKeys.has(interruptPendingKey(node.entry))}
              onDismiss={canDismiss ? () => onDismiss(node.entry) : undefined}
            />
            {node.children.length > 0 ? (
              <AgentTree
                nodes={node.children}
                depth={depth + 1}
                dismissibleTerminalKeys={dismissibleTerminalKeys}
                onOpenThread={onOpenThread}
                onStopThread={onStopThread}
                pendingStopKeys={pendingStopKeys}
                onDismiss={onDismiss}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function AgentProjectSection({
  group,
  dismissibleTerminalKeys,
  onOpenThread,
  onStopThread,
  pendingStopKeys,
  onDismiss,
}: {
  group: AgentProjectGroup;
  dismissibleTerminalKeys: ReadonlySet<string>;
  onOpenThread: (threadId: ThreadId) => void;
  onStopThread: (entry: AgentThreadEntry) => Promise<void> | void;
  pendingStopKeys: ReadonlySet<string>;
  onDismiss: (entry: AgentThreadEntry) => void;
}) {
  const regionId = useId();
  const summaryId = useId();
  const groupWorkCount = liveCount(group.summary);
  const groupRunningCount = group.summary.running;
  const previousWorkCount = useRef(groupWorkCount);
  const previousRunningCount = useRef(groupRunningCount);
  const [open, setOpen] = useState(true);
  const visibleCount = countTreeNodes(group.nodes);

  useEffect(() => {
    if (
      (previousWorkCount.current === 0 && groupWorkCount > 0) ||
      (previousRunningCount.current === 0 && groupRunningCount > 0)
    ) {
      setOpen(true);
    }
    previousWorkCount.current = groupWorkCount;
    previousRunningCount.current = groupRunningCount;
  }, [groupRunningCount, groupWorkCount]);

  return (
    <section data-testid="workspace-agent-project" className="min-w-0">
      <button
        type="button"
        className={cn(
          SIDEBAR_HEADER_ROW_CLASS_NAME,
          SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
          SIDEBAR_ROW_HOVER_CLASS_NAME,
          "pr-1.5",
        )}
        aria-expanded={open}
        aria-controls={regionId}
        aria-describedby={summaryId}
        aria-label={`${open ? "Collapse" : "Expand"} ${group.projectTitle} agents`}
        data-workspace-agent-project-toggle=""
        title={group.projectCwd}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/65" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
          {group.projectTitle}
        </span>
        <span id={summaryId} className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
          {summaryLabel(group.summary, visibleCount)}
        </span>
        <DisclosureChevron open={open} className="size-3 text-muted-foreground/55" />
      </button>

      <div id={regionId}>
        <DisclosureRegion open={open}>
          <AgentTree
            nodes={group.nodes}
            depth={0}
            dismissibleTerminalKeys={dismissibleTerminalKeys}
            onOpenThread={onOpenThread}
            onStopThread={onStopThread}
            pendingStopKeys={pendingStopKeys}
            onDismiss={onDismiss}
          />
        </DisclosureRegion>
      </div>
    </section>
  );
}

export function WorkspaceAgentPanel({
  activity,
  terminalProcessCount = 0,
  onOpenThread,
  onStopThread,
  onStopAll,
  onStartChat,
  onStartTerminalWorkstream,
}: WorkspaceAgentPanelProps) {
  const regionId = useId();
  const aggregateSummaryId = useId();
  const currentWorkCount = liveCount(activity.summary);
  const currentRunningCount = activity.summary.running;
  const previousWorkCount = useRef(currentWorkCount);
  const previousRunningCount = useRef(currentRunningCount);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const lastFocusedBodyElementRef = useRef<HTMLElement | null>(null);
  const lastFocusedHeaderActionRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(currentWorkCount > 0);
  const [pendingInterrupts, setPendingInterrupts] = useState<ReadonlyMap<string, PendingInterrupt>>(
    () => new Map(),
  );
  const [dismissedTerminalKeys, setDismissedTerminalKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const interruptibleEntries = useMemo(
    () =>
      activity.threads.filter((entry) => isLiveAgentStatus(entry.status) && entry.turnId !== null),
    [activity.threads],
  );
  const interruptibleEntriesByKey = useMemo(
    () => new Map(interruptibleEntries.map((entry) => [interruptPendingKey(entry), entry])),
    [interruptibleEntries],
  );
  const dismissibleTerminalKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const group of activity.groups) {
      collectTerminalLeafKeys(group.nodes, keys);
    }
    return keys;
  }, [activity.groups]);

  useLayoutEffect(() => {
    const bodyElement = lastFocusedBodyElementRef.current;
    const headerElement = lastFocusedHeaderActionRef.current;
    const bodyFocusWasRemoved = bodyElement !== null && !bodyElement.isConnected;
    const headerFocusWasRemoved = headerElement !== null && !headerElement.isConnected;
    if (!bodyFocusWasRemoved && !headerFocusWasRemoved) return;

    const activeElement = document.activeElement;
    if (activeElement === null || activeElement === document.body || !activeElement.isConnected) {
      panelToggleRef.current?.focus();
    }
    if (bodyFocusWasRemoved) lastFocusedBodyElementRef.current = null;
    if (headerFocusWasRemoved) lastFocusedHeaderActionRef.current = null;
  });

  useEffect(() => {
    if (
      (previousWorkCount.current === 0 && currentWorkCount > 0) ||
      (previousRunningCount.current === 0 && currentRunningCount > 0)
    ) {
      setOpen(true);
    } else if (previousWorkCount.current > 0 && currentWorkCount === 0) {
      const lastFocusedBodyElement = lastFocusedBodyElementRef.current;
      const lastFocusedHeaderAction = lastFocusedHeaderActionRef.current;
      const activeElement = document.activeElement;
      if (
        panelBodyRef.current?.contains(activeElement) ||
        ((lastFocusedBodyElement !== null || lastFocusedHeaderAction !== null) &&
          activeElement === document.body)
      ) {
        panelToggleRef.current?.focus();
      }
      lastFocusedBodyElementRef.current = null;
      lastFocusedHeaderActionRef.current = null;
      setOpen(false);
    }
    previousRunningCount.current = currentRunningCount;
    previousWorkCount.current = currentWorkCount;
  }, [currentRunningCount, currentWorkCount]);

  useEffect(() => {
    setDismissedTerminalKeys((current) => {
      const next = new Set([...current].filter((key) => dismissibleTerminalKeys.has(key)));
      if (next.size === current.size && [...next].every((key) => current.has(key))) {
        return current;
      }
      return next;
    });
  }, [dismissibleTerminalKeys]);

  useEffect(() => {
    setPendingInterrupts((current) => {
      const next = new Map<string, PendingInterrupt>();
      for (const [key, pending] of current) {
        const entry = interruptibleEntriesByKey.get(key);
        if (
          entry &&
          entry.duration - pending.durationAtDispatch < INTERRUPT_PENDING_RELEASE_MS &&
          Date.now() < pending.releaseAt
        ) {
          next.set(key, pending);
        }
      }
      if (next.size === current.size && [...next.keys()].every((key) => current.has(key))) {
        return current;
      }
      return next;
    });
  }, [interruptibleEntriesByKey]);

  const visibleGroups = useMemo(
    () =>
      activity.groups
        .map((group) => ({
          ...group,
          nodes: filterDismissedNodes(group.nodes, dismissedTerminalKeys),
        }))
        .filter((group) => group.nodes.length > 0),
    [activity.groups, dismissedTerminalKeys],
  );
  const latestLiveEntry = interruptibleEntries.toSorted(
    (left, right) => right.lastActivityAt - left.lastActivityAt,
  )[0];
  const visibleThreadCount = visibleGroups.reduce(
    (total, group) => total + countTreeNodes(group.nodes),
    0,
  );
  const baseAggregateLabel = aggregateSummaryLabel(
    activity.summary,
    latestLiveEntry,
    visibleThreadCount,
  );
  const mainAgentCount = activity.threads.filter((entry) => !entry.isSubagent).length;
  const subagentCount = activity.threads.filter((entry) => entry.isSubagent).length;
  const subagentRunningCount = activity.threads.filter(
    (entry) => entry.isSubagent && isLiveAgentStatus(entry.status),
  ).length;
  const aggregateLabel = [
    baseAggregateLabel,
    `${mainAgentCount} ${mainAgentCount === 1 ? "agent" : "agents"}`,
    `${subagentCount} subagents (${subagentRunningCount} running)`,
    `${terminalProcessCount} terminal ${terminalProcessCount === 1 ? "process" : "processes"}`,
  ].join(" · ");

  const stoppableEntries = interruptibleEntries.filter(
    (entry) => !pendingInterrupts.has(interruptPendingKey(entry)),
  );
  const pendingStopKeys = useMemo(() => new Set(pendingInterrupts.keys()), [pendingInterrupts]);

  const stopEntry = async (entry: AgentThreadEntry) => {
    const key = interruptPendingKey(entry);
    setPendingInterrupts((current) => new Map(current).set(key, pendingInterrupt(entry)));
    try {
      const result = await onStopThread(entry);
      if (result === "not-running") {
        setPendingInterrupts((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      }
    } catch {
      setPendingInterrupts((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
  };

  const stopAll = async () => {
    if (stoppableEntries.length === 0) return;
    const keys = stoppableEntries.map(interruptPendingKey);
    setPendingInterrupts((current) => {
      const next = new Map(current);
      stoppableEntries.forEach((entry, index) => {
        next.set(keys[index]!, pendingInterrupt(entry));
      });
      return next;
    });
    try {
      const result = await onStopAll(stoppableEntries);
      const dispatchedThreadIds = new Set(result.dispatchedThreadIds);
      setPendingInterrupts((current) => {
        const next = new Map(current);
        stoppableEntries.forEach((entry, index) => {
          if (!dispatchedThreadIds.has(entry.threadId)) {
            next.delete(keys[index]!);
          }
        });
        return next;
      });
    } catch {
      setPendingInterrupts((current) => {
        const next = new Map(current);
        keys.forEach((key) => next.delete(key));
        return next;
      });
    }
  };

  const dismissEntry = (entry: AgentThreadEntry) => {
    setDismissedTerminalKeys((current) => {
      const next = new Set(current);
      next.add(terminalLeafDismissalKey(entry));
      return next;
    });
  };

  return (
    <section
      data-testid="workspace-agent-panel"
      aria-label="Workspace agents"
      className="min-w-0 px-1.5 pt-1 pb-2 font-system-ui"
    >
      <div className="group/project-header relative">
        <button
          ref={panelToggleRef}
          type="button"
          className={cn(
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            interruptibleEntries.length > 0 ? "pr-9" : "pr-2",
          )}
          aria-expanded={open}
          aria-controls={regionId}
          aria-describedby={aggregateSummaryId}
          aria-label={`${open ? "Collapse" : "Expand"} workspace agents`}
          onClick={() => setOpen((current) => !current)}
        >
          <BotIcon className="size-3.5 shrink-0 text-muted-foreground/65" />
          <span className="shrink-0 text-[12px] text-foreground/85">Agents</span>
          <DisclosureChevron open={open} className="size-3 shrink-0 text-muted-foreground/55" />
          <span
            aria-hidden="true"
            className="min-w-0 flex-1 truncate text-[10px] tabular-nums text-muted-foreground/55"
          >
            {aggregateLabel}
          </span>
        </button>

        <span id={aggregateSummaryId} aria-live="polite" aria-atomic="true" className="sr-only">
          {aggregateLabel}
        </span>

        {interruptibleEntries.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-chip"
            disabled={stoppableEntries.length === 0}
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
            aria-label={stoppableEntries.length === 0 ? "Stopping all agents" : "Stop all agents"}
            title={stoppableEntries.length === 0 ? "Stopping all agents" : "Stop all agents"}
            onFocus={(event) => {
              lastFocusedHeaderActionRef.current = event.currentTarget;
            }}
            onClick={() => void stopAll()}
          >
            {stoppableEntries.length === 0 ? (
              <LoaderIcon className="size-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <StopIcon className="size-3" />
            )}
          </Button>
        ) : null}
      </div>

      <div id={regionId}>
        <DisclosureRegion open={open} className="pt-1">
          <div
            ref={panelBodyRef}
            data-testid="workspace-agent-panel-body"
            className="min-w-0 space-y-1"
            onFocusCapture={(event) => {
              if (event.target instanceof HTMLElement) {
                lastFocusedBodyElementRef.current = event.target;
              }
            }}
          >
            {visibleGroups.length > 0 ? (
              visibleGroups.map((group) => (
                <AgentProjectSection
                  key={group.projectId}
                  group={group}
                  dismissibleTerminalKeys={dismissibleTerminalKeys}
                  onOpenThread={onOpenThread}
                  onStopThread={stopEntry}
                  pendingStopKeys={pendingStopKeys}
                  onDismiss={dismissEntry}
                />
              ))
            ) : (
              <div className="space-y-2 px-2 py-2 text-[11px] text-muted-foreground/58">
                <p>No active agents.</p>
                {onStartChat || onStartTerminalWorkstream ? (
                  <div className="flex flex-wrap gap-1.5">
                    {onStartChat ? (
                      <Button type="button" variant="ghost" size="xs" onClick={onStartChat}>
                        Start a chat
                      </Button>
                    ) : null}
                    {onStartTerminalWorkstream ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={onStartTerminalWorkstream}
                      >
                        New terminal workstream
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </DisclosureRegion>
      </div>
    </section>
  );
}
