import * as Path from "node:path";

import { WEB_DOCUMENT_SECURITY_HEADERS } from "@synara/shared/webSecurity";
import { describe, expect, it, vi } from "vitest";

import {
  createDesktopStaticProtocolHandler,
  createDesktopStaticProtocolResolver,
} from "./desktopStaticProtocol";

const staticRoot = Path.resolve("/virtual/synara-static");
const rootIndex = Path.join(staticRoot, "index.html");

function resolverWithExistingPaths(paths: ReadonlyArray<string>) {
  const existingPaths = new Set(paths.map((entry) => Path.resolve(entry)));
  return createDesktopStaticProtocolResolver(staticRoot, (candidate) =>
    existingPaths.has(Path.resolve(candidate)),
  );
}

describe("createDesktopStaticProtocolResolver", () => {
  it("resolves an existing asset inside the static root", () => {
    const assetPath = Path.join(staticRoot, "assets", "app.js");
    const resolveRequest = resolverWithExistingPaths([rootIndex, assetPath]);

    expect(resolveRequest("synara://app/assets/app.js")).toEqual({ path: assetPath });
  });

  it("returns Electron file-not-found for a missing asset", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("synara://app/assets/missing.js")).toEqual({ error: -6 });
  });

  it("resolves an extensionless route to its existing nested index", () => {
    const nestedIndex = Path.join(staticRoot, "settings", "index.html");
    const resolveRequest = resolverWithExistingPaths([rootIndex, nestedIndex]);

    expect(resolveRequest("synara://app/settings")).toEqual({ path: nestedIndex });
  });

  it("falls back to the root index for a missing navigation route", () => {
    const resolveRequest = resolverWithExistingPaths([rootIndex]);

    expect(resolveRequest("synara://app/thread/missing")).toEqual({ path: rootIndex });
  });

  it("keeps encoded traversal inside the root and safely handles malformed encoding", () => {
    const observedPaths: string[] = [];
    const resolveRequest = createDesktopStaticProtocolResolver(staticRoot, (candidate) => {
      const resolvedCandidate = Path.resolve(candidate);
      observedPaths.push(resolvedCandidate);
      return resolvedCandidate === rootIndex;
    });

    expect(resolveRequest("synara://app/..%2Foutside.js")).toEqual({ error: -6 });
    expect(resolveRequest("synara://app/%E0%A4%A")).toEqual({ path: rootIndex });
    expect(
      observedPaths.every(
        (candidate) => candidate === staticRoot || candidate.startsWith(`${staticRoot}${Path.sep}`),
      ),
    ).toBe(true);
  });
});

describe("createDesktopStaticProtocolHandler", () => {
  it("applies packaged document security headers to fetched responses", async () => {
    const fetchFile = vi.fn(async () =>
      Promise.resolve(new Response("Synara", { headers: { "Content-Type": "text/html" } })),
    );
    const handle = createDesktopStaticProtocolHandler({
      resolveRequest: () => ({ path: rootIndex }),
      fetchFile,
      fallbackUrl: "synara://app/",
    });

    const response = await handle({ url: "synara://app/settings" });

    expect(fetchFile).toHaveBeenCalledWith(rootIndex);
    expect(response.headers.get("content-security-policy")).toBe(
      WEB_DOCUMENT_SECURITY_HEADERS["Content-Security-Policy"],
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("Synara");
  });

  it("applies packaged document security headers to missing responses", async () => {
    const handle = createDesktopStaticProtocolHandler({
      resolveRequest: () => ({ error: -6 }),
      fetchFile: vi.fn(),
      fallbackUrl: "synara://app/",
    });

    const response = await handle({ url: "synara://app/assets/missing.js" });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toBe(
      WEB_DOCUMENT_SECURITY_HEADERS["Content-Security-Policy"],
    );
  });

  it("applies packaged document security headers after falling back from a fetch failure", async () => {
    const fetchFile = vi
      .fn<(path: string) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("bundle read failed"))
      .mockResolvedValueOnce(new Response("fallback"));
    const resolveRequest = vi.fn((requestUrl: string) => ({
      path: requestUrl === "synara://app/" ? rootIndex : Path.join(staticRoot, "settings.html"),
    }));
    const handle = createDesktopStaticProtocolHandler({
      resolveRequest,
      fetchFile,
      fallbackUrl: "synara://app/",
    });

    const response = await handle({ url: "synara://app/settings" });

    expect(fetchFile).toHaveBeenCalledTimes(2);
    expect(fetchFile).toHaveBeenLastCalledWith(rootIndex);
    expect(response.headers.get("content-security-policy")).toBe(
      WEB_DOCUMENT_SECURITY_HEADERS["Content-Security-Policy"],
    );
    await expect(response.text()).resolves.toBe("fallback");
  });
});
