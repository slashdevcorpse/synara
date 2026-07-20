import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationSession,
  OrchestrationThread,
  ProjectKind,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import {
  PROJECT_ARCHIVED_WORKSPACE_ROOT_INVARIANT_MARKER,
  THREAD_NOT_ARCHIVED_INVARIANT_MARKER,
} from "@synara/shared/errorMessages";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

/**
 * True when the thread still has an in-flight / unsettled turn:
 * session mid-lifecycle ("starting"/"running"), a non-error session with an
 * activeTurnId, or a latestTurn still projected as "running".
 *
 * Runtime errors can retain the failed turn id for attribution even though the
 * session and turn are terminal, so an errored session's activeTurnId is stale.
 */
export function threadHasInFlightTurn(thread: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: { readonly state: string } | null;
}): boolean {
  const session = thread.session;
  return (
    (session?.status !== "error" && session?.activeTurnId != null) ||
    session?.status === "starting" ||
    session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

// Finds every non-deleted project by workspace root using the same comparison
// rules as import flows. Archived rows remain workspace identity owners even
// while hidden from the active shell.
export function listProjectsByWorkspaceRoot(
  readModel: OrchestrationReadModel,
  workspaceRoot: string,
  options?: { readonly kinds?: ReadonlySet<ProjectKind> },
): ReadonlyArray<OrchestrationProject> {
  const normalizedWorkspaceRoot = normalizeWorkspaceRootForComparison(workspaceRoot, {
    platform: process.platform,
  });
  const acceptedKinds = options?.kinds ?? new Set<ProjectKind>(["project"]);
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      acceptedKinds.has(project.kind ?? "project") &&
      normalizeWorkspaceRootForComparison(project.workspaceRoot, {
        platform: process.platform,
      }) === normalizedWorkspaceRoot,
  );
}

// Active-only view retained for flows that intentionally ignore archived rows.
export function listActiveProjectsByWorkspaceRoot(
  readModel: OrchestrationReadModel,
  workspaceRoot: string,
  options?: { readonly kinds?: ReadonlySet<ProjectKind> },
): ReadonlyArray<OrchestrationProject> {
  return listProjectsByWorkspaceRoot(readModel, workspaceRoot, options).filter(
    (project) => project.archivedAt === null,
  );
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireProjectWorkspaceRootAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly excludeProjectId?: ProjectId;
  readonly kinds?: ReadonlySet<ProjectKind>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Skip the excluded project BEFORE picking, not after: if corrupt state ever leaves two
  // active owners on one root, the project being updated must not mask the other owner.
  const existingProject = listProjectsByWorkspaceRoot(
    input.readModel,
    input.workspaceRoot,
    input.kinds ? { kinds: input.kinds } : undefined,
  ).find((project) => project.id !== input.excludeProjectId);
  if (!existingProject) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      existingProject.archivedAt === null
        ? `Project '${existingProject.id}' already uses workspace root '${existingProject.workspaceRoot}'.`
        : `Project '${existingProject.id}' ${PROJECT_ARCHIVED_WORKSPACE_ROOT_INVARIANT_MARKER} '${existingProject.workspaceRoot}'. Restore project '${existingProject.id}' instead of creating a new project.`,
    ),
  );
}

const PROJECT_ARCHIVE_MUTATION_EXEMPT_COMMANDS = new Set<OrchestrationCommand["type"]>([
  "project.create",
  "project.archive",
  "project.unarchive",
  "project.delete",
]);

function projectForCommand(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): OrchestrationProject | undefined {
  if (PROJECT_ARCHIVE_MUTATION_EXEMPT_COMMANDS.has(command.type)) {
    return undefined;
  }
  if ("projectId" in command) {
    return findProjectById(readModel, command.projectId);
  }
  if ("threadId" in command) {
    const thread = findThreadById(readModel, command.threadId);
    return thread ? findProjectById(readModel, thread.projectId) : undefined;
  }
  return undefined;
}

/**
 * Reject every mutation routed through an archived project, including crafted
 * internal/provider commands. Archive, unarchive, and terminal delete remain
 * explicit escape hatches and enforce their own state invariants.
 */
export function requireCommandProjectNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const project = projectForCommand(input.readModel, input.command);
  if (!project || project.archivedAt === null) {
    return Effect.void;
  }
  // Archive emits a stop intent before changing project visibility. The provider
  // reactor settles that intent asynchronously after the project is archived;
  // permit only its terminal, inactive session state. Client command schemas do
  // not expose thread.session.set, and every start/resume/nonterminal mutation
  // remains blocked by this centralized guard.
  if (
    input.command.type === "thread.session.set" &&
    input.command.session.status === "stopped" &&
    input.command.session.activeTurnId === null
  ) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${project.id}' is archived and cannot handle command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectHasNoThreads(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const remainingThreads = listThreadsByProjectId(input.readModel, input.projectId).filter(
    (thread) => thread.deletedAt === null,
  );
  if (remainingThreads.length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' still has ${remainingThreads.length} thread${remainingThreads.length === 1 ? "" : "s"} and cannot be deleted.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread && thread.deletedAt === null) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      thread
        ? `Thread '${input.threadId}' was deleted and cannot handle command '${input.command.type}'.`
        : `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt != null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt == null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
