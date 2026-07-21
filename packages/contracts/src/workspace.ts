import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { GitPullRequestCheck } from "./git";
import { OrchestrationArchivedProjectSummary } from "./orchestration";

export const WORKSPACE_LIST_GIT_STATES_MAX_PROJECTS = 100;

export const WorkspaceListArchivedProjectsInput = Schema.Struct({});
export type WorkspaceListArchivedProjectsInput = typeof WorkspaceListArchivedProjectsInput.Type;

export const WorkspaceListArchivedProjectsResult = Schema.Struct({
  projects: Schema.Array(OrchestrationArchivedProjectSummary),
});
export type WorkspaceListArchivedProjectsResult = typeof WorkspaceListArchivedProjectsResult.Type;

export const WorkspaceCloneId = TrimmedNonEmptyString.pipe(Schema.brand("WorkspaceCloneId"));
export type WorkspaceCloneId = typeof WorkspaceCloneId.Type;

export const WorkspaceGitStateError = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
});
export type WorkspaceGitStateError = typeof WorkspaceGitStateError.Type;

export const WorkspaceLinkedPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  checks: Schema.Array(GitPullRequestCheck),
});
export type WorkspaceLinkedPullRequest = typeof WorkspaceLinkedPullRequest.Type;

const WorkspaceGitStateErrors = Schema.Struct({
  local: Schema.NullOr(WorkspaceGitStateError),
  remote: Schema.NullOr(WorkspaceGitStateError),
});

const WorkspaceGitStateIdentity = {
  projectId: ProjectId,
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  refreshedAt: IsoDateTime,
  errors: WorkspaceGitStateErrors,
} as const;

export const WorkspaceGitRepositoryState = Schema.TaggedStruct("git", {
  ...WorkspaceGitStateIdentity,
  workspaceRoot: TrimmedNonEmptyString,
  remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
  remoteName: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  headState: Schema.Literals(["branch", "detached", "unborn"]),
  dirty: Schema.Boolean,
  dirtyFileCount: NonNegativeInt,
  upstream: Schema.NullOr(TrimmedNonEmptyString),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  hasCommits: Schema.Boolean,
  hasUnpushedCommits: Schema.Boolean,
  linkedPullRequest: Schema.NullOr(WorkspaceLinkedPullRequest),
});
export type WorkspaceGitRepositoryState = typeof WorkspaceGitRepositoryState.Type;

export const WorkspaceNotGitState = Schema.TaggedStruct("not-git", {
  ...WorkspaceGitStateIdentity,
  workspaceRoot: TrimmedNonEmptyString,
});
export type WorkspaceNotGitState = typeof WorkspaceNotGitState.Type;

export const WorkspaceUnavailableState = Schema.TaggedStruct("unavailable", {
  ...WorkspaceGitStateIdentity,
});
export type WorkspaceUnavailableState = typeof WorkspaceUnavailableState.Type;

export const WorkspaceGitStateItem = Schema.Union([
  WorkspaceGitRepositoryState,
  WorkspaceNotGitState,
  WorkspaceUnavailableState,
]);
export type WorkspaceGitStateItem = typeof WorkspaceGitStateItem.Type;

export const WorkspaceListGitStatesInput = Schema.Struct({
  projectIds: Schema.Array(ProjectId).check(
    Schema.isMaxLength(WORKSPACE_LIST_GIT_STATES_MAX_PROJECTS),
  ),
  forceRefresh: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type WorkspaceListGitStatesInput = typeof WorkspaceListGitStatesInput.Type;

export const WorkspaceListGitStatesResult = Schema.Struct({
  items: Schema.Array(WorkspaceGitStateItem),
});
export type WorkspaceListGitStatesResult = typeof WorkspaceListGitStatesResult.Type;

export const WorkspaceCloneFailure = Schema.Struct({
  stage: Schema.Literals(["clone", "project"]),
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
});
export type WorkspaceCloneFailure = typeof WorkspaceCloneFailure.Type;

export const WorkspaceCloneRepositoryResult = Schema.Struct({
  cloneId: WorkspaceCloneId,
  clonedPath: Schema.NullOr(TrimmedNonEmptyString),
  projectId: Schema.NullOr(ProjectId),
  failure: Schema.NullOr(WorkspaceCloneFailure),
});
export type WorkspaceCloneRepositoryResult = typeof WorkspaceCloneRepositoryResult.Type;

export const WorkspaceCloneJobStage = Schema.Literals([
  "validating",
  "cloning",
  "creating-project",
  "complete",
]);
export type WorkspaceCloneJobStage = typeof WorkspaceCloneJobStage.Type;

export const WorkspaceCloneJobSnapshot = Schema.Struct({
  cloneId: WorkspaceCloneId,
  status: Schema.Literals(["pending", "running", "succeeded", "failed"]),
  stage: WorkspaceCloneJobStage,
  percent: Schema.NullOr(NonNegativeInt.check(Schema.isLessThanOrEqualTo(100))),
  message: TrimmedNonEmptyString,
  result: Schema.NullOr(WorkspaceCloneRepositoryResult),
  updatedAt: IsoDateTime,
});
export type WorkspaceCloneJobSnapshot = typeof WorkspaceCloneJobSnapshot.Type;

export const WorkspaceCloneProgressEvent = Schema.Union([
  Schema.TaggedStruct("clone_started", {
    snapshot: WorkspaceCloneJobSnapshot,
  }),
  Schema.TaggedStruct("clone_progress", {
    snapshot: WorkspaceCloneJobSnapshot,
    phase: TrimmedNonEmptyString,
    completed: Schema.NullOr(NonNegativeInt),
    total: Schema.NullOr(NonNegativeInt),
  }),
  Schema.TaggedStruct("clone_finished", {
    snapshot: WorkspaceCloneJobSnapshot,
    result: WorkspaceCloneRepositoryResult,
  }),
]);
export type WorkspaceCloneProgressEvent = typeof WorkspaceCloneProgressEvent.Type;

export const WorkspaceCloneRepositoryInput = Schema.Struct({
  cloneId: WorkspaceCloneId,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  targetPath: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  createProject: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => true)),
  createParentDirectories: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => true),
  ),
});
export type WorkspaceCloneRepositoryInput = typeof WorkspaceCloneRepositoryInput.Type;

export const WorkspaceGetCloneStatusInput = Schema.Struct({
  cloneId: WorkspaceCloneId,
});
export type WorkspaceGetCloneStatusInput = typeof WorkspaceGetCloneStatusInput.Type;

export const WorkspaceGetCloneStatusResult = Schema.Struct({
  job: Schema.NullOr(WorkspaceCloneJobSnapshot),
});
export type WorkspaceGetCloneStatusResult = typeof WorkspaceGetCloneStatusResult.Type;

export const WorkspaceRetryCloneProjectCreationInput = Schema.Struct({
  cloneId: WorkspaceCloneId,
});
export type WorkspaceRetryCloneProjectCreationInput =
  typeof WorkspaceRetryCloneProjectCreationInput.Type;
