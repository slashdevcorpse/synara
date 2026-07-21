// FILE: BrowserPanel.browser.tsx
// Purpose: Chromium regressions for local-preview restore and webview identity lifecycles.
// Layer: Browser component test

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ThreadId,
  type BrowserTabState,
  type NativeApi,
  type ProjectCreateLocalFilePreviewGrantInput,
  type ThreadBrowserState,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApiSlot = vi.hoisted(() => ({
  api: undefined as NativeApi | undefined,
}));

vi.mock("~/env", () => ({
  isElectron: true,
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => nativeApiSlot.api,
  readNativeApi: () => nativeApiSlot.api,
}));

import { useBrowserStateStore } from "../browserStateStore";
import BrowserPanel from "./BrowserPanel";

const THREAD_ID = ThreadId.makeUnsafe("browser-panel-lifecycle");
const WORKSPACE_ROOT = "/repo/worktree";
const LOCAL_FILE_PATH = `${WORKSPACE_ROOT}/docs/demo.html`;
const STALE_CAPABILITY_PATH = "/api/local-preview/stale-grant/docs/demo.html";
const FRESH_CAPABILITY_PATH = "/api/local-preview/fresh-grant/docs/demo.html";
const mountedCleanups: Array<() => Promise<void>> = [];

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeTab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id: "tab-local",
    url: STALE_CAPABILITY_PATH,
    title: "demo.html",
    status: "suspended",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: STALE_CAPABILITY_PATH,
    lastError: null,
    localFilePath: LOCAL_FILE_PATH,
    securityEpoch: 0,
    ...overrides,
  };
}

function makeState(tab: BrowserTabState, version = 1): ThreadBrowserState {
  return {
    threadId: THREAD_ID,
    version,
    open: true,
    activeTabId: tab.id,
    tabs: [tab],
    lastError: null,
  };
}

function createNativeApiHarness() {
  let currentState = makeState(makeTab());
  const stateListeners = new Set<(state: ThreadBrowserState) => void>();
  const copyLinkListeners = new Set<() => void>();
  const browser = {
    open: vi.fn(async (_input?: { initialUrl?: string }) => currentState),
    close: vi.fn(async () => currentState),
    hide: vi.fn(async () => undefined),
    getState: vi.fn(async () => currentState),
    setPanelBounds: vi.fn(async () => undefined),
    attachWebview: vi.fn(async () => currentState),
    detachWebview: vi.fn(async () => undefined),
    copyLink: vi.fn(async () => undefined),
    copyScreenshotToClipboard: vi.fn(async () => undefined),
    captureScreenshot: vi.fn(async () => ({
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
    })),
    executeCdp: vi.fn(async () => undefined),
    navigate: vi.fn(async () => currentState),
    reload: vi.fn(async () => currentState),
    goBack: vi.fn(async () => currentState),
    goForward: vi.fn(async () => currentState),
    newTab: vi.fn(async () => currentState),
    closeTab: vi.fn(async () => currentState),
    selectTab: vi.fn(async () => currentState),
    openDevTools: vi.fn(async () => undefined),
    onState: vi.fn((listener: (state: ThreadBrowserState) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    }),
    onBrowserUseOpenPanelRequest: vi.fn(() => () => undefined),
    onBrowserCopyLink: vi.fn((listener: () => void) => {
      copyLinkListeners.add(listener);
      return () => copyLinkListeners.delete(listener);
    }),
    onCopyLink: vi.fn((listener: () => void) => {
      copyLinkListeners.add(listener);
      return () => copyLinkListeners.delete(listener);
    }),
  };
  const projects = {
    createLocalFilePreviewGrant: vi.fn(async (_input: ProjectCreateLocalFilePreviewGrantInput) => ({
      grant: "fresh-grant",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      urlPath: FRESH_CAPABILITY_PATH,
    })),
  };
  const api = {
    browser,
    projects,
    server: {
      listLocalServers: vi.fn(async () => ({ servers: [] })),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
    },
  } as unknown as NativeApi;

  return {
    api,
    browser,
    emitState(state: ThreadBrowserState) {
      currentState = state;
      for (const listener of stateListeners) {
        listener(state);
      }
    },
    projects,
    setCurrentState(state: ThreadBrowserState) {
      currentState = state;
    },
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

async function mountBrowserPanel(props: Partial<React.ComponentProps<typeof BrowserPanel>> = {}) {
  const host = document.createElement("div");
  Object.assign(host.style, {
    width: "900px",
    height: "600px",
    display: "flex",
  });
  document.body.append(host);
  const queryClient = createQueryClient();
  const panelProps: React.ComponentProps<typeof BrowserPanel> = {
    mode: "sidebar",
    threadId: THREAD_ID,
    onClosePanel: () => undefined,
    workspaceRoot: WORKSPACE_ROOT,
    runtimeMode: "live",
    ...props,
  };
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <BrowserPanel {...panelProps} />
    </QueryClientProvider>,
    { container: host },
  );
  mountedCleanups.push(async () => {
    await screen.unmount();
    host.remove();
  });

  return {
    screen,
    async rerender(nextProps: Partial<React.ComponentProps<typeof BrowserPanel>>) {
      Object.assign(panelProps, nextProps);
      await screen.rerender(
        <QueryClientProvider client={queryClient}>
          <BrowserPanel {...panelProps} />
        </QueryClientProvider>,
      );
    },
  };
}

function capabilityPath(webview: Element | null): string | null {
  const src = webview?.getAttribute("src");
  return src ? new URL(src, window.location.origin).pathname : null;
}

describe("BrowserPanel local preview lifecycle", () => {
  beforeEach(() => {
    useBrowserStateStore.setState({
      threadStatesByThreadId: {},
      recentHistoryByThreadId: {},
    });
    nativeApiSlot.api = undefined;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of mountedCleanups.splice(0).reverse()) {
      await cleanup();
    }
    nativeApiSlot.api = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("keeps a preview-restored local capability detached until a fresh grant and navigate complete", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const staleState = makeState(makeTab());
    useBrowserStateStore.getState().upsertThreadState(staleState);
    const grant = deferred<{
      grant: string;
      expiresAt: string;
      urlPath: string;
    }>();
    const navigation = deferred<ThreadBrowserState>();
    harness.browser.open.mockResolvedValue(staleState);
    harness.projects.createLocalFilePreviewGrant.mockImplementation(() => grant.promise);
    harness.browser.navigate.mockImplementation(() => navigation.promise);

    const mounted = await mountBrowserPanel({ runtimeMode: "preview" });
    expect(document.querySelector("webview")).toBeNull();
    expect(harness.browser.open).not.toHaveBeenCalled();

    await mounted.rerender({ runtimeMode: "live" });
    await vi.waitFor(() => expect(harness.projects.createLocalFilePreviewGrant).toHaveBeenCalled());
    expect(document.querySelector("webview")).toBeNull();

    grant.resolve({
      grant: "fresh-grant",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      urlPath: FRESH_CAPABILITY_PATH,
    });
    await vi.waitFor(() => expect(harness.browser.navigate).toHaveBeenCalledTimes(1));
    expect(document.querySelector("webview")).toBeNull();

    const freshState = makeState(
      makeTab({
        url: FRESH_CAPABILITY_PATH,
        lastCommittedUrl: FRESH_CAPABILITY_PATH,
        status: "live",
      }),
      2,
    );
    navigation.resolve(freshState);
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());
    expect(document.querySelector("webview")?.getAttribute("src")).toBe("about:blank");
    expect(capabilityPath(document.querySelector("webview"))).not.toBe(STALE_CAPABILITY_PATH);
  });

  it("restores a local tab with a directory browser grant before loading the new capability", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const staleState = makeState(makeTab());
    const freshState = makeState(
      makeTab({
        url: FRESH_CAPABILITY_PATH,
        lastCommittedUrl: FRESH_CAPABILITY_PATH,
        status: "live",
      }),
      2,
    );
    const order: string[] = [];
    harness.browser.open.mockImplementation(async () => {
      order.push("open");
      return staleState;
    });
    harness.projects.createLocalFilePreviewGrant.mockImplementation(async () => {
      order.push("grant");
      return {
        grant: "fresh-grant",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        urlPath: FRESH_CAPABILITY_PATH,
      };
    });
    harness.browser.navigate.mockImplementation(async () => {
      order.push("navigate");
      expect(document.querySelector("webview")).toBeNull();
      return freshState;
    });

    await mountBrowserPanel();

    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());
    expect(order).toEqual(["open", "grant", "navigate"]);
    expect(harness.projects.createLocalFilePreviewGrant).toHaveBeenCalledWith({
      path: LOCAL_FILE_PATH,
      cwd: WORKSPACE_ROOT,
      scope: "directory",
      purpose: "browser",
    });
    expect(harness.browser.navigate).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tabId: "tab-local",
      url: expect.stringContaining(FRESH_CAPABILITY_PATH),
      localFilePath: LOCAL_FILE_PATH,
    });
    expect(document.querySelector("webview")?.getAttribute("src")).toBe("about:blank");
  });

  it("restores a scratch local tab without sending a cwd", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const scratchPath = "/tmp/synara-codex-workspaces/thread-1/demo.html";
    const staleState = makeState(
      makeTab({
        localFilePath: scratchPath,
      }),
    );
    const freshState = makeState(
      makeTab({
        localFilePath: scratchPath,
        url: FRESH_CAPABILITY_PATH,
        lastCommittedUrl: FRESH_CAPABILITY_PATH,
        status: "live",
      }),
      2,
    );
    harness.browser.open.mockResolvedValue(staleState);
    harness.browser.navigate.mockResolvedValue(freshState);

    await mountBrowserPanel({ workspaceRoot: null });

    await vi.waitFor(() => expect(harness.projects.createLocalFilePreviewGrant).toHaveBeenCalled());
    expect(harness.projects.createLocalFilePreviewGrant).toHaveBeenCalledWith({
      path: scratchPath,
      scope: "directory",
      purpose: "browser",
    });
    expect(harness.projects.createLocalFilePreviewGrant.mock.calls[0]?.[0]).not.toHaveProperty(
      "cwd",
    );
  });

  it("keeps a failed local remint detached without exposing the stale capability src", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const staleState = makeState(makeTab());
    harness.browser.open.mockResolvedValue(staleState);
    harness.projects.createLocalFilePreviewGrant.mockRejectedValue(new Error("grant expired"));

    await mountBrowserPanel();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Preview grant failed. Try again."),
    );
    expect(harness.browser.navigate).not.toHaveBeenCalled();
    expect(document.querySelector("webview")).toBeNull();
    expect(document.querySelector(`[src*="${STALE_CAPABILITY_PATH}"]`)).toBeNull();
  });

  it("detaches and remounts the renderer webview when securityEpoch changes", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const initialTab = makeTab({
      id: "tab-web",
      localFilePath: null,
      url: "https://example.test/",
      lastCommittedUrl: "https://example.test/",
      title: "Example",
      status: "live",
      securityEpoch: 0,
    });
    const initialState = makeState(initialTab);
    harness.browser.open.mockResolvedValue(initialState);

    await mountBrowserPanel();
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());
    const firstWebview = document.querySelector("webview") as HTMLElement & {
      getWebContentsId?: () => number;
    };
    firstWebview.getWebContentsId = () => 41;

    harness.emitState(
      makeState(
        {
          ...initialTab,
          securityEpoch: 1,
        },
        2,
      ),
    );

    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBe(firstWebview));
    const secondWebview = document.querySelector("webview");
    expect(firstWebview.isConnected).toBe(false);
    expect(secondWebview).not.toBeNull();
    expect(secondWebview?.getAttribute("src")).toBe("about:blank");
    expect(harness.browser.detachWebview).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tabId: "tab-web",
      webContentsId: 41,
    });
  });
});

describe("BrowserPanel one-shot navigation requests", () => {
  beforeEach(() => {
    useBrowserStateStore.setState({
      threadStatesByThreadId: {},
      recentHistoryByThreadId: {},
    });
    nativeApiSlot.api = undefined;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of mountedCleanups.splice(0).reverse()) {
      await cleanup();
    }
    nativeApiSlot.api = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("cancels stale tab restoration when a navigation request arrives", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const staleState = makeState(makeTab());
    const requestedState = makeState(
      makeTab({
        url: FRESH_CAPABILITY_PATH,
        lastCommittedUrl: FRESH_CAPABILITY_PATH,
        status: "live",
      }),
      2,
    );
    const staleRestore = deferred<ThreadBrowserState>();
    harness.browser.open.mockImplementation(async (input?: { initialUrl?: string }) => {
      if (input?.initialUrl) {
        return requestedState;
      }
      return staleRestore.promise;
    });
    const onHandled = vi.fn();

    const mounted = await mountBrowserPanel();
    await vi.waitFor(() =>
      expect(harness.browser.open).toHaveBeenCalledWith({ threadId: THREAD_ID }),
    );

    await mounted.rerender({
      navigationRequest: {
        id: "request-wins-restore-race",
        url: FRESH_CAPABILITY_PATH,
        localFilePath: LOCAL_FILE_PATH,
      },
      onNavigationRequestHandled: onHandled,
    });
    await vi.waitFor(() =>
      expect(harness.browser.open).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        initialUrl: FRESH_CAPABILITY_PATH,
        localFilePath: LOCAL_FILE_PATH,
      }),
    );
    await vi.waitFor(() => expect(onHandled).toHaveBeenCalledWith("request-wins-restore-race"));
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());

    await mounted.rerender({ navigationRequest: null });
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 10);
    });
    expect(
      harness.browser.open.mock.calls.filter(
        ([input]) => !(input as { initialUrl?: string } | undefined)?.initialUrl,
      ),
    ).toHaveLength(1);

    staleRestore.resolve(staleState);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.projects.createLocalFilePreviewGrant).not.toHaveBeenCalled();
    expect(harness.browser.navigate).not.toHaveBeenCalled();
    expect(useBrowserStateStore.getState().threadStatesByThreadId[THREAD_ID]).toEqual(
      requestedState,
    );
  });

  it("retries at 250ms and 500ms, then handles the request exactly once", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const liveState = makeState(
      makeTab({
        id: "tab-web",
        localFilePath: null,
        url: "https://initial.example/",
        lastCommittedUrl: "https://initial.example/",
        status: "live",
      }),
    );
    harness.browser.open.mockResolvedValue(liveState);
    const mounted = await mountBrowserPanel();
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());

    let requestAttempts = 0;
    harness.browser.open.mockImplementation(async (input?: { initialUrl?: string }) => {
      if (!input?.initialUrl) {
        return liveState;
      }
      requestAttempts += 1;
      if (requestAttempts < 3) {
        throw new Error("browser startup race");
      }
      return makeState(
        {
          ...liveState.tabs[0]!,
          url: input.initialUrl,
          lastCommittedUrl: input.initialUrl,
        },
        2,
      );
    });
    const onHandled = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await mounted.rerender({
      navigationRequest: {
        id: "request-retry",
        url: "https://target.example/",
        localFilePath: null,
      },
      onNavigationRequestHandled: onHandled,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(1);
    expect(onHandled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(249);
    expect(requestAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await mounted.rerender({});
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(2);
    expect(onHandled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(requestAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await mounted.rerender({});
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(3);
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith("request-retry");
  });

  it("handles a terminal navigation failure and clears its retry state", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const liveState = makeState(
      makeTab({
        id: "tab-web",
        localFilePath: null,
        url: "https://initial.example/",
        lastCommittedUrl: "https://initial.example/",
        status: "live",
      }),
    );
    harness.browser.open.mockResolvedValue(liveState);
    const mounted = await mountBrowserPanel();
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());

    let requestAttempts = 0;
    harness.browser.open.mockImplementation(async (input?: { initialUrl?: string }) => {
      if (!input?.initialUrl) {
        return liveState;
      }
      requestAttempts += 1;
      throw new Error("browser startup race");
    });
    const onHandled = vi.fn();
    const request = {
      id: "request-terminal-failure",
      url: "https://target.example/",
      localFilePath: null,
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await mounted.rerender({
      navigationRequest: request,
      onNavigationRequestHandled: onHandled,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    await mounted.rerender({});
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(500);
    await mounted.rerender({});
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(3);
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith(request.id);

    await mounted.rerender({ navigationRequest: null });
    await mounted.rerender({ navigationRequest: request });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(4);
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending retry when the navigation request is withdrawn", async () => {
    const harness = createNativeApiHarness();
    nativeApiSlot.api = harness.api;
    const liveState = makeState(
      makeTab({
        id: "tab-web",
        localFilePath: null,
        url: "https://initial.example/",
        lastCommittedUrl: "https://initial.example/",
        status: "live",
      }),
    );
    harness.browser.open.mockResolvedValue(liveState);
    const mounted = await mountBrowserPanel();
    await vi.waitFor(() => expect(document.querySelector("webview")).not.toBeNull());

    let requestAttempts = 0;
    harness.browser.open.mockImplementation(async (input?: { initialUrl?: string }) => {
      if (!input?.initialUrl) {
        return liveState;
      }
      requestAttempts += 1;
      throw new Error("browser startup race");
    });
    const onHandled = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await mounted.rerender({
      navigationRequest: {
        id: "request-cancelled",
        url: "https://target.example/",
        localFilePath: null,
      },
      onNavigationRequestHandled: onHandled,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestAttempts).toBe(1);

    await mounted.rerender({ navigationRequest: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestAttempts).toBe(1);
    expect(onHandled).not.toHaveBeenCalled();
  });
});
