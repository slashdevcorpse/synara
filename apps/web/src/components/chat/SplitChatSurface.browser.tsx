// FILE: SplitChatSurface.browser.tsx
// Purpose: Chromium coverage for split-chat embedded panel controls.

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "~/lib/pdf/pdfEngine";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { loadPdfDocumentMock, readFileMock } = vi.hoisted(() => ({
  loadPdfDocumentMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("~/lib/pdf/pdfEngine", () => ({
  loadPdfDocument: loadPdfDocumentMock,
}));

vi.mock("../pdf/PdfPageView", () => ({
  PdfPageView: () => null,
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    projects: {
      readFile: readFileMock,
    },
  }),
  readNativeApi: () => undefined,
}));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("./OpenInPicker", () => ({
  OpenInPicker: () => (
    <button type="button" aria-label="Editor options">
      Open
    </button>
  ),
}));

import { DockFilePane } from "./DockFilePane";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("closes a split file panel through the shared file-preview header", async () => {
  readFileMock.mockResolvedValue({
    relativePath: "notes.txt",
    contents: "File contents",
    truncated: false,
  });
  const onClosePanel = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await render(
    <QueryClientProvider client={queryClient}>
      <div className="flex h-96 w-96">
        <DockFilePane
          workspaceRoot="/repo/worktree"
          filePath="notes.txt"
          onClosePanel={onClosePanel}
        />
      </div>
    </QueryClientProvider>,
  );

  await page.getByRole("button", { name: "Close file panel" }).click();
  expect(onClosePanel).toHaveBeenCalledOnce();
});

it("keeps the split PDF close action through loading and the PDF-owned toolbar", async () => {
  const pdfDocument = {
    numPages: 1,
    destroy: vi.fn(() => Promise.resolve()),
    getPage: vi.fn(() =>
      Promise.resolve({
        getViewport: () => ({ width: 612, height: 792 }),
      }),
    ),
  } as unknown as PDFDocumentProxy;
  loadPdfDocumentMock.mockResolvedValue(pdfDocument);
  let resolvePdfResponse: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvePdfResponse = resolve;
        }),
    ),
  );
  const onClosePanel = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await render(
    <QueryClientProvider client={queryClient}>
      <div className="flex h-96 w-96">
        <DockFilePane
          workspaceRoot="/repo/worktree"
          filePath="report.pdf"
          onClosePanel={onClosePanel}
        />
      </div>
    </QueryClientProvider>,
  );

  await page.getByRole("button", { name: "Close file panel" }).click();
  expect(onClosePanel).toHaveBeenCalledOnce();

  resolvePdfResponse?.(new Response(new Uint8Array([1]), { status: 200 }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("PDF"));
  await page.getByRole("button", { name: "Close file panel" }).click();
  expect(onClosePanel).toHaveBeenCalledTimes(2);
});

it("keeps the split PDF close action after document loading fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
  );
  const onClosePanel = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await render(
    <QueryClientProvider client={queryClient}>
      <div className="flex h-96 w-96">
        <DockFilePane
          workspaceRoot="/repo/worktree"
          filePath="report.pdf"
          onClosePanel={onClosePanel}
        />
      </div>
    </QueryClientProvider>,
  );

  await vi.waitFor(() => expect(document.body.textContent).toContain("Failed to load PDF"));
  await page.getByRole("button", { name: "Close file panel" }).click();
  expect(onClosePanel).toHaveBeenCalledOnce();
});
