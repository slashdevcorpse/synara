// FILE: WorkspaceFilePreview.tsx
// Purpose: Shared single-file preview (code with syntax highlighting, parsed
//          markdown, images, PDFs) for workspace files plus absolute local
//          file references reused by editor and right-dock panes.
// Layer: Web chat presentation component
// Exports: WorkspaceFilePreview, isMarkdownPreviewablePath

import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  joinWorkspaceRelativePath,
} from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Component,
  Suspense,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
} from "react";

import { basenameOfPath } from "~/file-icons";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { getSelectionWithin, type ChatFileReference } from "~/lib/chatReferences";
import { resolveDiffThemeName, type DiffThemeName } from "~/lib/diffRendering";
import { formatFileCommentRange, type FileCommentSelection } from "~/lib/fileComments";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import { PlusIcon } from "~/lib/icons";
import {
  isProbablyBinaryFileContents,
  resolveLocalFileOpenIntent,
} from "~/lib/localFileOpenIntent";
import { buildLocalPreviewCapabilityUrl } from "~/lib/localImageUrls";
import { toggleMarkdownTaskMarker } from "~/lib/markdownTaskList";
import {
  isLocalPreviewGrantUsable,
  projectLocalHtmlPreviewGrantQueryOptions,
  projectLocalPreviewGrantQueryOptions,
  projectReadFileQueryOptions,
} from "~/lib/projectReactQuery";
import {
  createWorkspaceHtmlBrowserOpenRequest,
  type WorkspaceHtmlBrowserOpenHandler,
} from "~/lib/workspaceFileOpener";
import {
  MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS,
  cacheSyntaxHighlightedHtml,
  createSyntaxHighlightCacheKey,
  getCachedSyntaxHighlightedHtml,
  getSyntaxHighlighterPromise,
  getSyntaxLanguageForPath,
  highlightCodeToHtmlWithFallback,
} from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import ChatMarkdown from "./ChatMarkdown";
import { FileLineCommentBox } from "./chat/FileLineCommentBox";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { useFileLineCommenting } from "./chat/useFileLineCommenting";
import { WorkspaceFilePreviewHeader } from "./chat/WorkspaceFilePreviewHeader";
import { TranscriptSelectionAction } from "./chat/TranscriptSelectionAction";
import { useCodeSelectionAction } from "./chat/useCodeSelectionAction";
import { LocalImagePreview } from "./LocalImagePreview";
import { PdfFilePreview } from "./PdfFilePreview";
import { Skeleton } from "./ui/skeleton";

export { isMarkdownPreviewablePath } from "~/lib/localFileOpenIntent";

function parentDirectoryFromPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }
  return normalized.slice(0, separatorIndex);
}

function markdownPreviewCwd(workspaceRoot: string | null, filePath: string): string | undefined {
  const parentDirectory = parentDirectoryFromPath(filePath);
  if (isLocalAbsolutePath(filePath)) {
    return parentDirectory ?? undefined;
  }
  if (!workspaceRoot) {
    return undefined;
  }
  if (!parentDirectory) {
    return workspaceRoot;
  }
  return joinWorkspaceRelativePath(workspaceRoot, parentDirectory);
}

class FilePreviewHighlightErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// Above this the plain fallback skips per-line spans (and therefore line
// numbers) to keep the DOM small for huge files.
const MAX_PLAIN_NUMBERED_LINES = 20_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function PlainFileContents(props: { contents: string }) {
  // Wrap each line in a .line span (mirroring Shiki output) so the CSS
  // counter gutter applies. Built as an HTML string to avoid per-line React
  // nodes; the trailing \n stays inside each span so selection math and
  // clipboard copies keep working.
  const lines = props.contents.split("\n");
  const numberedHtml =
    props.contents.length === 0 || lines.length > MAX_PLAIN_NUMBERED_LINES
      ? null
      : `<code>${lines
          .map((line, index) =>
            index === lines.length - 1
              ? `<span class="line">${escapeHtml(line)}</span>`
              : `<span class="line">${escapeHtml(line)}\n</span>`,
          )
          .join("")}</code>`;

  if (numberedHtml !== null) {
    return (
      <pre
        className="editor-file-viewer__plain"
        aria-readonly="true"
        dangerouslySetInnerHTML={{ __html: numberedHtml }}
      />
    );
  }

  return (
    <pre className="editor-file-viewer__plain" aria-readonly="true">
      {props.contents}
    </pre>
  );
}

function SyntaxHighlightedFileContents(props: {
  path: string;
  contents: string;
  themeName: DiffThemeName;
}) {
  const language = getSyntaxLanguageForPath(props.path);
  const cacheKey = createSyntaxHighlightCacheKey(props.contents, language, props.themeName);
  const cachedHighlightedHtml = getCachedSyntaxHighlightedHtml(cacheKey);

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="editor-file-viewer__highlight"
        data-syntax-highlighted="true"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  // The uncached path lives in its own component: an early return above must
  // not change this component's hook order once the cache fills.
  return (
    <UncachedSyntaxHighlightedFileContents
      cacheKey={cacheKey}
      contents={props.contents}
      language={language}
      themeName={props.themeName}
    />
  );
}

function UncachedSyntaxHighlightedFileContents(props: {
  cacheKey: string;
  contents: string;
  language: string;
  themeName: DiffThemeName;
}) {
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const highlightedHtml = highlightCodeToHtmlWithFallback(
    highlighter,
    props.contents,
    props.language,
    props.themeName,
  );

  useEffect(() => {
    cacheSyntaxHighlightedHtml(props.cacheKey, highlightedHtml, props.contents);
  }, [props.cacheKey, highlightedHtml, props.contents]);

  return (
    <div
      className="editor-file-viewer__highlight"
      data-syntax-highlighted="true"
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  );
}

// The highlighted body (and its cache lookup) is skipped across selection and
// diff-warming re-renders because its inputs (path, contents, themeName) are
// stable unless the file changes — the React Compiler handles the memoization.
function FileContentsView(props: { path: string; contents: string; themeName: DiffThemeName }) {
  const plain = <PlainFileContents contents={props.contents} />;
  if (props.contents.length === 0 || props.contents.length > MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS) {
    return plain;
  }

  return (
    <FilePreviewHighlightErrorBoundary key={props.path} fallback={plain}>
      <Suspense fallback={plain}>
        <SyntaxHighlightedFileContents
          path={props.path}
          contents={props.contents}
          themeName={props.themeName}
        />
      </Suspense>
    </FilePreviewHighlightErrorBoundary>
  );
}

// Mimics indented code lines so the placeholder reads as a file body
// instead of a generic spinner block.
const FILE_PREVIEW_SKELETON_LINES = [
  { indent: 0, width: "w-5/12" },
  { indent: 0, width: "w-8/12" },
  { indent: 1, width: "w-10/12" },
  { indent: 1, width: "w-7/12" },
  { indent: 2, width: "w-9/12" },
  { indent: 2, width: "w-4/12" },
  { indent: 1, width: "w-6/12" },
  { indent: 0, width: "w-3/12" },
  { indent: 0, width: "w-7/12" },
  { indent: 1, width: "w-9/12" },
  { indent: 1, width: "w-5/12" },
  { indent: 0, width: "w-2/12" },
];

function FilePreviewLoadingState() {
  return (
    <div
      className="min-h-0 flex-1 space-y-2.5 overflow-hidden px-3 py-3"
      role="status"
      aria-label="Loading file..."
    >
      {FILE_PREVIEW_SKELETON_LINES.map((line) => (
        <div key={`${line.indent}-${line.width}`} className="flex h-3 items-center gap-2">
          <Skeleton className="h-2.5 w-5 shrink-0 rounded-full opacity-60" />
          <Skeleton
            className={cn("h-2.5 rounded-full", line.width)}
            style={{ marginLeft: `${line.indent * 1}rem` }}
          />
        </div>
      ))}
      <span className="sr-only">Loading file...</span>
    </div>
  );
}

function FilePreviewErrorState(props: { message: string; onRetry?: (() => void) | undefined }) {
  return (
    <div role="alert" className="flex min-h-0 flex-1">
      <PanelStateMessage density="compact" fill="flex" className="items-start justify-start p-3">
        <div className="flex flex-col items-start gap-2 text-left">
          <p className="text-[11px] text-destructive/85">{props.message}</p>
          {props.onRetry ? (
            <button
              type="button"
              className="cursor-pointer rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-secondary"
              onClick={props.onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      </PanelStateMessage>
    </div>
  );
}

export interface WorkspaceFilePreviewProps {
  workspaceRoot: string | null;
  /**
   * Workspace-relative path of the previewed file. Binary previews (images,
   * PDFs) may instead be absolute paths outside the workspace — e.g. a
   * session's scratch directory — served by the local-image route, which never
   * touch the workspace-relative file-read RPC.
   */
  filePath: string | null;
  /** Original project root used to remap absolute links into an active worktree. */
  referenceRoot?: string | null | undefined;
  /**
   * Initial markdown render mode per file: the dock opens markdown already
   * parsed, the editor surface stays source-first. The header toggle still
   * lets the user flip either way.
   */
  markdownPreviewDefault?: boolean;
  /** Shown when no file is selected yet. */
  emptyState?: ReactNode;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
  /** HTML-only, freshly minted browser navigation request. */
  onOpenInBrowser?: WorkspaceHtmlBrowserOpenHandler | undefined;
  /** Optional close action for embedded panel surfaces. */
  onClosePanel?: (() => void) | undefined;
}

export function WorkspaceFilePreview(props: WorkspaceFilePreviewProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const contentsRef = useRef<HTMLDivElement>(null);
  const taskWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestTaskWriteVersionRef = useRef({ next: 0, byFile: new Map<string, number>() });
  const { onAskWhyInChat, onCommentInChat, onReferenceInChat, workspaceRoot } = props;
  const queryClient = useQueryClient();
  const markdownPreviewDefault = props.markdownPreviewDefault ?? false;
  const fileIntent =
    props.filePath === null
      ? null
      : resolveLocalFileOpenIntent({
          rawPath: props.filePath,
          runtimeRoot: workspaceRoot,
          referenceRoot: props.referenceRoot,
          allowOutsideWorkspaceFilePreview: true,
        });
  const filePath =
    fileIntent !== null && fileIntent.kind !== "failure" && fileIntent.kind !== "external-editor"
      ? fileIntent.path
      : null;
  const fileIsImage = fileIntent?.kind === "preview-image";
  const fileIsPdf = fileIntent?.kind === "preview-pdf";
  const fileIsHtml = fileIntent?.kind === "preview-html";
  const fileIsUnsupportedBinary = fileIntent?.kind === "unsupported-binary";
  const fileIsLocalAbsolute = filePath !== null && isLocalAbsolutePath(filePath);
  const fileIsWorkspaceRelative = filePath !== null && isWorkspaceRelativePathSafe(filePath);
  const fileIsScratchBinaryPreview =
    filePath !== null && (fileIsImage || fileIsPdf) && isScratchWorkspacePath(filePath);
  const fileNeedsLocalPreviewGrant =
    filePath !== null &&
    fileIsLocalAbsolute &&
    !fileIsScratchBinaryPreview &&
    !fileIsHtml &&
    !fileIsUnsupportedBinary;
  const fileIsMarkdown = fileIntent?.kind === "preview-markdown";
  // Per-file override of the rendered-preview default. Deriving (instead of
  // syncing state in an effect) means switching files applies the default in
  // the same render, with no stale-value flash, and the override dies with its
  // file automatically.
  const [renderedPreviewOverride, setRenderedPreviewOverride] = useState<{
    filePath: string | null;
    rendered: boolean;
  } | null>(null);
  const renderedPreviewEnabled =
    renderedPreviewOverride !== null && renderedPreviewOverride.filePath === filePath
      ? renderedPreviewOverride.rendered
      : fileIsHtml || markdownPreviewDefault;
  const localPreviewGrantQuery = useQuery(
    projectLocalPreviewGrantQueryOptions({
      path: filePath,
      enabled: fileNeedsLocalPreviewGrant,
    }),
  );
  const localPreviewGrant =
    fileNeedsLocalPreviewGrant && isLocalPreviewGrantUsable(localPreviewGrantQuery.data)
      ? (localPreviewGrantQuery.data?.grant ?? null)
      : null;
  const htmlPreviewCwd =
    filePath !== null && isScratchWorkspacePath(filePath) ? null : workspaceRoot;
  const htmlPreviewGrantQuery = useQuery(
    projectLocalHtmlPreviewGrantQueryOptions({
      path: filePath,
      cwd: htmlPreviewCwd,
      purpose: "preview",
      enabled: fileIsHtml,
    }),
  );
  const htmlPreviewGrant =
    fileIsHtml && isLocalPreviewGrantUsable(htmlPreviewGrantQuery.data)
      ? (htmlPreviewGrantQuery.data?.grant ?? null)
      : null;
  const htmlPreviewUrl =
    htmlPreviewGrant && htmlPreviewGrantQuery.data?.urlPath
      ? buildLocalPreviewCapabilityUrl(htmlPreviewGrantQuery.data.urlPath)
      : null;
  const sourcePreviewGrant = fileIsHtml ? htmlPreviewGrant : localPreviewGrant;
  const binaryPreviewKey = `${props.workspaceRoot ?? ""}\0${filePath ?? ""}\0${sourcePreviewGrant ?? ""}`;
  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: filePath,
      previewGrant: sourcePreviewGrant,
      // Images and PDFs are binary: they stream through the local-image HTTP
      // route instead of the text file-read RPC.
      enabled:
        filePath !== null &&
        !fileIsImage &&
        !fileIsPdf &&
        !fileIsUnsupportedBinary &&
        (props.workspaceRoot !== null || sourcePreviewGrant !== null),
    }),
  );

  const fileContents = fileQuery.data?.contents ?? "";
  const showRenderedPreview = (fileIsMarkdown || fileIsHtml) && renderedPreviewEnabled;
  const fileContentsAreBinary =
    !showRenderedPreview &&
    fileQuery.data !== undefined &&
    isProbablyBinaryFileContents(fileContents);
  const lineCount = fileContents.length === 0 ? 0 : fileContents.split("\n").length;
  // Highlight -> floating "Add to chat" -> reference that points at exactly what
  // was selected, mirroring the transcript flow. This is offered only in the
  // source view, where the DOM mirrors the file's lines/columns 1:1 so a
  // selection resolves to an exact `line 12:5-12` span. The rendered-markdown
  // view restructures the source (paragraphs, lists, headings), so a selection
  // there cannot map back to an exact range — referencing a single word on a
  // 3000-word line would pull in the whole line. The rendered view therefore
  // stays read-only for references (browsing + task-list toggles only); use the
  // Source toggle in the header to get a precise selection reference.
  const readPreviewSelection = (container: HTMLElement): Omit<ChatFileReference, "path"> | null =>
    showRenderedPreview ? null : getSelectionWithin(container);
  const commitPreviewSelection = (selection: Omit<ChatFileReference, "path">) => {
    if (filePath) {
      onReferenceInChat?.({ path: filePath, ...selection });
    }
  };
  const previewSelectionAction = useCodeSelectionAction({
    enabled: Boolean(onReferenceInChat && filePath) && !showRenderedPreview,
    readSelection: readPreviewSelection,
    onCommit: commitPreviewSelection,
  });
  // Hover "+" gutter affordance + inline "Local comment" box. Offered only in
  // the source view, where the DOM mirrors the file's lines 1:1 so the hovered
  // `.line` resolves to an exact line number (the rendered-markdown view
  // restructures the source and cannot map a row back to a file line).
  const lineCommentingEnabled = Boolean(onCommentInChat && filePath) && !showRenderedPreview;
  const lineCommenting = useFileLineCommenting({
    enabled: lineCommentingEnabled,
    resetKey: filePath,
  });
  const commitLineComment = (
    selection: Pick<FileCommentSelection, "startLine" | "endLine" | "text">,
  ) => {
    if (filePath) {
      onCommentInChat?.({ path: filePath, ...selection });
    }
  };
  const [browserOpenState, setBrowserOpenState] = useState<{
    filePath: string;
    status: "opening" | "error";
    action: "open-browser" | "copy-url";
    message?: string;
  } | null>(null);
  const browserOpenStateForFile = browserOpenState?.filePath === filePath ? browserOpenState : null;
  const handleOpenInBrowser = async () => {
    if (!filePath || !fileIsHtml || !props.onOpenInBrowser) {
      return;
    }
    setBrowserOpenState({ filePath, status: "opening", action: "open-browser" });
    try {
      const request = await createWorkspaceHtmlBrowserOpenRequest({
        queryClient,
        filePath,
        workspaceRoot,
        referenceRoot: props.referenceRoot,
      });
      props.onOpenInBrowser(request);
      setBrowserOpenState(null);
    } catch (error) {
      setBrowserOpenState({
        filePath,
        status: "error",
        action: "open-browser",
        message: error instanceof Error ? error.message : "Could not open HTML in the browser.",
      });
    }
  };
  const handleCopyPreviewUrl = async () => {
    if (!filePath || !fileIsHtml) {
      return;
    }
    setBrowserOpenState(null);
    try {
      const grantResult = (await htmlPreviewGrantQuery.refetch()).data;
      if (!isLocalPreviewGrantUsable(grantResult) || !grantResult?.urlPath) {
        throw new Error("Could not create a current preview URL.");
      }
      await copyTextToClipboard(buildLocalPreviewCapabilityUrl(grantResult.urlPath));
    } catch (error) {
      setBrowserOpenState({
        filePath,
        status: "error",
        action: "copy-url",
        message: error instanceof Error ? error.message : "Could not copy the preview URL.",
      });
    }
  };
  const handleRefreshPreview = () => {
    setBrowserOpenState(null);
    void htmlPreviewGrantQuery.refetch();
  };

  // Right-click references the selected line range in the source view,
  // otherwise the whole file. The rendered-markdown view yields no selection
  // (readPreviewSelection returns null there), so it always falls back to the
  // whole-file reference.
  const handleContentsContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!filePath) {
      return;
    }
    event.preventDefault();
    const container = contentsRef.current;
    const selection = container ? readPreviewSelection(container) : null;
    void showFileReferenceContextMenu({
      path: filePath,
      position: { x: event.clientX, y: event.clientY },
      selection,
      onReferenceInChat,
      onAskWhyInChat,
      onOpenInBrowser:
        fileIsHtml && props.onOpenInBrowser ? () => void handleOpenInBrowser() : undefined,
    });
  };
  // Clicking a task checkbox in the markdown preview persists the toggle to
  // disk: optimistic cache update first, ordered write-through after, refetch
  // on failure so the preview never drifts from the file.
  const handleTaskToggle = ({ sourceLine, checked }: { sourceLine: number; checked: boolean }) => {
    if (!workspaceRoot || !filePath) {
      return;
    }
    const options = projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath: filePath });
    const current = queryClient.getQueryData(options.queryKey);
    if (!current || current.truncated) {
      return;
    }
    const nextContents = toggleMarkdownTaskMarker(current.contents, sourceLine, checked);
    if (nextContents === null) {
      return;
    }
    // No API means no write can happen — bail before the optimistic update
    // so the preview never shows a toggle that was silently dropped.
    const api = readNativeApi();
    if (!api) {
      return;
    }
    queryClient.setQueryData(options.queryKey, { ...current, contents: nextContents });
    // The read RPC may have resolved a bare/partial reference (e.g. a clicked
    // `notes.md`) to its real nested path. Write back to that resolved path,
    // not the opened reference, so the toggle lands on the file we read from
    // instead of creating a stray file at the workspace root.
    const writeRelativePath = current.relativePath;
    // Writes carry the full file contents, so serialize them: a slower earlier
    // checkbox write must never land after a newer toggle and erase it.
    const fileKey = `${workspaceRoot}\0${filePath}`;
    const writeVersion = latestTaskWriteVersionRef.current.next + 1;
    latestTaskWriteVersionRef.current.next = writeVersion;
    latestTaskWriteVersionRef.current.byFile.set(fileKey, writeVersion);
    taskWriteQueueRef.current = taskWriteQueueRef.current
      .catch(() => undefined)
      .then(() =>
        api.projects.writeFile({
          cwd: workspaceRoot,
          relativePath: writeRelativePath,
          contents: nextContents,
        }),
      )
      .then(() => undefined)
      .catch(() => {
        if (latestTaskWriteVersionRef.current.byFile.get(fileKey) !== writeVersion) {
          return;
        }
        void queryClient.invalidateQueries({ queryKey: options.queryKey });
      });
    void taskWriteQueueRef.current;
  };
  const handleRenderedPreviewChange = (rendered: boolean) => {
    setRenderedPreviewOverride({ filePath, rendered });
  };
  // Toggling a task rewrites the file, so only enable it when the preview
  // holds the complete contents (writing a truncated read would corrupt it).
  const canToggleTasks =
    props.workspaceRoot !== null &&
    fileIsMarkdown &&
    fileIsWorkspaceRelative &&
    fileQuery.data !== undefined &&
    !fileQuery.data.truncated;

  if (props.filePath === null) {
    return (
      props.emptyState ?? (
        <PanelStateMessage density="compact" fill="flex">
          <p>Select a file from the explorer.</p>
        </PanelStateMessage>
      )
    );
  }
  if (fileIntent?.kind === "failure") {
    const message =
      fileIntent.reason === "missing"
        ? "The file could not be found. It may have been moved or deleted."
        : fileIntent.reason === "outside-workspace"
          ? !workspaceRoot && !isLocalAbsolutePath(props.filePath)
            ? "No workspace is attached to this chat."
            : "This file is outside the active workspace and cannot be previewed."
          : fileIntent.reason === "unsupported-browser-file"
            ? "Only HTML files can open in the browser."
            : "The file path is invalid.";
    return <FilePreviewErrorState message={message} />;
  }
  if (!filePath) {
    return <FilePreviewErrorState message="The file path is invalid." />;
  }
  if (fileNeedsLocalPreviewGrant && !localPreviewGrant) {
    if (localPreviewGrantQuery.error) {
      return (
        <FilePreviewErrorState
          message={
            localPreviewGrantQuery.error instanceof Error
              ? localPreviewGrantQuery.error.message
              : "Could not authorize this local file preview."
          }
          onRetry={() => void localPreviewGrantQuery.refetch()}
        />
      );
    }
    return <FilePreviewLoadingState />;
  }

  // PDFs own their full surface — toolbar (file name, page nav, zoom, Open) plus
  // the rendered page stack — so they skip the shared breadcrumb header here.
  if (fileIsPdf) {
    const openInTarget =
      props.workspaceRoot && isWorkspaceRelativePathSafe(filePath)
        ? joinWorkspaceRelativePath(props.workspaceRoot, filePath)
        : filePath;
    return (
      <PdfFilePreview
        key={binaryPreviewKey}
        filePath={filePath}
        cwd={props.workspaceRoot}
        previewGrant={localPreviewGrant}
        openInTarget={openInTarget}
        onClosePanel={props.onClosePanel}
      />
    );
  }

  const hoveredCommentLine = lineCommenting.hoveredLine;
  const activeCommentLine = lineCommenting.activeLine;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <WorkspaceFilePreviewHeader
        workspaceRoot={props.workspaceRoot}
        filePath={filePath}
        renderedPreviewKind={fileIsHtml ? "html" : fileIsMarkdown ? "markdown" : null}
        renderedPreviewEnabled={showRenderedPreview}
        onRenderedPreviewChange={handleRenderedPreviewChange}
        onReferenceInChat={onReferenceInChat}
        onAskWhyInChat={onAskWhyInChat}
        onOpenInBrowser={
          fileIsHtml && props.onOpenInBrowser ? () => void handleOpenInBrowser() : undefined
        }
        onCopyPreviewUrl={fileIsHtml ? handleCopyPreviewUrl : undefined}
        onRefreshPreview={fileIsHtml ? handleRefreshPreview : undefined}
        openingInBrowser={browserOpenStateForFile?.status === "opening"}
        truncated={fileQuery.data?.truncated ?? false}
        onClosePanel={props.onClosePanel}
      />
      {browserOpenStateForFile?.status === "error" ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border/65 px-3 py-2 text-[11px] text-destructive/85"
        >
          <span>{browserOpenStateForFile.message ?? "Could not open HTML in the browser."}</span>
          {browserOpenStateForFile.action === "open-browser" && props.onOpenInBrowser ? (
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-md border border-border px-2 py-1 text-foreground hover:bg-secondary"
              onClick={() => void handleOpenInBrowser()}
            >
              Retry
            </button>
          ) : browserOpenStateForFile.action === "copy-url" && fileIsHtml ? (
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-md border border-border px-2 py-1 text-foreground hover:bg-secondary"
              onClick={handleCopyPreviewUrl}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {fileIsImage ? (
        <div
          className="editor-file-viewer min-h-0 flex-1 overflow-auto"
          onContextMenu={handleContentsContextMenu}
        >
          <LocalImagePreview
            key={binaryPreviewKey}
            src={filePath}
            cwd={props.workspaceRoot}
            previewGrant={localPreviewGrant}
            alt={basenameOfPath(filePath)}
            className="min-h-full"
            imageClassName="max-h-[calc(100vh-13rem)]"
          />
        </div>
      ) : fileIsUnsupportedBinary || fileContentsAreBinary ? (
        <FilePreviewErrorState message="This binary file type is not supported for in-app preview." />
      ) : fileIsHtml && showRenderedPreview ? (
        htmlPreviewGrantQuery.isLoading || (htmlPreviewGrantQuery.isFetching && !htmlPreviewUrl) ? (
          <FilePreviewLoadingState />
        ) : htmlPreviewGrantQuery.error ? (
          <FilePreviewErrorState
            message={
              htmlPreviewGrantQuery.error instanceof Error
                ? htmlPreviewGrantQuery.error.message
                : "Could not create the HTML preview."
            }
            onRetry={() => void htmlPreviewGrantQuery.refetch()}
          />
        ) : !htmlPreviewUrl ? (
          <FilePreviewErrorState
            message="The server did not return an HTML preview URL."
            onRetry={() => void htmlPreviewGrantQuery.refetch()}
          />
        ) : (
          <iframe
            key={htmlPreviewUrl}
            src={htmlPreviewUrl}
            title={`Preview of ${basenameOfPath(filePath)}`}
            sandbox=""
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 border-0 bg-white"
          />
        )
      ) : fileQuery.isLoading ? (
        <FilePreviewLoadingState />
      ) : fileQuery.error ? (
        <FilePreviewErrorState
          message={
            fileQuery.error instanceof Error ? fileQuery.error.message : "Could not read file."
          }
          onRetry={() => void fileQuery.refetch()}
        />
      ) : (
        <div
          ref={contentsRef}
          className={cn(
            "editor-file-viewer min-h-0 flex-1 overflow-auto",
            fileIsMarkdown && showRenderedPreview && "editor-file-viewer--markdown-preview",
          )}
          onContextMenu={handleContentsContextMenu}
          onMouseUp={previewSelectionAction.onContainerMouseUp}
          onMouseMove={lineCommenting.onContainerMouseMove}
          onMouseLeave={lineCommenting.onContainerMouseLeave}
        >
          {fileIsMarkdown && showRenderedPreview ? (
            <div className="editor-markdown-preview">
              <ChatMarkdown
                text={fileContents}
                cwd={markdownPreviewCwd(props.workspaceRoot, filePath)}
                isStreaming={false}
                className="editor-markdown-preview__body text-sm leading-relaxed"
                {...(canToggleTasks ? { onTaskToggle: handleTaskToggle } : {})}
              />
            </div>
          ) : (
            <FileContentsView path={filePath} contents={fileContents} themeName={diffThemeName} />
          )}
          {!showRenderedPreview && lineCount > 0 ? (
            <span className="sr-only">{lineCount} lines</span>
          ) : null}
          {previewSelectionAction.pendingAction ? (
            <TranscriptSelectionAction
              left={previewSelectionAction.pendingAction.left}
              top={previewSelectionAction.pendingAction.top}
              placement={previewSelectionAction.pendingAction.placement}
              onAddToChat={previewSelectionAction.commit}
            />
          ) : null}
          {lineCommentingEnabled && hoveredCommentLine && !activeCommentLine ? (
            <button
              type="button"
              className="editor-file-viewer__comment-add"
              style={{
                top: hoveredCommentLine.top,
                left: hoveredCommentLine.left,
                height: hoveredCommentLine.height,
              }}
              aria-label={`Comment on line ${hoveredCommentLine.lineNumber}`}
              title="Comment"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                lineCommenting.openComment(hoveredCommentLine);
              }}
            >
              <span className="editor-file-viewer__comment-add-glyph">
                <PlusIcon className="size-3.5" />
              </span>
            </button>
          ) : null}
          {lineCommentingEnabled && activeCommentLine ? (
            <>
              <div
                className="editor-file-viewer__comment-line-highlight"
                style={{ top: activeCommentLine.top, height: activeCommentLine.height }}
                aria-hidden="true"
              />
              <FileLineCommentBox
                lineLabel={formatFileCommentRange({
                  startLine: activeCommentLine.lineNumber,
                  endLine: activeCommentLine.lineNumber,
                })}
                top={activeCommentLine.top + activeCommentLine.height}
                left={activeCommentLine.left}
                width={Math.max(
                  240,
                  Math.min(440, activeCommentLine.containerWidth - activeCommentLine.left - 16),
                )}
                onCancel={lineCommenting.closeComment}
                onSubmit={(text) => {
                  commitLineComment({
                    startLine: activeCommentLine.lineNumber,
                    endLine: activeCommentLine.lineNumber,
                    text,
                  });
                  lineCommenting.closeComment();
                }}
              />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
