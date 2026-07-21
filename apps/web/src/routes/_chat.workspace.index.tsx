// FILE: _chat.workspace.index.tsx
// Purpose: Synara-native project workspace dashboard at /workspace.
// Layer: Route UI

import { MAX_PINNED_PROJECTS, type ProjectId, type ThreadId } from "@synara/contracts";
import { isWindowsAbsolutePath } from "@synara/shared/path";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import {
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { ComposerPickerSelectPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { PullRequestFilterPillGroup } from "~/components/pullRequest/PullRequestListFilters";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Select, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { WorkspaceArchivedProjectsDialog } from "~/components/workspace/WorkspaceArchivedProjectsDialog";
import {
  AddExistingProjectDialog,
  CloneRepositoryDialog,
  hasRestorableWorkspaceClone,
} from "~/components/workspace/WorkspaceProjectDialogs";
import { WorkspaceProjectCard } from "~/components/workspace/WorkspaceProjectCard";
import {
  canDragWorkspaceCards,
  canDragWorkspaceCard,
  deriveWorkspaceCards,
  filterAndSortWorkspaceCards,
  orderWorkspaceCardsPinnedFirst,
  type WorkspaceCardModel,
  type WorkspaceFilter,
  type WorkspaceRepositoryState,
  type WorkspaceSort,
} from "~/components/workspace/workspaceDashboard.logic";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { ArchiveIcon, FolderOpenIcon, GitBranchIcon, PlusIcon, RefreshCwIcon } from "~/lib/icons";
import { archiveProjectFromClient } from "~/lib/projectArchive";
import { cn, newCommandId } from "~/lib/utils";
import {
  refreshWorkspaceGitProject,
  refreshWorkspaceGitStates,
  unavailableWorkspaceGitStates,
  workspaceQueryKeys,
  workspaceGitStatesQueryOptions,
} from "~/lib/workspaceReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { usePinnedProjectsStore } from "~/pinnedProjectsStore";
import { automationQueryKey } from "~/routes/-automations.shared";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";
import { useStore } from "~/store";
import { useWorkspaceStore } from "~/workspaceStore";

const FILTERS: ReadonlyArray<{ value: WorkspaceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "idle", label: "Idle" },
  { value: "dirty", label: "Dirty" },
  { value: "unpushed", label: "Unpushed" },
  { value: "with-prs", label: "With PRs" },
];

const SORTS: ReadonlyArray<{ value: WorkspaceSort; label: string }> = [
  { value: "recent", label: "Recently active" },
  { value: "name", label: "Name" },
  { value: "dirty", label: "Dirty files" },
  { value: "manual", label: "Manual" },
];

function SortableWorkspaceCard({
  card,
  dragEnabled,
  children,
}: {
  card: WorkspaceCardModel;
  dragEnabled: boolean;
  children: (dragHandle: Parameters<typeof WorkspaceProjectCard>[0]["dragHandle"]) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.project.id, disabled: !dragEnabled });
  return (
    <div
      ref={setNodeRef}
      className={cn("min-w-0", isDragging && "relative z-20 opacity-75")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children(
        dragEnabled
          ? {
              ref: setActivatorNodeRef,
              props: { ...attributes, ...listeners },
            }
          : undefined,
      )}
    </div>
  );
}

export function WorkspaceDashboardRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { handleNewThread } = useHandleNewThread();
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const selectThreads = useMemo(() => createSidebarThreadSummariesSelector(), []);
  const threads = useStore(selectThreads);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const homeDir = useWorkspaceStore((store) => store.homeDir);
  const pinnedProjectIds = usePinnedProjectsStore((store) => store.pinnedProjectIds);
  const pinProject = usePinnedProjectsStore((store) => store.pinProject);
  const unpinProject = usePinnedProjectsStore((store) => store.unpinProject);
  const [filter, setFilter] = useState<WorkspaceFilter>("all");
  const [sort, setSort] = useState<WorkspaceSort>("recent");
  const [addOpen, setAddOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivingProjectId, setArchivingProjectId] = useState<ProjectId | null>(null);
  const [pendingArchivedProjectIds, setPendingArchivedProjectIds] = useState<Set<ProjectId>>(
    () => new Set(),
  );
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingProjectId, setRefreshingProjectId] = useState<ProjectId | null>(null);
  const [initializingProjectId, setInitializingProjectId] = useState<ProjectId | null>(null);
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();
  const projectRows = useMemo(
    () => projects.filter((project) => project.kind === "project"),
    [projects],
  );
  const dashboardProjectRows = useMemo(
    () => projectRows.filter((project) => !pendingArchivedProjectIds.has(project.id)),
    [pendingArchivedProjectIds, projectRows],
  );
  const serverPathSample = homeDir ?? dashboardProjectRows[0]?.cwd ?? "";
  const worktreePathPlatform = isWindowsAbsolutePath(serverPathSample) ? "windows" : "posix";
  const projectIds = useMemo(() => projectRows.map((project) => project.id), [projectRows]);
  const gitStatesQuery = useQuery(workspaceGitStatesQueryOptions({ projectIds }));
  const repositoryByProjectId = useMemo(
    () =>
      gitStatesQuery.data ??
      (gitStatesQuery.isError
        ? unavailableWorkspaceGitStates(projectIds, gitStatesQuery.error)
        : new Map<ProjectId, WorkspaceRepositoryState>()),
    [gitStatesQuery.data, gitStatesQuery.error, gitStatesQuery.isError, projectIds],
  );
  const automationQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const dragEnabled = canDragWorkspaceCards(sort);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!threadsHydrated || projectRows.length === 0) return;
    const projectIdSet = new Set(projectRows.map((project) => project.id));
    usePinnedProjectsStore.getState().prunePinnedProjects([...projectIdSet]);
    for (const project of projectRows) {
      if (project.isPinned === true) pinProject(project.id);
      else unpinProject(project.id);
    }
  }, [pinProject, projectRows, threadsHydrated, unpinProject]);

  useEffect(() => {
    const activeProjectIds = new Set(projectRows.map((project) => project.id));
    setPendingArchivedProjectIds((current) => {
      const next = new Set([...current].filter((projectId) => activeProjectIds.has(projectId)));
      return next.size === current.size ? current : next;
    });
  }, [projectRows]);

  useEffect(() => {
    if (hasRestorableWorkspaceClone()) setCloneOpen(true);
  }, []);

  const cards = useMemo(
    () =>
      deriveWorkspaceCards({
        projects: dashboardProjectRows,
        threads,
        automationRuns: automationQuery.data?.runs ?? [],
        repositoryByProjectId,
        worktreePathPlatform,
      }),
    [
      automationQuery.data?.runs,
      dashboardProjectRows,
      repositoryByProjectId,
      threads,
      worktreePathPlatform,
    ],
  );
  const visibleCards = useMemo(
    () =>
      orderWorkspaceCardsPinnedFirst(
        filterAndSortWorkspaceCards(cards, filter, sort),
        pinnedProjectIds,
      ),
    [cards, filter, pinnedProjectIds, sort],
  );
  const pinnedSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);

  const openThread = (threadId: ThreadId) => {
    void navigate({ to: "/$threadId", params: { threadId } });
  };

  const openProject = (card: WorkspaceCardModel) => {
    if (card.recentThread) {
      openThread(card.recentThread.id);
      return;
    }
    void handleNewThread(card.project.id);
  };

  const openNewProject = async (projectId: ProjectId) => {
    const snapshot = await ensureNativeApi()
      .orchestration.getShellSnapshot()
      .catch(() => null);
    if (snapshot) syncServerShellSnapshot(snapshot);
    await handleNewThread(projectId);
  };

  const refresh = async (projectId: ProjectId | null = null) => {
    if (projectId) setRefreshingProjectId(projectId);
    else setRefreshingAll(true);
    try {
      if (projectId) {
        await refreshWorkspaceGitProject({
          queryClient,
          dashboardProjectIds: projectIds,
          projectId,
        });
      } else {
        await refreshWorkspaceGitStates({ queryClient, projectIds });
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not refresh workspace status",
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setRefreshingProjectId(null);
      setRefreshingAll(false);
    }
  };

  const initGit = async (card: WorkspaceCardModel) => {
    setInitializingProjectId(card.project.id);
    try {
      await ensureNativeApi().git.init({ cwd: card.project.cwd });
      await refresh(card.project.id);
      toastManager.add({ type: "success", title: `Initialized Git in ${card.project.name}` });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not initialize Git",
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setInitializingProjectId(null);
    }
  };

  const togglePin = async (card: WorkspaceCardModel) => {
    const wasPinned = pinnedSet.has(card.project.id);
    if (wasPinned) {
      unpinProject(card.project.id);
    } else if (!pinProject(card.project.id)) {
      toastManager.add({
        type: "warning",
        title: "Project pin limit reached",
        description: `You can pin up to ${MAX_PINNED_PROJECTS} projects.`,
      });
      return;
    }
    try {
      await ensureNativeApi().orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: card.project.id,
        isPinned: !wasPinned,
      });
    } catch (cause) {
      if (wasPinned) pinProject(card.project.id);
      else unpinProject(card.project.id);
      toastManager.add({
        type: "error",
        title: wasPinned ? "Unable to unpin project" : "Unable to pin project",
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  const archiveProject = async (card: WorkspaceCardModel) => {
    const api = ensureNativeApi();
    let confirmed = false;
    try {
      confirmed = await api.dialogs.confirm(
        `Remove ${card.project.name} from this workspace?\n\nRepository files and all chats will be preserved. You can restore this project from Archived projects.`,
      );
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not remove ${card.project.name}`,
        description: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (!confirmed) return;

    setArchivingProjectId(card.project.id);
    try {
      await archiveProjectFromClient(api.orchestration, card.project.id);
      setPendingArchivedProjectIds((current) => new Set(current).add(card.project.id));
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.all,
        refetchType: "none",
      });
      toastManager.add({
        type: "success",
        title: `${card.project.name} removed from workspace`,
        description: "Repository files and all chats were preserved.",
        actionProps: {
          children: "View archived",
          onClick: () => setArchivedOpen(true),
        },
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not remove ${card.project.name}`,
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setArchivingProjectId(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (!dragEnabled || !event.over || event.active.id === event.over.id) return;
    const activeId = event.active.id as ProjectId;
    const overId = event.over.id as ProjectId;
    if (pinnedSet.has(activeId) || pinnedSet.has(overId)) return;
    reorderProjects(activeId, overId);
  };

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <RouteInsetSurface surfaceClassName="bg-transparent">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)]">
          <header
            className={cn(
              CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
              CHAT_SURFACE_HEADER_PADDING_X_CLASS,
              "drag-region",
              trafficLightGutter,
              windowControlsGutter,
            )}
          >
            <div className={cn("flex items-center gap-2", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
              <SidebarHeaderNavigationControls />
              <h1 className="truncate font-heading text-sm font-medium">Workspace</h1>
              <div className="min-w-0 flex-1" />
              <Button
                size="sm"
                variant="ghost"
                aria-label="Archived projects"
                onClick={() => setArchivedOpen(true)}
              >
                <ArchiveIcon />
                <span className="hidden sm:inline">Archived projects</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)}>
                <FolderOpenIcon />
                <span className="hidden sm:inline">Add existing</span>
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCloneOpen(true)}>
                <PlusIcon />
                <span className="hidden sm:inline">Clone repository</span>
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh workspace status"
                disabled={
                  gitStatesQuery.isPending ||
                  refreshingAll ||
                  refreshingProjectId !== null ||
                  projectIds.length === 0
                }
                onClick={() => void refresh()}
              >
                <RefreshCwIcon
                  className={cn((refreshingAll || refreshingProjectId !== null) && "animate-spin")}
                />
              </Button>
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pb-12 pt-4 sm:px-7">
              {dashboardProjectRows.length > 0 ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="overflow-x-auto pb-1 sm:overflow-visible sm:pb-0">
                    <PullRequestFilterPillGroup
                      value={filter}
                      options={FILTERS}
                      onChange={setFilter}
                    />
                  </div>
                  <Select
                    value={sort}
                    onValueChange={(value) => {
                      if (SORTS.some((option) => option.value === value)) {
                        setSort(value as WorkspaceSort);
                      }
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-44" aria-label="Sort projects">
                      <SelectValue />
                    </SelectTrigger>
                    <ComposerPickerSelectPopup>
                      {SORTS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </ComposerPickerSelectPopup>
                  </Select>
                </div>
              ) : null}

              {dashboardProjectRows.length === 0 ? (
                <Empty className="py-20">
                  <EmptyHeader>
                    <EmptyTitle>Build your workspace</EmptyTitle>
                    <EmptyDescription>
                      Add an existing project folder or clone a GitHub repository to see its status
                      here.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent className="flex-row justify-center">
                    <Button variant="outline" onClick={() => setAddOpen(true)}>
                      <FolderOpenIcon />
                      Add existing
                    </Button>
                    <Button onClick={() => setCloneOpen(true)}>
                      <GitBranchIcon />
                      Clone repository
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : visibleCards.length === 0 ? (
                <Empty className="py-20">
                  <EmptyHeader>
                    <EmptyTitle>No projects match this filter</EmptyTitle>
                    <EmptyDescription>Choose another workspace status filter.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" onClick={() => setFilter("all")}>
                      Show all projects
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={visibleCards.map((card) => card.project.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {visibleCards.map((card) => (
                        <SortableWorkspaceCard
                          key={card.project.id}
                          card={card}
                          dragEnabled={canDragWorkspaceCard(sort, pinnedSet.has(card.project.id))}
                        >
                          {(dragHandle) => (
                            <WorkspaceProjectCard
                              card={card}
                              {...(dragHandle === undefined ? {} : { dragHandle })}
                              isPinned={pinnedSet.has(card.project.id)}
                              refreshing={
                                gitStatesQuery.isPending ||
                                refreshingAll ||
                                refreshingProjectId !== null
                              }
                              initializing={initializingProjectId === card.project.id}
                              archiving={archivingProjectId === card.project.id}
                              onOpenProject={() => openProject(card)}
                              onOpenThread={openThread}
                              onOpenTerminal={() =>
                                void handleNewThread(card.project.id, { entryPoint: "terminal" })
                              }
                              onRefresh={() => void refresh(card.project.id)}
                              onInitGit={() => void initGit(card)}
                              onOpenPullRequest={() => {
                                if (card.repository.kind !== "git" || !card.repository.linkedPr)
                                  return;
                                const pr = card.repository.linkedPr;
                                void navigate({
                                  to: "/pull-requests",
                                  search: {
                                    involvement: "all",
                                    state: pr.state,
                                    selectedProjectId: card.project.id,
                                    selectedRepo: pr.repository,
                                    number: pr.number,
                                  },
                                });
                              }}
                              onArchive={() => void archiveProject(card)}
                              onTogglePin={() => void togglePin(card)}
                            />
                          )}
                        </SortableWorkspaceCard>
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </div>
          </main>
        </div>
      </RouteInsetSurface>
      <AddExistingProjectDialog
        open={addOpen}
        homeDir={homeDir}
        onOpenChange={setAddOpen}
        onAdded={(projectId) => void openNewProject(projectId)}
      />
      <CloneRepositoryDialog
        open={cloneOpen}
        homeDir={homeDir}
        onOpenChange={setCloneOpen}
        onComplete={(projectId) => void openNewProject(projectId)}
      />
      <WorkspaceArchivedProjectsDialog
        open={archivedOpen}
        onOpenChange={setArchivedOpen}
        onRestored={(projectId) => {
          setPendingArchivedProjectIds((current) => {
            if (!current.has(projectId)) return current;
            const next = new Set(current);
            next.delete(projectId);
            return next;
          });
        }}
      />
    </div>
  );
}

export const Route = createFileRoute("/_chat/workspace/")({
  component: WorkspaceDashboardRoute,
});
