// FILE: WorkspaceProjectCard.tsx
// Purpose: Responsive, action-oriented project card for the workspace dashboard.
// Layer: Workspace dashboard UI
// Exports: WorkspaceProjectCard

import { PROVIDER_DISPLAY_NAMES, type ThreadId } from "@synara/contracts";
import type { ComponentProps, RefCallback } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { RAISED_SURFACE_CHROME_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import {
  PULL_REQUEST_CHECKS_TONE_TEXT_CLASS,
  summarizePullRequestChecks,
} from "~/components/chat/environment/environmentPullRequest.logic";
import { ProviderIcon } from "~/components/ProviderIcon";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "~/components/pullRequest/pullRequestStatePresentation";
import { PullRequestChecksRing } from "~/components/pullRequest/PullRequestChecksRing";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import { isElectron } from "~/env";
import {
  ArchiveIcon,
  EllipsisIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  Rows3Icon,
  TerminalIcon,
  WorktreeIcon,
} from "~/lib/icons";
import { PinStatusIcon } from "~/lib/pin";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  githubRepositoryFromUrl,
  type WorkspaceCardModel,
  type WorkspaceWorktreeTarget,
} from "./workspaceDashboard.logic";

function WorktreeTarget({
  target,
  onOpen,
}: {
  target: WorkspaceWorktreeTarget;
  onOpen: (target: WorkspaceWorktreeTarget) => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      title={target.path}
      onClick={() => onOpen(target)}
    >
      <WorktreeIcon className="size-3.5" />
      <span className="max-w-36 truncate">{target.branch ?? target.threadTitle}</span>
    </button>
  );
}

export function WorkspaceProjectCard({
  card,
  refreshing,
  initializing,
  archiving,
  isPinned,
  dragHandle,
  onOpenProject,
  onOpenThread,
  onOpenTerminal,
  onRefresh,
  onInitGit,
  onOpenPullRequest,
  onArchive,
  onTogglePin,
}: {
  card: WorkspaceCardModel;
  refreshing: boolean;
  initializing: boolean;
  archiving: boolean;
  isPinned: boolean;
  dragHandle?: {
    ref: RefCallback<HTMLButtonElement>;
    props: ComponentProps<"button">;
  };
  onOpenProject: () => void;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenTerminal: () => void;
  onRefresh: () => void;
  onInitGit: () => void;
  onOpenPullRequest: () => void;
  onArchive: () => void;
  onTogglePin: () => void;
}) {
  const { project, repository } = card;
  const pr = repository.kind === "git" ? repository.linkedPr : null;
  const checksSummary = pr ? summarizePullRequestChecks(pr.checks) : null;
  const prPresentation = pr ? resolvePrStatePresentation(pr) : null;
  const PrIcon = prPresentation
    ? PR_STATE_PRESENTATION_ICONS[prPresentation.iconKind]
    : GitPullRequestIcon;
  const repositoryLabel =
    pr?.repository ??
    (repository.kind === "git" ? githubRepositoryFromUrl(repository.remoteUrl ?? "") : null);

  const openInEditor = async () => {
    try {
      await openInPreferredEditor(ensureNativeApi(), project.cwd);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not open the project",
        description: cause instanceof Error ? cause.message : "The editor could not be opened.",
      });
    }
  };

  const showInFolder = async () => {
    try {
      await ensureNativeApi().shell.showInFolder(project.cwd);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not reveal the project",
        description: cause instanceof Error ? cause.message : "The folder could not be shown.",
      });
    }
  };

  return (
    <article
      className={cn(
        "group relative min-w-0 rounded-xl bg-card/70 p-4 transition-colors hover:bg-card",
        RAISED_SURFACE_CHROME_CLASS_NAME,
      )}
    >
      <button
        type="button"
        aria-label={`Open ${project.name}`}
        className="absolute -inset-px z-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={onOpenProject}
      />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-heading text-sm font-semibold">{project.name}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={project.cwd}>
              {project.cwd}
            </p>
          </div>
          <div className="pointer-events-auto shrink-0">
            <div className="flex items-center gap-0.5">
              {dragHandle ? (
                <Button
                  {...dragHandle.props}
                  ref={dragHandle.ref}
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Reorder ${project.name}`}
                  title="Drag to reorder"
                  className="cursor-grab active:cursor-grabbing"
                >
                  <Rows3Icon />
                </Button>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={isPinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                aria-pressed={isPinned}
                title={isPinned ? "Unpin project" : "Pin project"}
                onClick={onTogglePin}
              >
                <PinStatusIcon pinned={isPinned} />
              </Button>
              <Menu>
                <MenuTrigger
                  aria-label={`Project actions for ${project.name}`}
                  render={<Button size="icon-sm" variant="ghost" />}
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-52">
                  <MenuItem onClick={onOpenTerminal}>
                    <TerminalIcon />
                    Open in terminal
                  </MenuItem>
                  <MenuItem onClick={() => void openInEditor()}>
                    <FolderOpenIcon />
                    Open in editor
                  </MenuItem>
                  {isElectron ? (
                    <MenuItem onClick={() => void showInFolder()}>
                      <FolderOpenIcon />
                      Show in folder
                    </MenuItem>
                  ) : null}
                  <MenuItem disabled={refreshing} onClick={onRefresh}>
                    <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
                    Refresh status
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" disabled={archiving} onClick={onArchive}>
                    <ArchiveIcon />
                    Remove from workspace
                  </MenuItem>
                </ComposerPickerMenuPopup>
              </Menu>
            </div>
          </div>
        </div>

        <div className="flex min-h-5 flex-wrap items-center gap-1.5">
          {repository.kind === "git" ? (
            <>
              <Badge variant="outline">
                <GitBranchIcon />
                {repository.headState === "unborn"
                  ? "No commits"
                  : repository.headState === "detached"
                    ? "Detached HEAD"
                    : (repository.branch ?? "Branch unavailable")}
              </Badge>
              {repository.dirtyFileCount > 0 ? (
                <Badge variant="warning">{repository.dirtyFileCount} dirty</Badge>
              ) : (
                <Badge variant="success">Clean</Badge>
              )}
              {repository.ahead ? <Badge variant="info">↑ {repository.ahead}</Badge> : null}
              {repository.behind ? <Badge variant="outline">↓ {repository.behind}</Badge> : null}
              {repository.remoteUrl || repositoryLabel ? (
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={repository.remoteUrl ?? repositoryLabel ?? undefined}
                >
                  {repositoryLabel ?? repository.remoteName ?? repository.remoteUrl}
                </span>
              ) : null}
              {repository.githubStatus === "unavailable" ? (
                <Badge
                  variant="error"
                  title={
                    repository.githubErrorMessage ?? "GitHub status is temporarily unavailable."
                  }
                >
                  PR status unavailable
                </Badge>
              ) : null}
            </>
          ) : repository.kind === "not-git" ? (
            <div className="pointer-events-auto flex items-center gap-2">
              <Badge variant="outline">Not a Git repository</Badge>
              <Button size="xs" variant="outline" disabled={initializing} onClick={onInitGit}>
                {initializing ? <LoaderCircleIcon className="animate-spin" /> : <GitBranchIcon />}
                Initialize Git
              </Button>
            </div>
          ) : repository.kind === "loading" ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              Loading status…
            </div>
          ) : (
            <div className="pointer-events-auto flex min-w-0 items-center gap-2">
              <span className="truncate text-xs text-destructive" title={repository.message}>
                Status unavailable
              </span>
              {repository.retryable ? (
                <Button size="xs" variant="ghost" disabled={refreshing} onClick={onRefresh}>
                  Retry
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {pr && prPresentation && checksSummary ? (
          <button
            type="button"
            className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onOpenPullRequest}
          >
            <PrIcon className={cn("size-4 shrink-0", prPresentation.colorClass)} />
            <span className="truncate text-xs font-medium">
              #{pr.number} {pr.title}
            </span>
            <span
              className={cn(
                "ml-auto flex shrink-0 items-center gap-1 text-xs",
                PULL_REQUEST_CHECKS_TONE_TEXT_CLASS[checksSummary.tone],
              )}
            >
              <PullRequestChecksRing checks={pr.checks} />
              {checksSummary.label}
            </span>
          </button>
        ) : null}

        <div className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
          <div className="min-w-0">
            {card.activity ? (
              <button
                type="button"
                className={cn(
                  "pointer-events-auto flex min-w-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  card.activity.colorClass,
                )}
                onClick={() => onOpenThread(card.activity!.threadId)}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    card.activity.dotClass,
                    card.activity.pulse && "animate-pulse motion-reduce:animate-none",
                  )}
                />
                {card.activity.label}
              </button>
            ) : (
              <span className="text-muted-foreground">No active agents</span>
            )}
            <span
              data-testid="workspace-project-process-summary"
              className="mt-1 block text-[10px] text-muted-foreground/55"
            >
              {`${card.processActivity.agentCount} ${card.processActivity.agentCount === 1 ? "agent" : "agents"} · ${card.processActivity.subagentCount} ${card.processActivity.subagentCount === 1 ? "subagent" : "subagents"} (${card.processActivity.subagentRunningCount} running) · ${card.processActivity.terminalProcessCount} terminal ${card.processActivity.terminalProcessCount === 1 ? "process" : "processes"}${card.processActivity.devServerRunning ? " · dev server running" : ""}${card.processActivity.gitActionRunning ? " · Git operation running" : ""}`}
            </span>
          </div>
          <div className="pointer-events-auto flex min-w-0 justify-start sm:justify-end">
            {card.worktrees.length === 1 && card.worktrees[0] ? (
              <WorktreeTarget
                target={card.worktrees[0]}
                onOpen={(target) => onOpenThread(target.threadId)}
              />
            ) : card.worktrees.length > 1 ? (
              <Menu>
                <MenuTrigger className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
                  <WorktreeIcon className="size-3.5" />
                  {card.worktrees.length} worktrees
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-56">
                  {card.worktrees.map((target) => (
                    <MenuItem key={target.path} onClick={() => onOpenThread(target.threadId)}>
                      <WorktreeIcon />
                      <span className="min-w-0">
                        <span className="block truncate">
                          {target.branch ?? target.threadTitle}
                        </span>
                        <span className="block max-w-72 truncate text-[10px] text-muted-foreground">
                          {target.path}
                        </span>
                      </span>
                    </MenuItem>
                  ))}
                </ComposerPickerMenuPopup>
              </Menu>
            ) : null}
          </div>
        </div>

        {card.automation ? (
          <button
            type="button"
            disabled={!card.automation.threadId}
            className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-sm text-left text-xs text-muted-foreground outline-none enabled:hover:text-foreground enabled:focus-visible:ring-1 enabled:focus-visible:ring-ring"
            onClick={() => {
              if (card.automation?.threadId) onOpenThread(card.automation.threadId);
            }}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                card.automation.isActive ? "bg-sky-500" : "bg-muted-foreground/50",
                card.automation.isActive && "animate-pulse motion-reduce:animate-none",
              )}
            />
            <span className="truncate">{card.automation.label}</span>
            <span className="ml-auto shrink-0">
              {formatRelativeTime(card.automation.occurredAt)}
            </span>
          </button>
        ) : null}

        <div className="flex min-w-0 items-center gap-2 border-t border-border/60 pt-3">
          {card.recentThread ? (
            <button
              type="button"
              className="pointer-events-auto min-w-0 truncate rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onOpenThread(card.recentThread!.id)}
            >
              {card.recentThread.title}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">No recent chats</span>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {formatRelativeTime(card.recentAt)}
          </span>
          <span className="flex shrink-0 -space-x-1" aria-label="Active providers">
            {card.providers.map((provider) => (
              <span
                key={provider}
                title={PROVIDER_DISPLAY_NAMES[provider]}
                className="flex size-5 items-center justify-center rounded-full border border-border bg-background"
              >
                <ProviderIcon provider={provider} className="size-3" />
              </span>
            ))}
          </span>
        </div>
      </div>
    </article>
  );
}
