// FILE: WorkspaceProjectDialogs.browser.tsx
// Purpose: Browser coverage for workspace clone validation, browsing, progress, and recovery.
// Layer: Browser UI test

import "../../index.css";

import type {
  WorkspaceCloneId,
  WorkspaceCloneJobSnapshot,
  WorkspaceCloneProgressEvent,
  WorkspaceCloneRepositoryResult,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  browse: vi.fn(),
  cloneRepository: vi.fn(),
  getCloneStatus: vi.fn(),
  retryCloneProjectCreation: vi.fn(),
  progressListeners: [] as Array<(event: WorkspaceCloneProgressEvent) => void>,
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    filesystem: { browse: mocks.browse },
    workspace: {
      cloneRepository: mocks.cloneRepository,
      getCloneStatus: mocks.getCloneStatus,
      retryCloneProjectCreation: mocks.retryCloneProjectCreation,
      onCloneProgress: (listener: (event: WorkspaceCloneProgressEvent) => void) => {
        mocks.progressListeners.push(listener);
        return () => {
          const index = mocks.progressListeners.indexOf(listener);
          if (index >= 0) mocks.progressListeners.splice(index, 1);
        };
      },
    },
  }),
}));

vi.mock("~/env", () => ({ isElectron: false }));

import { CloneRepositoryDialog } from "./WorkspaceProjectDialogs";

const ACTIVE_CLONE_STORAGE_KEY = "synara:workspace-active-clone";
const cloneId = "clone-browser-test" as WorkspaceCloneId;
const updatedAt = "2026-07-20T12:00:00.000Z";

function snapshot(overrides: Partial<WorkspaceCloneJobSnapshot> = {}): WorkspaceCloneJobSnapshot {
  return {
    cloneId,
    status: "running",
    stage: "cloning",
    percent: 25,
    message: "Cloning repository…",
    result: null,
    updatedAt,
    ...overrides,
  };
}

function successResult(id: WorkspaceCloneId = cloneId): WorkspaceCloneRepositoryResult {
  return {
    cloneId: id,
    clonedPath: "C:\\Users\\Ada\\synara",
    projectId: "project-cloned" as WorkspaceCloneRepositoryResult["projectId"],
    failure: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function renderCloneDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const onComplete = vi.fn();
  await render(
    <QueryClientProvider client={queryClient}>
      <CloneRepositoryDialog
        open
        homeDir={"C:\\Users\\Ada"}
        onOpenChange={onOpenChange}
        onComplete={onComplete}
      />
    </QueryClientProvider>,
  );
  return { onComplete, onOpenChange, queryClient };
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.progressListeners.length = 0;
  mocks.browse.mockReset();
  mocks.cloneRepository.mockReset();
  mocks.getCloneStatus.mockReset();
  mocks.retryCloneProjectCreation.mockReset();
  mocks.getCloneStatus.mockResolvedValue({ job: null });
  mocks.browse.mockImplementation(({ partialPath }: { partialPath: string }) => {
    if (partialPath.includes("Projects")) {
      return Promise.resolve({ parentPath: "C:\\Users\\Ada\\Projects", entries: [] });
    }
    return Promise.resolve({
      parentPath: "C:\\Users\\Ada",
      entries: [{ name: "Projects", fullPath: "C:\\Users\\Ada\\Projects" }],
    });
  });
});

afterEach(async () => {
  await cleanup();
  sessionStorage.clear();
  mocks.progressListeners.length = 0;
});

describe("CloneRepositoryDialog", () => {
  it("validates inputs and chooses an existing parent for a new repo-named target", async () => {
    await renderCloneDialog();

    await page.getByRole("button", { name: "Clone repository" }).click();
    await expect.element(page.getByText(/valid credential-free HTTPS or SSH/)).toBeVisible();
    await expect.element(page.getByText(/absolute path for a new destination/)).toBeVisible();

    const urlInput = page.getByRole("textbox", { name: "GitHub URL" });
    await urlInput.fill("https://github.com/acme/synara.git");
    await page.getByRole("heading", { name: "Clone repository" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "New destination folder" }))
      .toHaveValue("C:\\Users\\Ada\\synara");
    await page.getByRole("button", { name: "Browse" }).click();
    await vi.waitFor(() => expect(mocks.browse).toHaveBeenCalled());
    await page.getByRole("button", { name: "Projects" }).click();
    await vi.waitFor(() =>
      expect(mocks.browse).toHaveBeenCalledWith({ partialPath: "C:\\Users\\Ada\\Projects\\" }),
    );
    await page.getByRole("button", { name: "Use this folder" }).click();

    await expect
      .element(page.getByRole("textbox", { name: "New destination folder" }))
      .toHaveValue("C:\\Users\\Ada\\Projects\\synara");
    expect(mocks.cloneRepository).not.toHaveBeenCalled();
  });

  it("renders streamed clone progress and the terminal result", async () => {
    const clone = deferred<WorkspaceCloneRepositoryResult>();
    mocks.cloneRepository.mockReturnValue(clone.promise);
    await renderCloneDialog();

    const urlInput = page.getByRole("textbox", { name: "GitHub URL" });
    await urlInput.fill("https://github.com/acme/synara.git");
    await page.getByRole("heading", { name: "Clone repository" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "New destination folder" }))
      .toHaveValue("C:\\Users\\Ada\\synara");
    await page.getByRole("button", { name: "Clone repository" }).click();
    await vi.waitFor(() => expect(mocks.cloneRepository).toHaveBeenCalledOnce());
    const activeCloneId = mocks.cloneRepository.mock.calls[0]?.[0].cloneId as WorkspaceCloneId;

    const progressEvent: WorkspaceCloneProgressEvent = {
      _tag: "clone_progress",
      snapshot: snapshot({ cloneId: activeCloneId, percent: 42, message: "Receiving objects…" }),
      phase: "receiving",
      completed: 42,
      total: 100,
    };
    for (const listener of [...mocks.progressListeners]) listener(progressEvent);

    await expect.element(page.getByText("Receiving objects…")).toBeVisible();
    await expect
      .element(page.getByRole("progressbar", { name: "Clone progress" }))
      .toHaveAttribute("aria-valuenow", "42");

    clone.resolve(successResult(activeCloneId));
    await expect.element(page.getByText("Repository cloned")).toBeVisible();
  });

  it("returns a restored clone-stage failure with missing request fields to editing", async () => {
    const failedResult: WorkspaceCloneRepositoryResult = {
      cloneId,
      clonedPath: null,
      projectId: null,
      failure: {
        stage: "clone",
        code: "WORKSPACE_CLONE_TARGET_EXISTS",
        message: "Choose a new folder path.",
        retryable: true,
      },
    };
    sessionStorage.setItem(ACTIVE_CLONE_STORAGE_KEY, cloneId);
    mocks.getCloneStatus.mockResolvedValue({
      job: snapshot({
        status: "failed",
        stage: "complete",
        percent: 100,
        message: "Clone failed.",
        result: failedResult,
      }),
    });
    await renderCloneDialog();

    await expect.element(page.getByText("Clone could not finish")).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();

    await expect.element(page.getByRole("textbox", { name: "GitHub URL" })).toBeVisible();
    await expect.element(page.getByText(/valid credential-free HTTPS or SSH/)).toBeVisible();
    await expect.element(page.getByText(/absolute path for a new destination/)).toBeVisible();
    expect(mocks.cloneRepository).not.toHaveBeenCalled();
  });

  it("polls a restored clone to terminal when progress events were missed", async () => {
    const result = successResult();
    sessionStorage.setItem(ACTIVE_CLONE_STORAGE_KEY, cloneId);
    mocks.getCloneStatus
      .mockResolvedValueOnce({ job: snapshot({ message: "Clone continues on the server…" }) })
      .mockResolvedValue({
        job: snapshot({
          status: "succeeded",
          stage: "complete",
          percent: 100,
          message: "Clone complete.",
          result,
        }),
      });
    await renderCloneDialog();

    await expect.element(page.getByText("Clone continues on the server…")).toBeVisible();
    await vi.waitFor(() => expect(mocks.getCloneStatus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    await expect.element(page.getByText("Repository cloned")).toBeVisible();
    expect(mocks.progressListeners).toHaveLength(0);
  });

  it("keeps polling the original clone id after the request stream disconnects", async () => {
    let statusCalls = 0;
    mocks.cloneRepository.mockRejectedValue(new Error("WebSocket disconnected."));
    mocks.getCloneStatus.mockImplementation(
      ({ cloneId: requestedId }: { cloneId: WorkspaceCloneId }) => {
        statusCalls += 1;
        if (statusCalls === 1) return Promise.resolve({ job: null });
        const result = successResult(requestedId);
        return Promise.resolve({
          job: snapshot({
            cloneId: requestedId,
            status: "succeeded",
            stage: "complete",
            percent: 100,
            message: "Clone complete.",
            result,
          }),
        });
      },
    );
    await renderCloneDialog();

    const urlInput = page.getByRole("textbox", { name: "GitHub URL" });
    await urlInput.fill("https://github.com/acme/synara.git");
    await page.getByRole("heading", { name: "Clone repository" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "New destination folder" }))
      .toHaveValue("C:\\Users\\Ada\\synara");
    await page.getByRole("button", { name: "Clone repository" }).click();

    await expect
      .element(page.getByText(/Checking whether the clone is still running/))
      .toBeVisible();
    await vi.waitFor(() => expect(mocks.getCloneStatus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    await expect.element(page.getByText("Repository cloned")).toBeVisible();
    const requestedCloneId = mocks.cloneRepository.mock.calls[0]?.[0].cloneId;
    expect(mocks.cloneRepository).toHaveBeenCalledOnce();
    expect(
      mocks.getCloneStatus.mock.calls.every(([input]) => input.cloneId === requestedCloneId),
    ).toBe(true);
  });

  it("keeps polling project creation after the retry stream disconnects", async () => {
    const failedResult: WorkspaceCloneRepositoryResult = {
      cloneId,
      clonedPath: "C:\\Users\\Ada\\synara",
      projectId: null,
      failure: {
        stage: "project",
        code: "WORKSPACE_CLONE_PROJECT_CREATE_FAILED",
        message: "Project creation temporarily failed.",
        retryable: true,
      },
    };
    let statusCalls = 0;
    sessionStorage.setItem(ACTIVE_CLONE_STORAGE_KEY, cloneId);
    mocks.retryCloneProjectCreation.mockRejectedValue(new Error("WebSocket disconnected."));
    mocks.getCloneStatus.mockImplementation(() => {
      statusCalls += 1;
      if (statusCalls === 1) {
        return Promise.resolve({
          job: snapshot({
            status: "failed",
            stage: "complete",
            percent: 100,
            message: failedResult.failure?.message ?? "Project creation failed.",
            result: failedResult,
          }),
        });
      }
      if (statusCalls === 2) {
        return Promise.resolve({
          job: snapshot({
            status: "running",
            stage: "creating-project",
            percent: 99,
            message: "Retrying Synara project creation…",
            result: null,
          }),
        });
      }
      const result = successResult();
      return Promise.resolve({
        job: snapshot({
          status: "succeeded",
          stage: "complete",
          percent: 100,
          message: "Project created.",
          result,
        }),
      });
    });
    await renderCloneDialog();

    await expect.element(page.getByText("Clone could not finish")).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();

    await vi.waitFor(() => expect(mocks.getCloneStatus).toHaveBeenCalledTimes(3), {
      timeout: 3_000,
    });
    await expect.element(page.getByText("Repository cloned")).toBeVisible();
    expect(mocks.retryCloneProjectCreation).toHaveBeenCalledOnce();
    expect(mocks.retryCloneProjectCreation).toHaveBeenCalledWith({ cloneId });
  });

  it("bounds polling when the server never accepted the clone id", async () => {
    mocks.cloneRepository.mockRejectedValue(new Error("Request was not accepted."));
    mocks.getCloneStatus.mockResolvedValue({ job: null });
    await renderCloneDialog();

    const urlInput = page.getByRole("textbox", { name: "GitHub URL" });
    await urlInput.fill("https://github.com/acme/synara.git");
    await page.getByRole("heading", { name: "Clone repository" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "New destination folder" }))
      .toHaveValue("C:\\Users\\Ada\\synara");
    await page.getByRole("button", { name: "Clone repository" }).click();

    await vi.waitFor(
      () =>
        expect(document.body.textContent).toContain(
          "The clone request was not found on the server.",
        ),
      { timeout: 5_000 },
    );
    expect(mocks.getCloneStatus).toHaveBeenCalledTimes(3);
    expect(mocks.cloneRepository).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
