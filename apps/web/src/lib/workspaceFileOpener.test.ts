import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkspaceHtmlBrowserOpenRequest,
  prefetchWorkspaceFile,
  resolveDockFileOpenTarget,
  resolveScratchPreviewFileOpenTarget,
  resolveWorkspaceFileOpenTarget,
} from "./workspaceFileOpener";

describe("resolveWorkspaceFileOpenTarget", () => {
  it("passes workspace-relative paths through unchanged", () => {
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("README.md", null)).toBe("README.md");
  });

  it("strips :line and :line:col position suffixes", () => {
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx:42", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx:42:7", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("/repo/app/src/page.tsx:10:2", "/repo/app")).toBe(
      "src/page.tsx",
    );
  });

  it("maps absolute paths inside the workspace to relative form", () => {
    expect(resolveWorkspaceFileOpenTarget("/repo/app/src/page.tsx", "/repo/app")).toBe(
      "src/page.tsx",
    );
  });

  it("remaps absolute references from the original project into the active worktree", () => {
    expect(
      resolveWorkspaceFileOpenTarget(
        "C:\\projects\\synara\\apps\\web\\index.html:14",
        "D:\\worktrees\\feature",
        "c:\\PROJECTS\\SYNARA",
      ),
    ).toBe("apps/web/index.html");
  });

  it("maps Synara public asset URLs to their workspace files", () => {
    expect(
      resolveWorkspaceFileOpenTarget("/central-icons-reversed/magnifying-glass.svg", "/repo/app"),
    ).toBe("apps/web/public/central-icons-reversed/magnifying-glass.svg");
    expect(resolveWorkspaceFileOpenTarget("/central-icons-fill/search.svg:12", "/repo/app")).toBe(
      "apps/web/public/central-icons-fill/search.svg",
    );
  });

  it("returns null for paths outside the workspace", () => {
    expect(resolveWorkspaceFileOpenTarget("/elsewhere/file.ts", "/repo/app")).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("/repo/app/file.ts", null)).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("../outside.ts", "/repo/app")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolveWorkspaceFileOpenTarget("", "/repo/app")).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("   ", "/repo/app")).toBeNull();
  });
});

describe("resolveScratchPreviewFileOpenTarget", () => {
  const scratchPdf = "/private/tmp/synara-codex-workspaces/thread-1/report.pdf";

  it("returns absolute scratch-workspace preview paths unchanged", () => {
    expect(resolveScratchPreviewFileOpenTarget(scratchPdf)).toBe(scratchPdf);
    expect(
      resolveScratchPreviewFileOpenTarget("/tmp/synara-codex-workspaces/thread-1/shot.png"),
    ).toBe("/tmp/synara-codex-workspaces/thread-1/shot.png");
  });

  it("strips :line and :line:col position suffixes", () => {
    expect(resolveScratchPreviewFileOpenTarget(`${scratchPdf}:3`)).toBe(scratchPdf);
    expect(resolveScratchPreviewFileOpenTarget(`${scratchPdf}:3:14`)).toBe(scratchPdf);
  });

  it("preserves scratch-workspace text paths for grant-backed source previews", () => {
    expect(
      resolveScratchPreviewFileOpenTarget("/tmp/synara-codex-workspaces/thread-1/notes.ts"),
    ).toBe("/tmp/synara-codex-workspaces/thread-1/notes.ts");
  });

  it("returns null for absolute preview paths outside a scratch workspace", () => {
    expect(resolveScratchPreviewFileOpenTarget("/Users/dev/Documents/report.pdf")).toBeNull();
  });

  it("returns null for relative paths", () => {
    expect(resolveScratchPreviewFileOpenTarget("docs/report.pdf")).toBeNull();
    expect(
      resolveScratchPreviewFileOpenTarget("synara-codex-workspaces/thread-1/a.pdf"),
    ).toBeNull();
  });
});

describe("resolveDockFileOpenTarget", () => {
  const scratchPdf = "/private/tmp/synara-codex-workspaces/thread-1/report.pdf";

  it("opens scratch preview files even when no workspace is attached", () => {
    expect(resolveDockFileOpenTarget(scratchPdf, null)).toBe(scratchPdf);
  });

  it("does not treat workspace-relative paths as previewable without a workspace", () => {
    expect(resolveDockFileOpenTarget("docs/report.pdf", null)).toBeNull();
    expect(resolveDockFileOpenTarget("src/page.tsx", null)).toBeNull();
  });

  it("keeps workspace files relative when a workspace is attached", () => {
    expect(resolveDockFileOpenTarget("/repo/app/src/page.tsx:10", "/repo/app")).toBe(
      "src/page.tsx",
    );
    expect(resolveDockFileOpenTarget("src/page.tsx", "/repo/app")).toBe("src/page.tsx");
  });

  it("preserves exact-file previews for absolute non-HTML files", () => {
    expect(resolveDockFileOpenTarget("/Users/dev/Downloads/shot.png", "/repo/app")).toBe(
      "/Users/dev/Downloads/shot.png",
    );
    expect(resolveDockFileOpenTarget("/Users/dev/Downloads/report.pdf", "/repo/app")).toBe(
      "/Users/dev/Downloads/report.pdf",
    );
    expect(resolveDockFileOpenTarget("/Users/dev/Downloads/README.md", "/repo/app")).toBe(
      "/Users/dev/Downloads/README.md",
    );
    expect(resolveDockFileOpenTarget("/Users/dev/Downloads/report.txt:4", "/repo/app")).toBe(
      "/Users/dev/Downloads/report.txt",
    );
  });

  it("rejects outside-workspace HTML and network paths", () => {
    expect(resolveDockFileOpenTarget("/Users/dev/Downloads/demo.html", "/repo/app")).toBeNull();
    expect(resolveDockFileOpenTarget("\\\\server\\share\\shot.png", "/repo/app")).toBeNull();
    expect(resolveDockFileOpenTarget("//server/share/shot.png", "/repo/app")).toBeNull();
  });

  it("remaps original-root paths for dock activation", () => {
    expect(
      resolveDockFileOpenTarget(
        "/repo/project/docs/demo.html:4",
        "/repo/worktrees/feature",
        "/repo/project",
      ),
    ).toBe("docs/demo.html");
  });
});

describe("createWorkspaceHtmlBrowserOpenRequest", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("emits an active-worktree display path and token-only capability URL", async () => {
    (globalThis as unknown as { window: object }).window = {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:58090/?token=startup-secret" },
      location: { origin: "app://synara/" },
    };
    const queryClient = new QueryClient();
    const fetchQuery = vi.spyOn(queryClient, "fetchQuery").mockResolvedValue({
      grant: "grant-id",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      urlPath: "/api/local-preview/grant-id/demo.html",
    });

    await expect(
      createWorkspaceHtmlBrowserOpenRequest({
        queryClient,
        filePath: "/repo/project/docs/demo.html",
        workspaceRoot: "/repo/worktrees/feature",
        referenceRoot: "/repo/project",
      }),
    ).resolves.toEqual({
      url: "http://127.0.0.1:58090/api/local-preview/grant-id/demo.html",
      localFilePath: "/repo/worktrees/feature/docs/demo.html",
    });
    expect(fetchQuery).toHaveBeenCalledOnce();
  });
});

describe("prefetchWorkspaceFile", () => {
  it("preserves source prefetch for nested HTML while skipping standalone binaries", () => {
    const queryClient = new QueryClient();
    const prefetchQuery = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue(undefined);

    prefetchWorkspaceFile(queryClient, "/repo/worktree", "docs/demo.html");
    prefetchWorkspaceFile(queryClient, "/repo/worktree", "assets/screenshot.png");
    prefetchWorkspaceFile(queryClient, "/repo/worktree", "artifacts/archive.zip");

    expect(prefetchQuery).toHaveBeenCalledOnce();
  });
});
