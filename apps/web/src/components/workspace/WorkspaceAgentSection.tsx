// FILE: WorkspaceAgentSection.tsx
// Purpose: Isolates workspace activity ticks and safe interruption dispatch from the large Sidebar.
// Layer: Workspace agent sidebar integration
// Exports: WorkspaceAgentSection and focused interruption helpers

import type { ClientOrchestrationCommand, CommandId, ThreadId } from "@synara/contracts";
import { useCallback } from "react";

import {
  type AgentThreadEntry,
  useWorkspaceAgentActivity,
} from "../../hooks/useWorkspaceAgentActivity";
import { resolveWorkspaceAgentInterruptTurnId } from "../../lib/workspaceAgentActivity";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { getThreadFromState } from "../../threadDerivation";
import type { Thread } from "../../types";
import { newCommandId } from "../../lib/utils";
import { toastManager } from "../ui/toast";
import {
  WorkspaceAgentPanel,
  type WorkspaceAgentStopAllResult,
  type WorkspaceAgentStopResult,
} from "./WorkspaceAgentPanel";

type InterruptCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.interrupt" }>;

export const WORKSPACE_AGENT_INTERRUPT_CONCURRENCY = 8;

async function allSettledWithConcurrency<Input, Output>(
  inputs: ReadonlyArray<Input>,
  concurrency: number,
  task: (input: Input) => Promise<Output>,
): Promise<Array<PromiseSettledResult<Output>>> {
  const results = new Array<PromiseSettledResult<Output>>(inputs.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await task(inputs[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return results;
}

export interface WorkspaceAgentInterruptDependencies {
  getThread: (threadId: ThreadId) => WorkspaceAgentInterruptThreadView | undefined;
  dispatchCommand: (command: InterruptCommand) => Promise<unknown>;
  createCommandId: () => CommandId;
  nowIso: () => string;
}

export type WorkspaceAgentInterruptResult = WorkspaceAgentStopResult;

export type WorkspaceAgentInterruptThreadView = Pick<
  Thread,
  "session" | "parentThreadId" | "latestTurn"
> & { hasLiveTailWork: boolean };

export type WorkspaceAgentInterruptBatchResult = WorkspaceAgentStopAllResult;

export interface WorkspaceAgentActionDependencies {
  interrupt: (threadId: ThreadId) => Promise<WorkspaceAgentInterruptResult>;
  interruptBatch: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Promise<WorkspaceAgentInterruptBatchResult>;
  addErrorToast: (input: { title: string; description: string }) => void;
}

const DEFAULT_INTERRUPT_DEPENDENCIES: WorkspaceAgentInterruptDependencies = {
  getThread: (threadId) => {
    const state = useStore.getState();
    const thread = getThreadFromState(state, threadId);
    if (!thread) return undefined;
    return {
      session: thread.session,
      parentThreadId: thread.parentThreadId ?? null,
      latestTurn: thread.latestTurn,
      hasLiveTailWork: state.sidebarThreadSummaryById[threadId]?.hasLiveTailWork ?? false,
    };
  },
  dispatchCommand: (command) => ensureNativeApi().orchestration.dispatchCommand(command),
  createCommandId: newCommandId,
  nowIso: () => new Date().toISOString(),
};

export async function dispatchWorkspaceAgentInterrupt(
  threadId: ThreadId,
  dependencies: WorkspaceAgentInterruptDependencies = DEFAULT_INTERRUPT_DEPENDENCIES,
): Promise<WorkspaceAgentInterruptResult> {
  const thread = dependencies.getThread(threadId);
  if (!thread) {
    return "not-running";
  }
  const turnId = resolveWorkspaceAgentInterruptTurnId({
    threadId,
    parentThreadId: thread.parentThreadId ?? null,
    session:
      thread.session === null
        ? null
        : {
            status: thread.session.orchestrationStatus,
            activeTurnId: thread.session.activeTurnId ?? null,
          },
    latestTurn: thread.latestTurn,
    hasLiveTailWork: thread.hasLiveTailWork,
  });
  if (turnId === null) {
    return "not-running";
  }

  await dependencies.dispatchCommand({
    type: "thread.turn.interrupt",
    commandId: dependencies.createCommandId(),
    threadId,
    turnId,
    createdAt: dependencies.nowIso(),
  });
  return "dispatched";
}

export async function dispatchWorkspaceAgentInterruptBatch(
  threadIds: ReadonlyArray<ThreadId>,
  dependencies: WorkspaceAgentInterruptDependencies = DEFAULT_INTERRUPT_DEPENDENCIES,
): Promise<WorkspaceAgentInterruptBatchResult> {
  const attemptedThreadIds = [...new Set(threadIds)];
  const settled = await allSettledWithConcurrency(
    attemptedThreadIds,
    WORKSPACE_AGENT_INTERRUPT_CONCURRENCY,
    (threadId) => dispatchWorkspaceAgentInterrupt(threadId, dependencies),
  );
  const dispatchedThreadIds: ThreadId[] = [];
  const skippedThreadIds: ThreadId[] = [];
  const failures: Array<{ threadId: ThreadId; reason: unknown }> = [];

  settled.forEach((result, index) => {
    const threadId = attemptedThreadIds[index]!;
    if (result.status === "rejected") {
      failures.push({ threadId, reason: result.reason });
    } else if (result.value === "dispatched") {
      dispatchedThreadIds.push(threadId);
    } else {
      skippedThreadIds.push(threadId);
    }
  });

  return {
    attemptedThreadIds,
    dispatchedThreadIds,
    skippedThreadIds,
    failures,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

const DEFAULT_ACTION_DEPENDENCIES: WorkspaceAgentActionDependencies = {
  interrupt: (threadId) => dispatchWorkspaceAgentInterrupt(threadId),
  interruptBatch: (threadIds) => dispatchWorkspaceAgentInterruptBatch(threadIds),
  addErrorToast: ({ title, description }) => {
    toastManager.add({ type: "error", title, description });
  },
};

export async function stopWorkspaceAgent(
  entry: AgentThreadEntry,
  dependencies: WorkspaceAgentActionDependencies = DEFAULT_ACTION_DEPENDENCIES,
): Promise<WorkspaceAgentInterruptResult> {
  try {
    return await dependencies.interrupt(entry.threadId);
  } catch (error) {
    dependencies.addErrorToast({
      title: "Unable to stop agent",
      description: `${entry.threadTitle}: ${errorMessage(error)}`,
    });
    throw error;
  }
}

export async function stopAllWorkspaceAgents(
  entries: ReadonlyArray<AgentThreadEntry>,
  dependencies: WorkspaceAgentActionDependencies = DEFAULT_ACTION_DEPENDENCIES,
): Promise<WorkspaceAgentInterruptBatchResult> {
  const result = await dependencies.interruptBatch(entries.map((entry) => entry.threadId));
  if (result.failures.length > 0) {
    dependencies.addErrorToast({
      title: "Some agents could not be stopped",
      description: `${result.failures.length} of ${result.attemptedThreadIds.length} stop requests failed.`,
    });
  }
  return result;
}

export function WorkspaceAgentSection({
  onOpenThread,
}: {
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const activity = useWorkspaceAgentActivity();

  const stopThread = useCallback((entry: AgentThreadEntry) => stopWorkspaceAgent(entry), []);
  const stopAll = useCallback((entries: AgentThreadEntry[]) => stopAllWorkspaceAgents(entries), []);

  return (
    <WorkspaceAgentPanel
      activity={activity}
      onOpenThread={onOpenThread}
      onStopThread={stopThread}
      onStopAll={stopAll}
    />
  );
}
