// FILE: WorkspaceFilePreview.browser.tsx
// Purpose: Real Chromium coverage for sandboxed HTML preview behavior and
//          responsive shared preview-header controls.

import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import demoHtml from "../../../../docs/demo.html?raw";
import demoHtmlUrl from "../../../../docs/demo.html?url";
import demoScript from "../../../../docs/demo-assets/scripts/demo.js?raw";

const { createGrantMock, listDirectoriesMock, readFileMock } = vi.hoisted(() => ({
  createGrantMock: vi.fn(),
  listDirectoriesMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    projects: {
      createLocalFilePreviewGrant: createGrantMock,
      listDirectories: listDirectoriesMock,
      readFile: readFileMock,
    },
  }),
  readNativeApi: () => undefined,
}));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("./chat/OpenInPicker", () => ({
  OpenInPicker: () => (
    <button type="button" aria-label="Editor options">
      Open
    </button>
  ),
}));

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";
import { DockExplorerPane } from "./chat/DockExplorerPane";

const DEMO_SCRIPT_EXECUTED_MESSAGE = "synara-demo-script-executed";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function renderHtmlPreview(props?: {
  onOpenInBrowser?: Parameters<typeof WorkspaceFilePreview>[0]["onOpenInBrowser"];
  queryClient?: QueryClient;
  width?: number;
}) {
  const host = document.createElement("div");
  Object.assign(host.style, {
    width: `${props?.width ?? 720}px`,
    height: "480px",
    display: "flex",
    overflow: "hidden",
  });
  document.body.append(host);
  return render(
    <QueryClientProvider client={props?.queryClient ?? createQueryClient()}>
      <WorkspaceFilePreview
        workspaceRoot="/repo/worktree"
        filePath="docs/demo.html"
        onOpenInBrowser={props?.onOpenInBrowser}
      />
    </QueryClientProvider>,
    { container: host },
  );
}

describe("WorkspaceFilePreview HTML", () => {
  beforeEach(() => {
    let grantSequence = 0;
    createGrantMock.mockImplementation(
      async (input: { purpose?: "preview" | "browser"; path: string }) => {
        grantSequence += 1;
        const purpose = input.purpose ?? "file";
        return {
          grant: `${purpose}-grant-${grantSequence}`,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          urlPath: `/api/local-preview/${purpose}-grant-${grantSequence}/demo.html`,
        };
      },
    );
    readFileMock.mockResolvedValue({
      relativePath: "docs/demo.html",
      contents: "<!doctype html><title>Source title</title>",
      truncated: false,
    });
    listDirectoriesMock.mockResolvedValue({ entries: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders HTML by default in a locked-down iframe and switches to source", async () => {
    await renderHtmlPreview();

    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const iframe = document.querySelector<HTMLIFrameElement>("iframe");
    expect(page.getByRole("radiogroup", { name: "HTML view" })).toBeVisible();
    expect(iframe?.title).toBe("Preview of demo.html");
    expect(iframe?.getAttribute("sandbox")).toBe("");
    const sandboxTokens = new Set(
      (iframe?.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean),
    );
    for (const forbidden of [
      "allow-scripts",
      "allow-same-origin",
      "allow-popups",
      "allow-forms",
      "allow-downloads",
      "allow-top-navigation",
    ]) {
      expect(sandboxTokens.has(forbidden)).toBe(false);
    }
    expect(new URL(iframe?.src ?? window.location.href).searchParams.has("token")).toBe(false);

    document.querySelector<HTMLInputElement>('input[type="radio"][value="source"]')?.click();
    await vi.waitFor(() => expect(document.querySelector("iframe")).toBeNull());
    expect(document.body.textContent).toContain("Source title");
  });

  it("loads nested browser-purpose assets while the in-app preview remains script-locked", async () => {
    const executedUrls: string[] = [];
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        event.data.type === DEMO_SCRIPT_EXECUTED_MESSAGE &&
        "href" in event.data &&
        typeof event.data.href === "string"
      ) {
        executedUrls.push(event.data.href);
      }
    };
    window.addEventListener("message", handleMessage);
    try {
      let browserUrl: string | null = null;
      await renderHtmlPreview({
        onOpenInBrowser: (request) => {
          browserUrl = request.url;
        },
      });
      await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
      const previewFrame = document.querySelector<HTMLIFrameElement>("iframe");
      expect(previewFrame?.getAttribute("sandbox")).toBe("");
      const demoBaseUrl = new URL(".", new URL(demoHtmlUrl, window.location.origin)).toString();
      if (previewFrame) {
        previewFrame.srcdoc = demoHtml
          .replace("<head>", `<head><base href="${demoBaseUrl}" />`)
          .replace(
            '<script src="./demo-assets/scripts/demo.js"></script>',
            `<script>${demoScript}\nwindow.parent.postMessage({ type: "${DEMO_SCRIPT_EXECUTED_MESSAGE}", href: window.location.href }, "*");</script>`,
          );
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      expect(executedUrls).toHaveLength(0);

      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Open in browser" }).click();
      await vi.waitFor(() => expect(browserUrl).not.toBeNull());
      expect(browserUrl).toContain("/api/local-preview/browser-grant-");
      const browserFrame = document.createElement("iframe");
      browserFrame.title = "Browser-purpose demo";
      browserFrame.srcdoc = demoHtml.replace("<head>", `<head><base href="${demoBaseUrl}" />`);
      document.body.append(browserFrame);

      await vi.waitFor(() => {
        const browserDocument = browserFrame.contentDocument;
        const status = browserDocument?.querySelector("#script-status");
        const stylesheet =
          browserDocument?.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');
        const image = browserDocument?.querySelector<HTMLImageElement>("img.demo-mark");
        expect(status?.textContent).toBe("Browser preview: the nested script loaded successfully.");
        expect(stylesheet?.sheet).not.toBeNull();
        expect(image?.complete).toBe(true);
        expect(image?.naturalWidth ?? 0).toBeGreaterThan(0);
      });
    } finally {
      window.removeEventListener("message", handleMessage);
    }
  });

  it("mints browser capabilities on demand and Refresh remints the iframe capability", async () => {
    const onOpenInBrowser = vi.fn();
    await renderHtmlPreview({ onOpenInBrowser });
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const firstPreviewSrc = document.querySelector<HTMLIFrameElement>("iframe")?.src;

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Open in browser" }).click();
    await vi.waitFor(() => expect(onOpenInBrowser).toHaveBeenCalledOnce());
    expect(onOpenInBrowser).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/local-preview/browser-grant-"),
      localFilePath: "/repo/worktree/docs/demo.html",
    });

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Refresh preview" }).click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLIFrameElement>("iframe")?.src).not.toBe(firstPreviewSrc),
    );
    const previewCalls = createGrantMock.mock.calls.filter(
      ([input]) => (input as { purpose?: string }).purpose === "preview",
    );
    expect(previewCalls).toHaveLength(2);
    expect(createGrantMock).toHaveBeenCalledWith({
      path: "docs/demo.html",
      cwd: "/repo/worktree",
      scope: "directory",
      purpose: "browser",
    });
  });

  it("remints an expired capability before copying the preview URL", async () => {
    const initialNow = Date.now();
    const queryClient = createQueryClient();
    const preview = await renderHtmlPreview({ queryClient });
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(initialNow + 180_000);
    try {
      await preview.rerender(
        <QueryClientProvider client={queryClient}>
          <WorkspaceFilePreview workspaceRoot="/repo/worktree" filePath="docs/demo.html" />
        </QueryClientProvider>,
      );
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Copy preview URL" }).click();
      await vi.waitFor(() => {
        const previewCalls = createGrantMock.mock.calls.filter(
          ([input]) => (input as { purpose?: string }).purpose === "preview",
        );
        expect(previewCalls).toHaveLength(2);
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("keeps copy retry available when reminting an expired capability fails", async () => {
    const initialNow = Date.now();
    const queryClient = createQueryClient();
    const preview = await renderHtmlPreview({ queryClient });
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(initialNow + 180_000);
    createGrantMock.mockRejectedValueOnce(new Error("Could not remint the preview capability."));
    try {
      await preview.rerender(
        <QueryClientProvider client={queryClient}>
          <WorkspaceFilePreview workspaceRoot="/repo/worktree" filePath="docs/demo.html" />
        </QueryClientProvider>,
      );
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Copy preview URL" }).click();
      const getCopyRetryButton = () => {
        const copyAlert = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find(
          (alert) => alert.textContent?.includes("Could not create a current preview URL."),
        );
        return copyAlert?.querySelector<HTMLButtonElement>("button") ?? null;
      };
      await vi.waitFor(() => expect(getCopyRetryButton()?.textContent).toBe("Retry"));

      const copyRetryButton = getCopyRetryButton();
      if (!copyRetryButton) {
        throw new Error("Copy preview retry button was not rendered.");
      }
      copyRetryButton.click();
      await vi.waitFor(() => {
        const previewCalls = createGrantMock.mock.calls.filter(
          ([input]) => (input as { purpose?: string }).purpose === "preview",
        );
        expect(previewCalls).toHaveLength(3);
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("shows a role-alert grant error and retries successfully", async () => {
    createGrantMock
      .mockRejectedValueOnce(new Error("Preview entry file was not found."))
      .mockResolvedValueOnce({
        grant: "preview-grant-retry",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        urlPath: "/api/local-preview/preview-grant-retry/demo.html",
      });

    await renderHtmlPreview();
    await vi.waitFor(() => expect(page.getByRole("alert")).toBeVisible());
    expect(document.body.textContent).toContain("Preview entry file was not found.");
    await page.getByRole("button", { name: "Retry" }).click();
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  });

  it("omits cwd when granting an approved scratch HTML preview", async () => {
    const host = document.createElement("div");
    Object.assign(host.style, { width: "720px", height: "480px", display: "flex" });
    document.body.append(host);

    await render(
      <QueryClientProvider client={createQueryClient()}>
        <WorkspaceFilePreview
          workspaceRoot="/repo/worktree"
          filePath="/tmp/synara-codex-workspaces/thread-1/demo.html"
        />
      </QueryClientProvider>,
      { container: host },
    );
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(createGrantMock).toHaveBeenCalledWith({
      path: "/tmp/synara-codex-workspaces/thread-1/demo.html",
      scope: "directory",
      purpose: "preview",
    });
  });

  it("keeps the breadcrumb and controls separated in a narrow pane", async () => {
    await renderHtmlPreview({ width: 320 });
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());

    const header = document.querySelector<HTMLElement>("[class*='@container/header-actions']");
    const breadcrumb = document.querySelector<HTMLElement>('nav[aria-label="File path"]');
    const controls = page.getByRole("radiogroup", { name: "HTML view" }).element();
    expect(header).not.toBeNull();
    expect(header?.scrollWidth).toBeLessThanOrEqual(header?.clientWidth ?? 0);
    expect(breadcrumb?.getBoundingClientRect().right ?? 0).toBeLessThanOrEqual(
      controls.getBoundingClientRect().left,
    );
  });

  it("opens Markdown from the dock explorer in rendered mode", async () => {
    listDirectoriesMock.mockResolvedValue({
      entries: [
        {
          path: "docs/README.md",
          name: "README.md",
          kind: "file",
        },
      ],
    });
    readFileMock.mockResolvedValue({
      relativePath: "docs/README.md",
      contents: "# Rendered explorer heading",
      truncated: false,
    });
    const host = document.createElement("div");
    Object.assign(host.style, { width: "820px", height: "480px", display: "flex" });
    document.body.append(host);

    await render(
      <QueryClientProvider client={createQueryClient()}>
        <DockExplorerPane workspaceRoot="/repo/worktree" />
      </QueryClientProvider>,
      { container: host },
    );
    await vi.waitFor(() => expect(page.getByRole("button", { name: "README.md" })).toBeVisible());
    await page.getByRole("button", { name: "README.md" }).click();

    await vi.waitFor(() =>
      expect(page.getByRole("heading", { name: "Rendered explorer heading" })).toBeVisible(),
    );
    expect(page.getByRole("radiogroup", { name: "Markdown view" })).toBeVisible();
    expect(
      document.querySelector<HTMLInputElement>('input[type="radio"][value="preview"]')?.checked,
    ).toBe(true);
  });
});
