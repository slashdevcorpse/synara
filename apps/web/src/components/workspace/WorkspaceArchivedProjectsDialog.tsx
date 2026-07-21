// FILE: WorkspaceArchivedProjectsDialog.tsx
// Purpose: Lists archived projects and restores them without deleting files or chats.
// Layer: Workspace dashboard UI
// Exports: WorkspaceArchivedProjectsDialog

import type {
  OrchestrationArchivedProjectSummary,
  ProjectId,
  WorkspaceListArchivedProjectsResult,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { ArchiveIcon, LoaderCircleIcon, RefreshCwIcon } from "~/lib/icons";
import { unarchiveProjectFromClient } from "~/lib/projectArchive";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  workspaceArchivedProjectsQueryOptions,
  workspaceQueryKeys,
} from "~/lib/workspaceReactQuery";
import { ensureNativeApi } from "~/nativeApi";

function readableError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function WorkspaceArchivedProjectsDialog({
  open,
  onOpenChange,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: (projectId: ProjectId) => void;
}) {
  const queryClient = useQueryClient();
  const archivedQuery = useQuery(workspaceArchivedProjectsQueryOptions({ enabled: open }));
  const [restoringProjectId, setRestoringProjectId] = useState<ProjectId | null>(null);
  const [restoreFailure, setRestoreFailure] = useState<{
    projectId: ProjectId;
    message: string;
  } | null>(null);
  const projects = useMemo(
    () =>
      (archivedQuery.data?.projects ?? []).toSorted(
        (left, right) => Date.parse(right.archivedAt) - Date.parse(left.archivedAt),
      ),
    [archivedQuery.data?.projects],
  );

  useEffect(() => {
    if (open) return;
    setRestoringProjectId(null);
    setRestoreFailure(null);
  }, [open]);

  const restoreProject = async (project: OrchestrationArchivedProjectSummary) => {
    setRestoringProjectId(project.id);
    setRestoreFailure(null);
    try {
      await unarchiveProjectFromClient(ensureNativeApi().orchestration, project.id);
      queryClient.setQueryData<WorkspaceListArchivedProjectsResult>(
        workspaceQueryKeys.archivedProjects,
        (current) =>
          current
            ? { projects: current.projects.filter((entry) => entry.id !== project.id) }
            : current,
      );
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.all,
        refetchType: "none",
      });
      onRestored(project.id);
      toastManager.add({
        type: "success",
        title: `${project.title} restored`,
        description: "The same project, repository files, and chats are available again.",
      });
    } catch (cause) {
      const message = readableError(cause);
      setRestoreFailure({ projectId: project.id, message });
      toastManager.add({
        type: "error",
        title: `Could not restore ${project.title}`,
        description: message,
      });
    } finally {
      setRestoringProjectId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!restoringProjectId) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup surface="solid" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Archived projects</DialogTitle>
          <DialogDescription>
            Removed projects keep their repository files and every chat. Restore one to return it to
            the workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-h-36">
          {archivedQuery.isPending ? (
            <div className="space-y-2" aria-label="Loading archived projects">
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
            </div>
          ) : archivedQuery.isError ? (
            <div
              className="flex min-h-32 flex-col items-center justify-center gap-3 text-center"
              role="alert"
            >
              <div>
                <p className="text-sm font-medium">Archived projects are unavailable</p>
                <p className="mt-1 text-xs text-destructive">
                  {readableError(archivedQuery.error)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={archivedQuery.isFetching}
                onClick={() => void archivedQuery.refetch()}
              >
                <RefreshCwIcon className={archivedQuery.isFetching ? "animate-spin" : undefined} />
                Retry
              </Button>
            </div>
          ) : projects.length === 0 ? (
            <div className="flex min-h-32 flex-col items-center justify-center text-center">
              <ArchiveIcon className="mb-2 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">No archived projects</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Projects removed from the workspace will appear here.
              </p>
            </div>
          ) : (
            <ul className="space-y-2" aria-label="Archived projects">
              {projects.map((project) => {
                const restoring = restoringProjectId === project.id;
                const failure = restoreFailure?.projectId === project.id ? restoreFailure : null;
                return (
                  <li
                    key={project.id}
                    className="rounded-xl border border-border bg-card/70 p-3"
                    aria-busy={restoring}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold">{project.title}</h3>
                        <p
                          className="mt-0.5 truncate text-xs text-muted-foreground"
                          title={project.workspaceRoot}
                        >
                          {project.workspaceRoot}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restoringProjectId !== null}
                        onClick={() => void restoreProject(project)}
                      >
                        {restoring ? <LoaderCircleIcon className="animate-spin" /> : null}
                        {failure ? "Retry restore" : "Restore"}
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        Archived{" "}
                        <time dateTime={project.archivedAt} title={project.archivedAt}>
                          {formatRelativeTime(project.archivedAt)}
                        </time>
                      </span>
                      <span>
                        {project.threadCount} top-level{" "}
                        {project.threadCount === 1 ? "chat" : "chats"}
                      </span>
                    </div>
                    {project.latestThread ? (
                      <p className="mt-2 truncate text-xs text-muted-foreground">
                        Latest chat:{" "}
                        <span className="text-foreground">{project.latestThread.title}</span>
                        {" · "}
                        <time
                          dateTime={project.latestThread.updatedAt}
                          title={project.latestThread.updatedAt}
                        >
                          {formatRelativeTime(project.latestThread.updatedAt)}
                        </time>
                      </p>
                    ) : null}
                    {failure ? (
                      <p className="mt-2 text-xs text-destructive" role="alert">
                        {failure.message}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
