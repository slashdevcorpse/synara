// FILE: localFileOpenIntent.ts
// Purpose: Pure policy for resolving local file references against the active
//          runtime workspace and choosing their in-app/open-in-browser behavior.
// Layer: Web UI policy (no browser or API side effects)
// Exports: local file reference parsing, active-worktree remapping, content
//          classification, and structured open intents.

import {
  isSupportedLocalHtmlPath,
  isSupportedLocalImagePath,
  isSupportedLocalPdfPath,
  lowerCaseExtensionOf,
} from "@synara/shared/localPreviewFiles";
import {
  isLocalAbsolutePath,
  isUncPath,
  isWindowsDrivePath,
  isWorkspaceRelativePathSafe,
  joinWorkspaceRelativePath,
} from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";

const MARKDOWN_PREVIEW_EXTENSIONS = new Set([".markdown", ".md", ".mdx"]);

// These formats are known to be binary and have no dedicated standalone
// renderer. Everything else is read as text first; content sniffing below
// catches extensionless and unfamiliar binary files without maintaining an
// ever-growing text-extension allowlist.
const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".apk",
  ".bin",
  ".bz2",
  ".class",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".eot",
  ".exe",
  ".gz",
  ".jar",
  ".lockb",
  ".mp3",
  ".mp4",
  ".o",
  ".obj",
  ".otf",
  ".pdb",
  ".ppt",
  ".pptx",
  ".psd",
  ".rar",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tgz",
  ".ttf",
  ".wav",
  ".wasm",
  ".webm",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
]);

const FILE_POSITION_SUFFIX_PATTERN = /:(\d+)(?::(\d+))?$/;

export interface LocalFilePosition {
  readonly line: number;
  readonly column?: number;
}

export interface ParsedLocalFileReference {
  readonly path: string;
  readonly position: LocalFilePosition | null;
}

export function parseLocalFileReference(rawPath: string): ParsedLocalFileReference | null {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const match = trimmed.match(FILE_POSITION_SUFFIX_PATTERN);
  if (!match?.[1]) {
    return { path: trimmed, position: null };
  }
  const line = Number.parseInt(match[1], 10);
  const rawColumn = match[2];
  return {
    path: trimmed.slice(0, match.index),
    position: {
      line,
      ...(rawColumn ? { column: Number.parseInt(rawColumn, 10) } : {}),
    },
  };
}

function normalizeRootForComparison(value: string): {
  readonly original: string;
  readonly comparison: string;
  readonly windowsLike: boolean;
} {
  const normalized = value.trim().replace(/\\/g, "/");
  const original = normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
  const windowsLike = isWindowsDrivePath(original) || isUncPath(value.trim());
  return {
    original,
    comparison: windowsLike ? original.toLowerCase() : original,
    windowsLike,
  };
}

function relativePathWithinRoot(targetPath: string, rootPath: string): string | null {
  const target = normalizeRootForComparison(targetPath);
  const root = normalizeRootForComparison(rootPath);
  if (
    target.original.length === 0 ||
    root.original.length === 0 ||
    target.windowsLike !== root.windowsLike
  ) {
    return null;
  }
  const targetComparison = target.comparison;
  const rootComparison = root.comparison;
  const rootPrefix = rootComparison === "/" ? "/" : `${rootComparison}/`;
  if (!targetComparison.startsWith(rootPrefix)) {
    return null;
  }
  const relativeOffset = root.original === "/" ? 1 : root.original.length + 1;
  const relativePath = target.original.slice(relativeOffset).replace(/\/+$/, "");
  return isWorkspaceRelativePathSafe(relativePath) ? relativePath : null;
}

export type ResolvedLocalFilePath =
  | {
      readonly kind: "workspace";
      /** Workspace-relative path consumed by project file APIs. */
      readonly path: string;
      /** Absolute path under the active runtime root. */
      readonly absolutePath: string;
      readonly remappedFromReferenceRoot: boolean;
      readonly position: LocalFilePosition | null;
    }
  | {
      readonly kind: "scratch";
      readonly path: string;
      readonly absolutePath: string;
      readonly remappedFromReferenceRoot: false;
      readonly position: LocalFilePosition | null;
    }
  | {
      readonly kind: "outside";
      readonly path: string;
      readonly position: LocalFilePosition | null;
    }
  | {
      readonly kind: "invalid";
      readonly path: string;
      readonly position: null;
    };

/**
 * Resolve a local reference against the active runtime root. Absolute links
 * copied from the original project root are remapped by suffix into an active
 * worktree when `referenceRoot` is supplied. Other absolute paths fail closed,
 * except Synara scratch workspaces which retain their trusted absolute path.
 */
export function resolveActiveWorkspaceFilePath(input: {
  readonly rawPath: string;
  readonly runtimeRoot: string | null;
  readonly referenceRoot?: string | null | undefined;
}): ResolvedLocalFilePath {
  const parsed = parseLocalFileReference(input.rawPath);
  if (!parsed || parsed.path.length === 0) {
    return { kind: "invalid", path: "", position: null };
  }

  if (isWorkspaceRelativePathSafe(parsed.path)) {
    if (!input.runtimeRoot) {
      return { kind: "outside", path: parsed.path, position: parsed.position };
    }
    return {
      kind: "workspace",
      path: parsed.path.replace(/\\/g, "/"),
      absolutePath: joinWorkspaceRelativePath(input.runtimeRoot, parsed.path.replace(/\\/g, "/")),
      remappedFromReferenceRoot: false,
      position: parsed.position,
    };
  }

  if (!isLocalAbsolutePath(parsed.path)) {
    return { kind: "outside", path: parsed.path, position: parsed.position };
  }

  if (isScratchWorkspacePath(parsed.path)) {
    return {
      kind: "scratch",
      path: parsed.path,
      absolutePath: parsed.path,
      remappedFromReferenceRoot: false,
      position: parsed.position,
    };
  }

  if (input.runtimeRoot) {
    const activeRelativePath = relativePathWithinRoot(parsed.path, input.runtimeRoot);
    if (activeRelativePath) {
      return {
        kind: "workspace",
        path: activeRelativePath,
        absolutePath: joinWorkspaceRelativePath(input.runtimeRoot, activeRelativePath),
        remappedFromReferenceRoot: false,
        position: parsed.position,
      };
    }
  }

  if (input.runtimeRoot && input.referenceRoot) {
    const referenceRelativePath = relativePathWithinRoot(parsed.path, input.referenceRoot);
    if (referenceRelativePath) {
      return {
        kind: "workspace",
        path: referenceRelativePath,
        absolutePath: joinWorkspaceRelativePath(input.runtimeRoot, referenceRelativePath),
        remappedFromReferenceRoot: true,
        position: parsed.position,
      };
    }
  }

  return { kind: "outside", path: parsed.path, position: parsed.position };
}

export function isMarkdownPreviewablePath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && MARKDOWN_PREVIEW_EXTENSIONS.has(extension);
}

export type LocalFilePreviewKind =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "text"
  | "unsupported-binary";

export function localFilePreviewKindForPath(filePath: string): LocalFilePreviewKind {
  if (isMarkdownPreviewablePath(filePath)) return "markdown";
  if (isSupportedLocalHtmlPath(filePath)) return "html";
  if (isSupportedLocalImagePath(filePath)) return "image";
  if (isSupportedLocalPdfPath(filePath)) return "pdf";
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && UNSUPPORTED_BINARY_EXTENSIONS.has(extension)
    ? "unsupported-binary"
    : "text";
}

/** Conservative content sniff for extensionless or unfamiliar binary files. */
export function isProbablyBinaryFileContents(contents: string): boolean {
  const sample = contents.slice(0, 8_192);
  if (sample.includes("\0")) {
    return true;
  }
  if (sample.length === 0) {
    return false;
  }
  let controlCharacters = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") {
      controlCharacters += 1;
    }
  }
  return controlCharacters / sample.length > 0.1;
}

interface LocalFileIntentBase {
  readonly path: string;
  readonly absolutePath: string;
  readonly position: LocalFilePosition | null;
  readonly remappedFromReferenceRoot: boolean;
}

export type LocalFileOpenIntent =
  | (LocalFileIntentBase & { readonly kind: "preview-markdown" })
  | (LocalFileIntentBase & { readonly kind: "preview-html" })
  | (LocalFileIntentBase & { readonly kind: "preview-image" })
  | (LocalFileIntentBase & { readonly kind: "preview-pdf" })
  | (LocalFileIntentBase & { readonly kind: "preview-text" })
  | (LocalFileIntentBase & { readonly kind: "unsupported-binary" })
  | (LocalFileIntentBase & { readonly kind: "browser-html" })
  | {
      readonly kind: "external-editor";
      readonly path: string;
      readonly position: LocalFilePosition | null;
    }
  | {
      readonly kind: "failure";
      readonly path: string;
      readonly position: LocalFilePosition | null;
      readonly reason:
        | "invalid-path"
        | "missing"
        | "outside-workspace"
        | "unsupported-browser-file";
    };

export function resolveLocalFileOpenIntent(input: {
  readonly rawPath: string;
  readonly runtimeRoot: string | null;
  readonly referenceRoot?: string | null | undefined;
  readonly action?: "preview" | "browser";
  readonly forceExternalEditor?: boolean;
  /** Preserve the legacy exact-file-grant preview for non-HTML local files. */
  readonly allowOutsideWorkspaceFilePreview?: boolean;
  /** Optional filesystem result supplied by callers that have already probed. */
  readonly exists?: boolean;
}): LocalFileOpenIntent {
  const parsed = parseLocalFileReference(input.rawPath);
  if (!parsed || parsed.path.length === 0) {
    return { kind: "failure", path: "", position: null, reason: "invalid-path" };
  }
  if (input.forceExternalEditor) {
    return { kind: "external-editor", path: parsed.path, position: parsed.position };
  }

  const resolution = resolveActiveWorkspaceFilePath(input);
  if (resolution.kind === "invalid") {
    return { kind: "failure", path: "", position: null, reason: "invalid-path" };
  }
  let base: LocalFileIntentBase;
  if (resolution.kind === "outside") {
    const previewKind = localFilePreviewKindForPath(resolution.path);
    const isNetworkPath = isUncPath(resolution.path) || resolution.path.startsWith("//");
    if (
      input.action === "browser" ||
      !input.allowOutsideWorkspaceFilePreview ||
      !isLocalAbsolutePath(resolution.path) ||
      isNetworkPath ||
      previewKind === "html"
    ) {
      return {
        kind: "failure",
        path: resolution.path,
        position: resolution.position,
        reason: "outside-workspace",
      };
    }
    base = {
      path: resolution.path,
      absolutePath: resolution.path,
      position: resolution.position,
      remappedFromReferenceRoot: false,
    };
  } else {
    base = {
      path: resolution.path,
      absolutePath: resolution.absolutePath,
      position: resolution.position,
      remappedFromReferenceRoot: resolution.remappedFromReferenceRoot,
    };
  }
  if (input.exists === false) {
    return {
      kind: "failure",
      path: base.path,
      position: base.position,
      reason: "missing",
    };
  }

  const previewKind = localFilePreviewKindForPath(base.path);
  if (input.action === "browser") {
    return previewKind === "html"
      ? { ...base, kind: "browser-html" }
      : {
          kind: "failure",
          path: base.path,
          position: base.position,
          reason: "unsupported-browser-file",
        };
  }

  switch (previewKind) {
    case "markdown":
      return { ...base, kind: "preview-markdown" };
    case "html":
      return { ...base, kind: "preview-html" };
    case "image":
      return { ...base, kind: "preview-image" };
    case "pdf":
      return { ...base, kind: "preview-pdf" };
    case "unsupported-binary":
      return { ...base, kind: "unsupported-binary" };
    case "text":
      return { ...base, kind: "preview-text" };
  }
}
