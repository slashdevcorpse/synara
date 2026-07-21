// FILE: _chat.index.tsx
// Purpose: Restores the last chat route on app launch, opening Workspace on a truly fresh install.
// Layer: Routing
// Depends on: the shared restore/create route surface plus the home-chat new-chat handler.

import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import {
  collectNonStudioThreadIds,
  resolveRestorableThreadRoute,
  shouldOpenWorkspaceDashboardOnEmptyHome,
} from "../chatRouteRestore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { collectStudioProjectIds } from "../lib/studioProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspaceStore } from "../workspaceStore";

function ChatIndexRouteView() {
  const navigate = useNavigate();
  const { handleNewChat } = useHandleNewChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const projects = useStore((state) => state.projects);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((state) => state.studioWorkspaceRoot);

  // Home chats restore the last visited route, except Studio threads — those belong to the
  // /studio surface, and restoring one from "/" would silently switch the user into the Studio
  // segment. A Studio lastThreadRoute falls through to a fresh home-chat draft instead.
  const studioProjectIds = collectStudioProjectIds(projects, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
  });
  const nonStudioThreadIds = collectNonStudioThreadIds({
    threadIds,
    threadSummaryById: sidebarThreadSummaryById,
    studioProjectIds,
  });
  // Fresh unsent chats have a route id but no persisted sidebar summary yet, so the thread-id
  // filter never matches them — mirrors the /studio landing's draft handling (and
  // Sidebar's segment-scoped draft sets) so a cold start on "/" can restore an unsent home draft
  // instead of always minting a new one. Only plain, still-unsent chat drafts qualify: a
  // non-"chat" entry point isn't a home-chat draft, and `promotedTo` means the draft already
  // became a real thread, so its stale id is no longer a valid restore target (matches the
  // filtering findStudioDraftThreadId applies when picking Studio's current draft).
  const nonStudioDraftThreadIds = new Set<string>();
  for (const [threadId, draft] of Object.entries(draftThreadsByThreadId)) {
    if (
      !studioProjectIds.has(draft.projectId) &&
      draft.entryPoint === "chat" &&
      draft.promotedTo === undefined
    ) {
      nonStudioDraftThreadIds.add(threadId);
    }
  }
  const createFreshChat = async () => {
    if (
      shouldOpenWorkspaceDashboardOnEmptyHome({
        availableThreadCount: nonStudioThreadIds.size,
        draftThreadCount: nonStudioDraftThreadIds.size,
        lastThreadRoute: readSidebarUiState().lastThreadRoute,
      })
    ) {
      await navigate({ to: "/workspace", replace: true });
      return { ok: true, threadId: null } as const;
    }
    return handleNewChat({ fresh: true });
  };
  const resolveRestoreRoute: RestoreRouteResolver = ({ availableSplitViewIds }) => {
    const availableThreadIds = new Set(nonStudioThreadIds);
    for (const draftThreadId of nonStudioDraftThreadIds) {
      availableThreadIds.add(draftThreadId);
    }
    return resolveRestorableThreadRoute({
      lastThreadRoute: readSidebarUiState().lastThreadRoute,
      availableThreadIds,
      availableSplitViewIds,
    });
  };

  return (
    <RestoreOrCreateChatRoute
      resolveRestoreRoute={resolveRestoreRoute}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
