// FILE: externalUrlPolicy.ts
// Purpose: Validates URLs before the desktop shell delegates them to an external application.
// Layer: Desktop security policy
// Exports: Safe HTTP(S) URL normalization with internal-capability exclusion

import { isLocalPreviewRouteUrl } from "./browserNavigationPolicy";

export function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }
  if (isLocalPreviewRouteUrl(parsedUrl.toString())) {
    return null;
  }

  return parsedUrl.toString();
}
