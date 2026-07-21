import { WorkspaceEntriesLive } from "./Layers/WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./Layers/WorkspaceFileSystem";
import { WorkspacePathsLive } from "./Layers/WorkspacePaths";
import { Layer } from "effect";
import { WorkspaceGitStatesLive } from "./workspaceGitStates";
import { WorkspaceCloneJobsLive } from "./cloneRepository";

export const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive,
  WorkspaceGitStatesLive,
  WorkspaceCloneJobsLive,
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive),
  ),
);
