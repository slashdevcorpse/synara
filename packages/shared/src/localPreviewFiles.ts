// FILE: localPreviewFiles.ts
// Purpose: Single source of truth for local preview route shapes, extension
//          allowlists, and explicit response MIME types consumed by the server
//          and web client.
// Layer: Shared utility (no runtime dependencies)
// Exports: route path, preview-file extension allowlists, and helper predicates
//          derived from them.

export const LOCAL_IMAGE_ROUTE_PATH = "/api/local-image" as const;
export const LOCAL_PREVIEW_ROUTE_PREFIX = "/api/local-preview" as const;

// Lower-case extensions (with leading dot) that the server is willing to serve and
// the web client is willing to treat as local-image markdown sources. Keep these in
// sync with the MIME allowlist used elsewhere; this list is the canonical answer.
export const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tiff",
  ".webp",
] as const;

const SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_IMAGE_EXTENSIONS,
);

/** Lower-cased extension (with leading dot) of a path, or null when there is none. */
export function lowerCaseExtensionOf(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  return filePath.slice(dot).toLowerCase();
}

export function isSupportedLocalImagePath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_IMAGE_EXTENSIONS_SET.has(extension);
}

export const SUPPORTED_LOCAL_PDF_EXTENSION = ".pdf" as const;

export function isSupportedLocalPdfPath(filePath: string): boolean {
  return lowerCaseExtensionOf(filePath) === SUPPORTED_LOCAL_PDF_EXTENSION;
}

// Full allowlist for the /api/local-image serving route. Markdown image source
// detection (below) intentionally stays image-only: a `.pdf` link in chat
// markdown must never be inlined as an <img>.
export function isSupportedLocalPreviewFilePath(filePath: string): boolean {
  return isSupportedLocalImagePath(filePath) || isSupportedLocalPdfPath(filePath);
}

export const SUPPORTED_LOCAL_HTML_EXTENSIONS = [".htm", ".html"] as const;

const SUPPORTED_LOCAL_HTML_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_HTML_EXTENSIONS,
);

export function isSupportedLocalHtmlPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_HTML_EXTENSIONS_SET.has(extension);
}

// Directory capabilities intentionally expose only resources a local HTML demo
// commonly needs. Source maps, archives, native modules, executables, and unknown
// binary formats stay outside this allowlist.
export const SUPPORTED_LOCAL_PREVIEW_ASSET_EXTENSIONS = [
  ...SUPPORTED_LOCAL_HTML_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".json",
  ".mp3",
  ".ogg",
  ".wav",
  ".mp4",
  ".webm",
  ...SUPPORTED_LOCAL_IMAGE_EXTENSIONS,
  SUPPORTED_LOCAL_PDF_EXTENSION,
] as const;

const SUPPORTED_LOCAL_PREVIEW_ASSET_EXTENSIONS_SET: ReadonlySet<string> = new Set(
  SUPPORTED_LOCAL_PREVIEW_ASSET_EXTENSIONS,
);

export function isSupportedLocalPreviewAssetPath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && SUPPORTED_LOCAL_PREVIEW_ASSET_EXTENSIONS_SET.has(extension);
}

const LOCAL_PREVIEW_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export function localPreviewContentTypeForPath(filePath: string): string | null {
  const extension = lowerCaseExtensionOf(filePath);
  return extension === null ? null : (LOCAL_PREVIEW_CONTENT_TYPE_BY_EXTENSION[extension] ?? null);
}

// Built from the canonical extensions list so the web regex never drifts from the
// server allowlist. Anchored at end-of-string to match `.png`-style suffixes only.
export const SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX: RegExp = (() => {
  const escaped = SUPPORTED_LOCAL_IMAGE_EXTENSIONS.map((extension) =>
    extension.slice(1).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`\\.(?:${escaped.join("|")})$`, "i");
})();
