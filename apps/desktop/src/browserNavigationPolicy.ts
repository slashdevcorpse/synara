// FILE: browserNavigationPolicy.ts
// Purpose: Pure allowlist for Electron browser navigation and local-preview capabilities.
// Layer: Desktop browser security policy
// Exports: capability parsing plus page-navigation policy checks

import { classifyBrowserInput, normalizeBrowserUrlInput } from "@synara/shared/browserSession";
import { LOCAL_PREVIEW_ROUTE_PREFIX as LOCAL_PREVIEW_ROUTE_PATH } from "@synara/shared/localPreviewFiles";

export const LOCAL_PREVIEW_ROUTE_PREFIX = `${LOCAL_PREVIEW_ROUTE_PATH}/`;

export interface LocalPreviewCapability {
  readonly origin: string;
  readonly pathPrefix: string;
  readonly token: string;
}

export interface ManagedBrowserNavigationTarget {
  readonly localFilePath: string | null;
  readonly localPreviewCapability: LocalPreviewCapability | null;
  readonly url: string;
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const withoutBrackets = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  const normalized = withoutBrackets.endsWith(".") ? withoutBrackets.slice(0, -1) : withoutBrackets;
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }

  const ipv4Octets = normalized.split(".");
  if (
    ipv4Octets.length === 4 &&
    ipv4Octets[0] === "127" &&
    ipv4Octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  ) {
    return true;
  }

  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  const mappedIpv4FirstHextet = mappedIpv4?.[1];
  return (
    mappedIpv4FirstHextet !== undefined &&
    (Number.parseInt(mappedIpv4FirstHextet, 16) & 0xff00) === 0x7f00
  );
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function hasCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
}

function isLocalPreviewRouteCandidate(url: URL): boolean {
  return (
    isHttpUrl(url) &&
    (url.pathname === LOCAL_PREVIEW_ROUTE_PATH ||
      url.pathname.startsWith(LOCAL_PREVIEW_ROUTE_PREFIX))
  );
}

function isLoopbackPreviewRouteCandidate(url: URL): boolean {
  return isLocalPreviewRouteCandidate(url) && isLoopbackHostname(url.hostname);
}

export function isLocalPreviewRouteUrl(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  return url !== null && isLocalPreviewRouteCandidate(url);
}

export function isLoopbackLocalPreviewRouteUrl(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  return url !== null && isLoopbackPreviewRouteCandidate(url);
}

/**
 * Parses the capability identity from an internal local-preview URL. The first
 * path segment after the dedicated route is the opaque token; deeper paths are
 * resources within that same capability and do not widen its authority.
 */
export function parseLocalPreviewCapabilityUrl(rawUrl: string): LocalPreviewCapability | null {
  const url = parseUrl(rawUrl);
  if (!url || !isLoopbackPreviewRouteCandidate(url) || hasCredentials(url)) {
    return null;
  }

  const pathAfterRoute = url.pathname.slice(LOCAL_PREVIEW_ROUTE_PREFIX.length);
  const token = pathAfterRoute.split("/", 1)[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }

  return {
    origin: url.origin,
    pathPrefix: `${LOCAL_PREVIEW_ROUTE_PREFIX}${token}`,
    token,
  };
}

/**
 * Ordinary tabs accept normal web traffic and about:blank. Internal preview
 * routes are excluded unless the tab carries the matching capability metadata.
 */
export function isAllowedBrowserNavigation(input: {
  readonly url: string;
  readonly localPreviewCapability?: LocalPreviewCapability | null;
}): boolean {
  const url = parseUrl(input.url);
  if (!url) {
    return false;
  }

  const capability = input.localPreviewCapability ?? null;
  if (!capability) {
    if (url.href === "about:blank") {
      return true;
    }
    return isHttpUrl(url) && !isLocalPreviewRouteCandidate(url);
  }

  if (!isHttpUrl(url) || hasCredentials(url) || url.origin !== capability.origin) {
    return false;
  }
  return (
    url.pathname === capability.pathPrefix || url.pathname.startsWith(`${capability.pathPrefix}/`)
  );
}

/**
 * Normalizes an explicit browser command and enforces the pairing between an
 * opaque preview URL and its user-facing local path. Neither half is accepted
 * on its own, and generic commands cannot smuggle a preview route into a web tab.
 */
export function resolveManagedBrowserNavigation(input: {
  readonly url: string | undefined;
  readonly localFilePath?: string | null;
}): ManagedBrowserNavigationTarget {
  const url = normalizeBrowserUrlInput(input.url);
  const localFilePathInput = input.localFilePath?.trim() || null;
  const localFileClassification = localFilePathInput
    ? classifyBrowserInput(localFilePathInput)
    : null;
  if (
    localFileClassification &&
    (localFileClassification.kind !== "local-file" || localFileClassification.source !== "path")
  ) {
    throw new Error("Local preview metadata must be an absolute local file path.");
  }
  const localFilePath =
    localFileClassification?.kind === "local-file" ? localFileClassification.path : null;
  const localPreviewCapability = parseLocalPreviewCapabilityUrl(url);

  if (localFilePath) {
    if (!localPreviewCapability || !isAllowedBrowserNavigation({ url, localPreviewCapability })) {
      throw new Error("Local files require a trusted preview capability URL.");
    }
    return { localFilePath, localPreviewCapability, url };
  }

  if (localPreviewCapability || !isAllowedBrowserNavigation({ url })) {
    throw new Error("This browser URL is not allowed.");
  }
  return { localFilePath: null, localPreviewCapability: null, url };
}
