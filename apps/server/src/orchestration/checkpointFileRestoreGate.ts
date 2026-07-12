import type { OrchestrationCommand, OrchestrationEvent } from "@synara/contracts";
import { CommandId } from "@synara/contracts";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

export const CHECKPOINT_FILE_RESTORE_PENDING_DETAIL =
  "A checkpoint file restore is still pending. Wait for Synara to confirm it is safe to continue before starting workspace or provider mutations.";

const BLOCKED_ORCHESTRATION_COMMAND_TYPES = new Set<OrchestrationCommand["type"]>([
  "project.create",
  "project.meta.update",
  "thread.delete",
  "thread.turn.start",
  "thread.turn.dispatch-queued",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.checkpoint.files.restore",
  "thread.conversation.rollback",
  "thread.message.edit-and-resend",
]);

export function hasPendingCheckpointFileRestore(events: Iterable<OrchestrationEvent>): boolean {
  const pendingRequestCommandIds = new Set<CommandId>();
  const terminalRequestCommandIds = new Set<CommandId>();

  for (const event of events) {
    switch (event.type) {
      case "thread.checkpoint-files-restore-requested":
        if (event.commandId !== null && !terminalRequestCommandIds.has(event.commandId)) {
          pendingRequestCommandIds.add(event.commandId);
        }
        break;
      case "thread.checkpoint-files-restore-reconciliation-requested":
        if (!terminalRequestCommandIds.has(event.payload.requestCommandId)) {
          pendingRequestCommandIds.add(event.payload.requestCommandId);
        }
        break;
      case "thread.checkpoint-files-restored":
      case "thread.checkpoint-files-restore-failed":
        terminalRequestCommandIds.add(event.payload.requestCommandId);
        pendingRequestCommandIds.delete(event.payload.requestCommandId);
        break;
      default:
        break;
    }
  }

  return pendingRequestCommandIds.size > 0;
}

export function hasRecordedOrchestrationCommand(
  events: Iterable<OrchestrationEvent>,
  commandId: CommandId,
): boolean {
  for (const event of events) {
    if (event.commandId === commandId) {
      return true;
    }
  }
  return false;
}

export function shouldBlockCommandForPendingCheckpointFileRestore(
  events: Iterable<OrchestrationEvent>,
  commandType: string,
  options?: { readonly allowRecordedCommandId?: CommandId },
): boolean {
  const eventList = Array.from(events);
  if (!isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(commandType)) {
    return false;
  }
  if (!hasPendingCheckpointFileRestore(eventList)) {
    return false;
  }
  return options?.allowRecordedCommandId === undefined
    ? true
    : !hasRecordedOrchestrationCommand(eventList, options.allowRecordedCommandId);
}

export function isOrchestrationCommandBlockedByPendingCheckpointFileRestore(
  command: OrchestrationCommand,
): boolean {
  return isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(command.type);
}

export function isOrchestrationCommandTypeBlockedByPendingCheckpointFileRestore(
  commandType: string,
): boolean {
  return BLOCKED_ORCHESTRATION_COMMAND_TYPES.has(commandType as OrchestrationCommand["type"]);
}

export function makePendingCheckpointFileRestoreCommandError(commandType: string) {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail: CHECKPOINT_FILE_RESTORE_PENDING_DETAIL,
  });
}
