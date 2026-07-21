// FILE: cloneProjectCreation.ts
// Purpose: Create or recover the Synara project attached to a cloned repository.
// Layer: Server workspace orchestration
// Exports: makeWorkspaceCloneProjectCreator

import {
  CommandId,
  ProjectId,
  type ClientOrchestrationCommand,
  type OrchestrationArchivedProjectSummary,
  type OrchestrationCommand,
  type OrchestrationProject,
} from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { Effect, Option } from "effect";

import type { DispatchCommandNormalizerResult } from "../orchestration/dispatchCommandNormalization";
import type { WorkspaceProjectCreator } from "./cloneRepository";

interface WorkspaceCloneProjectQuery<QueryError> {
  readonly listArchivedProjects: () => Effect.Effect<
    ReadonlyArray<OrchestrationArchivedProjectSummary>,
    QueryError
  >;
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, QueryError>;
}

export function makeWorkspaceCloneProjectCreator<NormalizeError, DispatchError, QueryError>(input: {
  readonly basename: (workspaceRoot: string) => string;
  readonly defaultCodexModel: string;
  readonly dispatchCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, DispatchError>;
  readonly normalizeDispatchCommand: (input: {
    readonly command: ClientOrchestrationCommand;
  }) => Effect.Effect<DispatchCommandNormalizerResult<NormalizeError>, NormalizeError>;
  readonly platform?: string;
  readonly projectionSnapshotQuery: WorkspaceCloneProjectQuery<QueryError>;
}): WorkspaceProjectCreator {
  const platform = input.platform ?? process.platform;

  return (workspaceRoot) =>
    Effect.gen(function* () {
      const projectId = ProjectId.makeUnsafe(`project:${crypto.randomUUID()}`);
      const command: Extract<OrchestrationCommand, { type: "project.create" }> = {
        type: "project.create",
        commandId: CommandId.makeUnsafe(`command:workspace-clone:${crypto.randomUUID()}`),
        projectId,
        kind: "project",
        title: input.basename(workspaceRoot),
        workspaceRoot,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: {
          provider: "codex",
          model: input.defaultCodexModel,
        },
        createdAt: new Date().toISOString(),
      };
      const { command: normalizedCommand, prepareWorkspaceRoot } =
        yield* input.normalizeDispatchCommand({ command });
      if (normalizedCommand.type !== "project.create") {
        return yield* Effect.die("Workspace project normalization changed command type.");
      }
      const canonicalWorkspaceRoot = normalizedCommand.workspaceRoot;

      const recoverExistingProject = Effect.gen(function* () {
        const archivedProjects = yield* input.projectionSnapshotQuery.listArchivedProjects();
        const archivedProject = archivedProjects.find((project) =>
          workspaceRootsEqual(project.workspaceRoot, canonicalWorkspaceRoot, { platform }),
        );
        if (archivedProject) {
          const restored = yield* Effect.result(
            input.dispatchCommand({
              type: "project.unarchive",
              commandId: CommandId.makeUnsafe(
                `command:workspace-clone-restore:${crypto.randomUUID()}`,
              ),
              projectId: archivedProject.id,
              createdAt: new Date().toISOString(),
            }),
          );
          if (restored._tag === "Success") {
            return Option.some(archivedProject.id);
          }

          // A concurrent add/restore may win between the archived lookup and
          // the unarchive dispatch. Reuse only that same original project id.
          const racedProject =
            yield* input.projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
              canonicalWorkspaceRoot,
            );
          if (Option.isSome(racedProject) && racedProject.value.id === archivedProject.id) {
            return Option.some(archivedProject.id);
          }
          return yield* Effect.fail(restored.failure);
        }

        const activeProject =
          yield* input.projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
            canonicalWorkspaceRoot,
          );
        if (Option.isSome(activeProject)) {
          return Option.some(activeProject.value.id);
        }
        return Option.none<ProjectId>();
      });

      const existing = yield* recoverExistingProject;
      if (Option.isSome(existing)) return existing.value;

      const dispatched = yield* Effect.result(input.dispatchCommand(normalizedCommand));
      if (dispatched._tag === "Failure") {
        const racedProject = yield* recoverExistingProject;
        if (Option.isSome(racedProject)) return racedProject.value;
        return yield* Effect.fail(dispatched.failure);
      }
      if (prepareWorkspaceRoot) yield* prepareWorkspaceRoot;
      return projectId;
    });
}
