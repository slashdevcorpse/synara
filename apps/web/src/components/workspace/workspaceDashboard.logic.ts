// FILE: workspaceDashboard.logic.ts
// Purpose: Pure workspace-dashboard derivation, filtering, sorting, and clone validation.
// Layer: Workspace dashboard presentation logic
// Exports: Dashboard view models and deterministic helpers used by the route and tests.

import type { AutomationRun, ProjectId, ProviderKind, ThreadId } from "@synara/contracts";

import { resolveThreadStatusPill, type ThreadStatusPill } from "~/components/Sidebar.logic";
import type { Project, SidebarThreadSummary } from "~/types";

export type WorkspaceFilter = "all" | "active" | "idle" | "dirty" | "unpushed" | "with-prs";
export type WorkspaceSort = "recent" | "name" | "dirty" | "manual";
export type WorkspacePathPlatform = "posix" | "windows";

export type WorkspaceCheckStatus =
  | "pending"
  | "success"
  | "failure"
  | "skipped"
  | "neutral"
  | "cancelled";

export interface WorkspaceCheck {
  readonly name: string;
  readonly status: WorkspaceCheckStatus;
  readonly url: string | null;
}

export interface WorkspacePullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly repository: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly checks: readonly WorkspaceCheck[];
}

export type WorkspaceRepositoryState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "git";
      readonly remoteUrl: string | null;
      readonly remoteName: string | null;
      readonly branch: string | null;
      readonly headState: "branch" | "detached" | "unborn";
      readonly ahead: number | null;
      readonly behind: number | null;
      readonly dirtyFileCount: number;
      readonly hasUnpushedCommits: boolean;
      readonly linkedPr: WorkspacePullRequest | null;
      readonly githubStatus: "ready" | "unavailable" | "not_applicable";
      readonly githubErrorMessage?: string | null;
    }
  | { readonly kind: "not-git" }
  | {
      readonly kind: "unavailable";
      readonly message: string;
      readonly retryable: boolean;
    };

export interface WorkspaceActivity {
  readonly threadId: ThreadId;
  readonly label: Extract<
    ThreadStatusPill["label"],
    "Working" | "Connecting" | "Pending Approval" | "Awaiting Input"
  >;
  readonly colorClass: string;
  readonly dotClass: string;
  readonly pulse: boolean;
}

export interface WorkspaceWorktreeTarget {
  readonly path: string;
  readonly branch: string | null;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
}

export interface WorkspaceAutomationActivity {
  readonly runId: string;
  readonly threadId: ThreadId | null;
  readonly label: string;
  readonly status: AutomationRun["status"];
  readonly isActive: boolean;
  readonly occurredAt: string;
  readonly occurredAtMs: number;
}

export interface WorkspaceAutomationRun {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly status: AutomationRun["status"];
  readonly finishedAt: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface WorkspaceCardModel {
  readonly project: Project;
  readonly repository: WorkspaceRepositoryState;
  readonly recentThread: SidebarThreadSummary | null;
  readonly activity: WorkspaceActivity | null;
  readonly worktrees: readonly WorkspaceWorktreeTarget[];
  readonly providers: readonly ProviderKind[];
  readonly automation: WorkspaceAutomationActivity | null;
  readonly recentAt: string;
  readonly recentAtMs: number;
}

function automationStatusLabel(status: AutomationRun["status"]): string {
  switch (status) {
    case "pending":
      return "Automation queued";
    case "claimed":
      return "Automation starting";
    case "running":
      return "Automation running";
    case "waiting-for-approval":
      return "Automation waiting for approval";
    case "succeeded":
      return "Automation completed";
    case "failed":
      return "Automation failed";
    case "cancelled":
      return "Automation cancelled";
    case "interrupted":
      return "Automation interrupted";
    case "skipped":
      return "Automation skipped";
  }
}

function deriveAutomation(run: WorkspaceAutomationRun): WorkspaceAutomationActivity {
  const occurredAt = run.finishedAt ?? run.startedAt ?? run.updatedAt ?? run.createdAt;
  return {
    runId: run.id,
    threadId: run.threadId,
    label: automationStatusLabel(run.status),
    status: run.status,
    isActive: ["pending", "claimed", "running", "waiting-for-approval"].includes(run.status),
    occurredAt,
    occurredAtMs: timestampMs(occurredAt),
  };
}

const ACTIVITY_PRIORITY: Record<WorkspaceActivity["label"], number> = {
  "Pending Approval": 4,
  "Awaiting Input": 3,
  Working: 2,
  Connecting: 1,
};

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function threadTimestamp(thread: SidebarThreadSummary): string {
  const candidates = [thread.latestUserMessageAt, thread.updatedAt, thread.createdAt].filter(
    (value): value is string => Boolean(value),
  );
  return (
    candidates.toSorted((left, right) => timestampMs(right) - timestampMs(left))[0] ??
    thread.createdAt
  );
}

function isDashboardActivity(
  status: ThreadStatusPill | null,
): status is ThreadStatusPill & { label: WorkspaceActivity["label"] } {
  return (
    status?.label === "Working" ||
    status?.label === "Connecting" ||
    status?.label === "Pending Approval" ||
    status?.label === "Awaiting Input"
  );
}

function deriveActivity(threads: readonly SidebarThreadSummary[]): WorkspaceActivity | null {
  const candidates = threads.flatMap((thread) => {
    const status = resolveThreadStatusPill({
      thread,
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
    });
    if (!isDashboardActivity(status)) return [];
    return [
      {
        threadId: thread.id,
        label: status.label,
        colorClass: status.colorClass,
        dotClass: status.dotClass,
        pulse: status.pulse,
        updatedAtMs: timestampMs(threadTimestamp(thread)),
      },
    ];
  });

  const selected = candidates.toSorted(
    (left, right) =>
      ACTIVITY_PRIORITY[right.label] - ACTIVITY_PRIORITY[left.label] ||
      right.updatedAtMs - left.updatedAtMs,
  )[0];
  if (!selected) return null;
  return {
    threadId: selected.threadId,
    label: selected.label,
    colorClass: selected.colorClass,
    dotClass: selected.dotClass,
    pulse: selected.pulse,
  };
}

function worktreePathKey(path: string, platform: WorkspacePathPlatform): string {
  return platform === "windows" ? path.replaceAll("\\", "/").toLowerCase() : path;
}

function deriveWorktrees(
  threads: readonly SidebarThreadSummary[],
  platform: WorkspacePathPlatform,
): WorkspaceWorktreeTarget[] {
  const byPath = new Map<string, WorkspaceWorktreeTarget & { updatedAtMs: number }>();
  for (const thread of threads) {
    const path = (thread.associatedWorktreePath ?? thread.worktreePath)?.trim();
    if (!path) continue;
    const key = worktreePathKey(path, platform);
    const candidate = {
      path,
      branch: thread.associatedWorktreeBranch ?? thread.branch,
      threadId: thread.id,
      threadTitle: thread.title,
      updatedAtMs: timestampMs(threadTimestamp(thread)),
    };
    const current = byPath.get(key);
    if (!current || candidate.updatedAtMs > current.updatedAtMs) {
      byPath.set(key, candidate);
    }
  }
  return [...byPath.values()]
    .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)
    .map(({ updatedAtMs: _updatedAtMs, ...target }) => target);
}

export function deriveWorkspaceCards(input: {
  projects: readonly Project[];
  threads: readonly SidebarThreadSummary[];
  automationRuns?: readonly WorkspaceAutomationRun[];
  repositoryByProjectId: ReadonlyMap<ProjectId, WorkspaceRepositoryState>;
  worktreePathPlatform: WorkspacePathPlatform;
}): WorkspaceCardModel[] {
  const threadsByProject = new Map<ProjectId, SidebarThreadSummary[]>();
  for (const thread of input.threads) {
    if (thread.archivedAt != null) continue;
    const projectThreads = threadsByProject.get(thread.projectId) ?? [];
    projectThreads.push(thread);
    threadsByProject.set(thread.projectId, projectThreads);
  }
  const automationByProject = new Map<
    ProjectId,
    {
      latest: WorkspaceAutomationActivity;
      latestActive: WorkspaceAutomationActivity | null;
    }
  >();
  for (const run of input.automationRuns ?? []) {
    const automation = deriveAutomation(run);
    const existing = automationByProject.get(run.projectId);
    automationByProject.set(run.projectId, {
      latest:
        !existing || automation.occurredAtMs > existing.latest.occurredAtMs
          ? automation
          : existing.latest,
      latestActive:
        automation.isActive &&
        (!existing?.latestActive || automation.occurredAtMs > existing.latestActive.occurredAtMs)
          ? automation
          : (existing?.latestActive ?? null),
    });
  }

  return input.projects
    .filter((project) => project.kind === "project")
    .map((project) => {
      const threads = threadsByProject.get(project.id) ?? [];
      const topLevelThreads = threads.filter((thread) => !thread.parentThreadId);
      const recentThread =
        topLevelThreads.toSorted(
          (left, right) => timestampMs(threadTimestamp(right)) - timestampMs(threadTimestamp(left)),
        )[0] ?? null;
      const threadRecentAt =
        threads.reduce<string | null>((latest, thread) => {
          const candidate = threadTimestamp(thread);
          return latest === null || timestampMs(candidate) > timestampMs(latest)
            ? candidate
            : latest;
        }, null) ??
        project.updatedAt ??
        project.createdAt ??
        new Date(0).toISOString();
      const automationState = automationByProject.get(project.id);
      const automation = automationState?.latestActive ?? automationState?.latest ?? null;
      const latestAutomation = automationState?.latest ?? null;
      const recentAt =
        latestAutomation && latestAutomation.occurredAtMs > timestampMs(threadRecentAt)
          ? latestAutomation.occurredAt
          : threadRecentAt;
      const providers = [
        ...new Set(
          threads.flatMap((thread) =>
            thread.session &&
            (thread.session.orchestrationStatus === "starting" ||
              thread.session.orchestrationStatus === "running")
              ? [thread.session.provider]
              : [],
          ),
        ),
      ];
      return {
        project,
        repository: input.repositoryByProjectId.get(project.id) ?? {
          kind: "loading" as const,
        },
        recentThread,
        activity: deriveActivity(threads),
        worktrees: deriveWorktrees(threads, input.worktreePathPlatform),
        providers,
        automation,
        recentAt,
        recentAtMs: timestampMs(recentAt),
      };
    });
}

export function filterAndSortWorkspaceCards(
  cards: readonly WorkspaceCardModel[],
  filter: WorkspaceFilter,
  sort: WorkspaceSort,
): WorkspaceCardModel[] {
  const filtered = cards.filter((card) => {
    switch (filter) {
      case "active":
        return card.activity !== null || card.automation?.isActive === true;
      case "idle":
        return card.activity === null && card.automation?.isActive !== true;
      case "dirty":
        return card.repository.kind === "git" && card.repository.dirtyFileCount > 0;
      case "unpushed":
        return card.repository.kind === "git" && card.repository.hasUnpushedCommits;
      case "with-prs":
        return card.repository.kind === "git" && card.repository.linkedPr !== null;
      default:
        return true;
    }
  });

  return filtered.toSorted((left, right) => {
    if (sort === "manual") return 0;
    if (sort === "name") {
      return left.project.name.localeCompare(right.project.name, undefined, {
        sensitivity: "base",
      });
    }
    if (sort === "dirty") {
      const leftDirty = left.repository.kind === "git" ? left.repository.dirtyFileCount : 0;
      const rightDirty = right.repository.kind === "git" ? right.repository.dirtyFileCount : 0;
      return rightDirty - leftDirty || right.recentAtMs - left.recentAtMs;
    }
    return right.recentAtMs - left.recentAtMs;
  });
}

export function canDragWorkspaceCards(sort: WorkspaceSort): boolean {
  return sort === "manual";
}

export function canDragWorkspaceCard(sort: WorkspaceSort, isPinned: boolean): boolean {
  return canDragWorkspaceCards(sort) && !isPinned;
}

export function orderWorkspaceCardsPinnedFirst(
  cards: readonly WorkspaceCardModel[],
  pinnedProjectIds: readonly ProjectId[],
): WorkspaceCardModel[] {
  const pinnedOrder = new Map(
    pinnedProjectIds.map((projectId, index) => [projectId, index] as const),
  );
  return cards.toSorted((left, right) => {
    const leftIndex = pinnedOrder.get(left.project.id);
    const rightIndex = pinnedOrder.get(right.project.id);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return 0;
  });
}

export function githubRepositoryFromUrl(value: string): string | null {
  const trimmed = value.trim();
  const sshMatch = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) return sshMatch[1] ?? null;

  try {
    const url = new URL(trimmed);
    const isHttps = url.protocol === "https:" && !url.username;
    const isSsh = url.protocol === "ssh:" && url.username === "git";
    if (
      (!isHttps && !isSsh) ||
      url.hostname.toLocaleLowerCase() !== "github.com" ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function validateCloneInput(input: { url: string; targetPath: string }): {
  url: string | null;
  targetPath: string | null;
} {
  const repository = githubRepositoryFromUrl(input.url);
  const targetPath = input.targetPath.trim();
  const isAbsolutePath =
    /^[A-Za-z]:[\\/](?![\\/])/.test(targetPath) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(targetPath) ||
    /^\/(?!\/)/.test(targetPath) ||
    targetPath === "~" ||
    /^~[\\/]/.test(targetPath);
  return {
    url: repository ? null : "Enter a valid credential-free HTTPS or SSH GitHub repository URL.",
    targetPath: isAbsolutePath ? null : "Choose an absolute path for a new destination folder.",
  };
}

export function defaultCloneTarget(homeDir: string | null, repositoryUrl: string): string {
  const repository = githubRepositoryFromUrl(repositoryUrl);
  if (!homeDir || !repository) return "";
  const repositoryName = repository.split("/").at(-1);
  if (!repositoryName) return "";
  const separator = homeDir.includes("\\") ? "\\" : "/";
  return `${homeDir.replace(/[\\/]+$/, "")}${separator}${repositoryName}`;
}
