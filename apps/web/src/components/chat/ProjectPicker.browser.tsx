// FILE: ProjectPicker.browser.tsx
// Purpose: Browser regressions for stale async project-directory callbacks.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  homeDir: "C:\\home-a",
  listDirectories: vi.fn(),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    dialogs: { pickFolder: vi.fn() },
    projects: { listDirectories: mocks.listDirectories },
  }),
}));

vi.mock("../../store", () => ({
  useStore: (selector: (state: { projects: readonly [] }) => unknown) => selector({ projects: [] }),
}));

vi.mock("../../storeSelectors", () => ({
  createSidebarDisplayThreadsSelector: () => () => [],
}));

vi.mock("../../workspaceStore", () => ({
  useWorkspaceStore: (selector: (state: { homeDir: string }) => unknown) =>
    selector({ homeDir: mocks.homeDir }),
}));

import { ProjectPicker } from "./ProjectPicker";

describe("ProjectPicker", () => {
  beforeEach(() => {
    mocks.homeDir = "C:\\home-a";
    mocks.listDirectories.mockReset();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("ignores an obsolete directory request after its effect is cleaned up", async () => {
    const first = deferred<{
      entries: Array<{ kind: "directory"; path: string; name: string; hasChildren: boolean }>;
    }>();
    const second = deferred<{
      entries: Array<{ kind: "directory"; path: string; name: string; hasChildren: boolean }>;
    }>();
    mocks.listDirectories.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const screen = await render(<ProjectPicker triggerClassName="version-0" />);
    await page.getByTestId("workspace-picker-trigger").click();
    await vi.waitFor(() => expect(mocks.listDirectories).toHaveBeenCalledTimes(1));

    mocks.homeDir = "C:\\home-b";
    await screen.rerender(<ProjectPicker triggerClassName="version-1" />);
    await vi.waitFor(() => expect(mocks.listDirectories).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Loading folders"));

    first.resolve({
      entries: [{ kind: "directory", path: "old", name: "Old folder", hasChildren: false }],
    });
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("Old folder");
    expect(document.body.textContent).toContain("Loading folders");

    second.resolve({
      entries: [{ kind: "directory", path: "new", name: "New folder", hasChildren: false }],
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("New folder"));
  });

  it("clears loading when an active request is cancelled without a replacement", async () => {
    const request = deferred<{
      entries: Array<{ kind: "directory"; path: string; name: string; hasChildren: boolean }>;
    }>();
    mocks.listDirectories.mockReturnValueOnce(request.promise);

    const screen = await render(<ProjectPicker triggerClassName="with-home" />);
    await page.getByTestId("workspace-picker-trigger").click();
    await vi.waitFor(() => expect(mocks.listDirectories).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Loading folders"));

    mocks.homeDir = "";
    await screen.rerender(<ProjectPicker triggerClassName="without-home" />);
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Loading folders"));
    expect(document.body.textContent).toContain("No folders found");

    request.resolve({
      entries: [{ kind: "directory", path: "old", name: "Old folder", hasChildren: false }],
    });
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("Old folder");
  });
});
