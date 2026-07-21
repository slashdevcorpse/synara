// FILE: workspaceFileOpener.ts
// Purpose: Context + helpers that let file references rendered deep in the
//          chat tree (markdown links, mention chips, work-log rows) open in an
//          in-app workspace file viewer (right-dock file pane or editor pane)
//          instead of an external editor.
// Layer: Web UI helpers
// Exports: WorkspaceFileOpenerContext, useWorkspaceFileOpener,
//          resolveWorkspaceFileOpenTarget, resolveScratchPreviewFileOpenTarget,
//          resolveDockFileOpenTarget,
//          openWorkspaceFileReference, prefetchWorkspaceFile

import { isWorkspaceRelativePathSafe } from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import {
  localFilePreviewKindForPath,
  parseLocalFileReference,
  resolveActiveWorkspaceFilePath,
  resolveLocalFileOpenIntent,
} from "./localFileOpenIntent";
import { buildLocalPreviewCapabilityUrl } from "./localImageUrls";
import {
  projectLocalHtmlPreviewGrantQueryOptions,
  projectReadFileQueryOptions,
} from "./projectReactQuery";

export interface WorkspaceFileOpener {
  /**
   * Opens a file referenced in the chat. Returns true when the reference was
   * handled by an in-app viewer; false tells the caller to fall back to the
   * external editor (path outside the workspace, no viewer on this surface).
   */
  openFile: (path: string) => boolean;
  /** Optional hover warm-up for the file contents + syntax highlighter. */
  prefetchFile?: (path: string) => void;
}

export const WorkspaceFileOpenerContext = createContext<WorkspaceFileOpener | null>(null);

export function useWorkspaceFileOpener(): WorkspaceFileOpener | null {
  return useContext(WorkspaceFileOpenerContext);
}

const SYNARA_PUBLIC_ASSET_PATH_PREFIXES = [
  "/central-icons-reversed/",
  "/central-icons-fill/",
] as const;
const SYNARA_WEB_PUBLIC_WORKSPACE_DIR = "apps/web/public";

function resolveSynaraPublicAssetOpenTarget(path: string, workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return null;
  }
  const normalizedPath = path.replace(/\\/g, "/");
  if (!SYNARA_PUBLIC_ASSET_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))) {
    return null;
  }
  const relativePath = `${SYNARA_WEB_PUBLIC_WORKSPACE_DIR}${normalizedPath}`;
  return isWorkspaceRelativePathSafe(relativePath) ? relativePath : null;
}

/**
 * Maps a chat file reference (workspace-relative, or absolute as produced by
 * `resolveMarkdownFileLinkTarget`, optionally with a `:line:col` suffix) to the
 * workspace-relative path the file-read RPC expects. Returns null when the
 * reference points outside the workspace.
 */
export function resolveWorkspaceFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
  referenceRoot?: string | null,
): string | null {
  const withoutPosition = parseLocalFileReference(rawPath)?.path ?? "";
  if (withoutPosition.length === 0) {
    return null;
  }
  if (isWorkspaceRelativePathSafe(withoutPosition)) {
    return withoutPosition;
  }
  if (!workspaceRoot) {
    return null;
  }
  const resolution = resolveActiveWorkspaceFilePath({
    rawPath,
    runtimeRoot: workspaceRoot,
    referenceRoot,
  });
  if (resolution.kind === "workspace") {
    return resolution.path;
  }
  // CentralIcon assets are linked in chat as Vite root URLs
  // (`/central-icons-...`) but the file viewer needs the repo path.
  return resolveSynaraPublicAssetOpenTarget(withoutPosition, workspaceRoot);
}

/**
 * Out-of-workspace fallback for trusted per-thread scratch files: a
 * session that starts before its chat workspace exists runs in a scratch
 * directory under the OS temp dir, and the agent references those files by
 * absolute path. Dedicated binary routes and short-lived grants keep supported
 * scratch previews in-app without admitting arbitrary absolute paths.
 */
export function resolveScratchPreviewFileOpenTarget(rawPath: string): string | null {
  const resolution = resolveActiveWorkspaceFilePath({ rawPath, runtimeRoot: null });
  return resolution.kind === "scratch" ? resolution.path : null;
}

// Right-dock file panes accept active-workspace files and trusted scratch files.
// Other absolute paths fail closed and fall back to the external editor.
export function resolveDockFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
  referenceRoot?: string | null,
): string | null {
  const workspaceTarget = workspaceRoot
    ? resolveWorkspaceFileOpenTarget(rawPath, workspaceRoot, referenceRoot)
    : null;
  if (workspaceTarget) {
    return workspaceTarget;
  }
  const intent = resolveLocalFileOpenIntent({
    rawPath,
    runtimeRoot: workspaceRoot,
    referenceRoot,
    allowOutsideWorkspaceFilePreview: true,
  });
  return intent.kind === "failure" || intent.kind === "external-editor" ? null : intent.path;
}

export interface WorkspaceHtmlBrowserOpenRequest {
  readonly url: string;
  readonly localFilePath: string;
}

export type WorkspaceHtmlBrowserOpenHandler = (request: WorkspaceHtmlBrowserOpenRequest) => void;

/** Mint a fresh browser-purpose capability immediately before navigation. */
export async function createWorkspaceHtmlBrowserOpenRequest(input: {
  readonly queryClient: QueryClient;
  readonly filePath: string;
  readonly workspaceRoot: string | null;
  readonly referenceRoot?: string | null | undefined;
}): Promise<WorkspaceHtmlBrowserOpenRequest> {
  const intent = resolveLocalFileOpenIntent({
    rawPath: input.filePath,
    runtimeRoot: input.workspaceRoot,
    referenceRoot: input.referenceRoot,
    action: "browser",
  });
  if (intent.kind !== "browser-html") {
    throw new Error(
      intent.kind === "failure" && intent.reason === "outside-workspace"
        ? "HTML file is outside the active workspace."
        : "Only HTML files can open in the browser.",
    );
  }
  const grant = await input.queryClient.fetchQuery(
    projectLocalHtmlPreviewGrantQueryOptions({
      path: intent.path,
      cwd: isScratchWorkspacePath(intent.path) ? null : input.workspaceRoot,
      purpose: "browser",
      // Browser launches always receive a newly minted short-lived capability.
      staleTime: 0,
    }),
  );
  if (!grant.urlPath) {
    throw new Error("The server did not return an HTML browser capability URL.");
  }
  return {
    url: buildLocalPreviewCapabilityUrl(grant.urlPath),
    localFilePath: intent.absolutePath,
  };
}

/**
 * Shared activation path for clickable file references: try the surface's
 * in-app viewer first, fall back to the preferred external editor when the
 * reference isn't viewable in-app (path outside the workspace, no opener).
 * Pass a null opener to force the external editor (e.g. meta/ctrl-click).
 */
export function openWorkspaceFileReference(opener: WorkspaceFileOpener | null, path: string): void {
  if (opener?.openFile(path)) {
    return;
  }
  const api = readNativeApi();
  if (api) {
    void openInPreferredEditor(api, path).catch(() => undefined);
  } else {
    console.warn("Native API not found. Unable to open file in editor.");
  }
}

/**
 * Hover warm-up so the file pane opens instantly: file contents go through the
 * shared React Query cache, and the matching Shiki highlighter loads in the
 * background. The highlighter module is imported dynamically so chat-adjacent
 * chunks don't pull Shiki eagerly.
 */
export function prefetchWorkspaceFile(
  queryClient: QueryClient,
  workspaceRoot: string,
  relativePath: string,
): void {
  // Dedicated binary previews do not need a text read/highlighter warm-up;
  // known unsupported binaries should not be read speculatively either.
  const previewKind = localFilePreviewKindForPath(relativePath);
  if (previewKind === "image" || previewKind === "pdf" || previewKind === "unsupported-binary") {
    return;
  }
  // Bare filenames (no directory) usually do not exist at the workspace root and
  // make the read RPC fall back to a tracked-index lookup, which can build the
  // workspace index. Skip warming those on hover so a pointer sweep over many
  // such references never triggers repeated index builds; the click-to-open
  // path still resolves them on demand.
  if (!relativePath.includes("/")) {
    return;
  }
  void queryClient.prefetchQuery(projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath }));
  void import("./syntaxHighlighting")
    .then((module) =>
      module.getSyntaxHighlighterPromise(module.getSyntaxLanguageForPath(relativePath)),
    )
    .catch(() => undefined);
}
