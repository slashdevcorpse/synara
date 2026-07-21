// FILE: browserManager.test.ts
// Purpose: Guards local-preview capability lifecycle behavior in the desktop browser manager.
// Layer: Desktop test
// Depends on: Vitest, a minimal Electron mock, and DesktopBrowserManager

import { EventEmitter } from "node:events";

import type { BrowserTabState, ThreadBrowserState, ThreadId } from "@synara/contracts";
import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  sessionSetUserAgent: vi.fn(),
  sessionOnBeforeSendHeaders: vi.fn(),
  webContentsFromId: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getName: () => "Synara",
    getPreferredSystemLanguages: () => ["en-US"],
    userAgentFallback:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  },
  BrowserWindow: class {},
  clipboard: {
    writeImage: vi.fn(),
    writeText: electronMocks.clipboardWriteText,
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
  session: {
    fromPartition: () => ({
      setUserAgent: electronMocks.sessionSetUserAgent,
      webRequest: {
        onBeforeSendHeaders: electronMocks.sessionOnBeforeSendHeaders,
      },
    }),
  },
  webContents: {
    fromId: electronMocks.webContentsFromId,
  },
  WebContentsView: class {},
}));

import { DesktopBrowserManager } from "./browserManager";
import {
  createBrowserPopupNavigationPolicy,
  ensureAttachedBrowserWebContentsSecurity,
} from "./browserSecurity";

const THREAD_ID = "thread-local-preview" as ThreadId;
const FIRST_PREVIEW_URL = "http://127.0.0.1:58090/api/local-preview/first_token/index.html";
const SECOND_PREVIEW_URL = "http://127.0.0.1:58090/api/local-preview/second_token/index.html";

interface FakePopup {
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}

interface FakeRuntime {
  webContents: {
    getURL: () => string;
    isDestroyed: () => boolean;
    navigationHistory?: {
      canGoToOffset: (offset: number) => boolean;
      getActiveIndex: () => number;
      getEntryAtIndex: (index: number) => { url: string } | undefined;
      goBack: ReturnType<typeof vi.fn>;
      goForward: ReturnType<typeof vi.fn>;
    };
  };
}

interface FakeWindowOpenDetails {
  disposition: string;
  features: string;
  frameName: string;
  url: string;
}

type FakeWindowOpenResult =
  | { action: "deny" }
  | { action: "allow"; overrideBrowserWindowOptions?: unknown };

class FakeWebContents extends EventEmitter {
  private static nextId = 100;
  readonly id = FakeWebContents.nextId++;
  readonly close = vi.fn(() => {
    this.destroyed = true;
  });
  private debuggerAttached = false;
  readonly debugger = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => {
      this.debuggerAttached = true;
    }),
    detach: vi.fn(() => {
      this.debuggerAttached = false;
    }),
    isAttached: () => this.debuggerAttached,
    sendCommand: vi.fn(async (method: string) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        return { identifier: "local-preview-guard" };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: ["undefined", "undefined", "undefined"] } };
      }
      return {};
    }),
  });
  readonly navigationHistory = {
    canGoToOffset: () => false,
    getActiveIndex: () => 0,
    getEntryAtIndex: (_index: number) => undefined,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  readonly stop = vi.fn();
  readonly loadURL = vi.fn(async () => undefined);
  readonly openDevTools = vi.fn();
  readonly setUserAgent = vi.fn();
  windowOpenHandler: ((details: FakeWindowOpenDetails) => FakeWindowOpenResult) | null = null;
  readonly setWindowOpenHandler = vi.fn(
    (handler: (details: FakeWindowOpenDetails) => FakeWindowOpenResult) => {
      this.windowOpenHandler = handler;
    },
  );

  constructor(
    private readonly currentUrl = "about:blank",
    private readonly currentTitle = "",
  ) {
    super();
  }

  private destroyed = false;

  getURL(): string {
    return this.currentUrl;
  }

  getTitle(): string {
    return this.currentTitle;
  }

  getType(): string {
    return "webview";
  }

  isLoading(): boolean {
    return false;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeOAuthPopupWindow extends EventEmitter {
  readonly webContents: FakeWebContents;
  readonly setMenuBarVisibility = vi.fn();
  private destroyed = false;

  constructor(url = "https://accounts.example.test/oauth/authorize") {
    super();
    this.webContents = new FakeWebContents(url);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("closed");
  });
}

interface BrowserManagerInternals {
  popupRuntimes: Map<
    FakePopup,
    {
      threadId: ThreadId;
      tabId: string;
      localFilePath: string | null;
      localPreviewCapability: unknown;
      window: FakePopup;
      listenerDisposers: Array<() => void>;
    }
  >;
  resolveCopyableTabUrl: (
    threadId: ThreadId,
    tabId: string,
    runtime: FakeRuntime | undefined,
  ) => string | null;
  registerPageNavigationGuards: (
    webContents: EventEmitter,
    isAllowed: (url: string) => boolean,
    onDisallowedNavigation: () => void,
    listenerDisposers: Array<() => void>,
  ) => void;
  configureRuntimeWebContents: (runtime: {
    key: string;
    threadId: ThreadId;
    tabId: string;
    webContents: FakeWebContents;
    view: null;
    ownsWebContents: boolean;
    listenerDisposers: Array<() => void>;
    localPreviewGuardReady?: Promise<void>;
    localPreviewGuardInstalled?: boolean;
  }) => void;
  configureOAuthPopupRuntime: (runtime: {
    threadId: ThreadId;
    tabId: string;
    navigationPolicy: ReturnType<typeof createBrowserPopupNavigationPolicy>;
    localFilePath: string | null;
    localPreviewCapability: null;
    window: FakeOAuthPopupWindow;
    listenerDisposers: Array<() => void>;
  }) => void;
  prepareLocalPreviewRuntimeGuard: (
    runtime: {
      key: string;
      threadId: ThreadId;
      tabId: string;
      webContents: FakeWebContents;
      view: null;
      ownsWebContents: boolean;
      listenerDisposers: Array<() => void>;
      localPreviewGuardReady?: Promise<void>;
      localPreviewGuardInstalled?: boolean;
    },
    tab: BrowserTabState,
  ) => void;
  pendingRuntimeSyncs: Map<string, { threadId: ThreadId; tabId: string; faviconUrls?: string[] }>;
  runtimes: Map<string, FakeRuntime>;
  states: Map<ThreadId, ThreadBrowserState>;
}

function managerInternals(manager: DesktopBrowserManager): BrowserManagerInternals {
  return manager as unknown as BrowserManagerInternals;
}

function openLocalTab(manager: DesktopBrowserManager): BrowserTabState {
  return manager.open({
    threadId: THREAD_ID,
    initialUrl: FIRST_PREVIEW_URL,
    localFilePath: "C:\\work\\index.html",
  }).tabs[0]!;
}

function seedPopup(manager: DesktopBrowserManager, tab: BrowserTabState): FakePopup {
  const popup: FakePopup = {
    destroy: vi.fn(),
    isDestroyed: () => false,
  };
  managerInternals(manager).popupRuntimes.set(popup, {
    threadId: THREAD_ID,
    tabId: tab.id,
    localFilePath: tab.localFilePath ?? null,
    localPreviewCapability: {},
    window: popup,
    listenerDisposers: [],
  });
  return popup;
}

describe("DesktopBrowserManager local-preview lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits one state change when a different tab becomes active", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const firstTabId = initial.activeTabId;
    const withSecondTab = manager.newTab({
      threadId: THREAD_ID,
      url: "https://second.example",
      activate: false,
    });
    const secondTabId = withSecondTab.tabs.at(-1)?.id;
    const states = vi.fn();
    manager.subscribe(states);

    expect(firstTabId).not.toBeNull();
    expect(secondTabId).toBeDefined();
    if (!secondTabId) return;
    expect(withSecondTab.activeTabId).toBe(firstTabId);

    const selected = manager.selectTab({ threadId: THREAD_ID, tabId: secondTabId });
    expect(selected.activeTabId).toBe(secondTabId);
    expect(states).toHaveBeenCalledTimes(1);

    manager.selectTab({ threadId: THREAD_ID, tabId: secondTabId });
    expect(states).toHaveBeenCalledTimes(1);
  });

  it("applies the same popup, tab-open, and scheme-denial policy to tabs and popups", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    const popup = new FakeOAuthPopupWindow();
    const access = managerInternals(manager);
    expect(ensureAttachedBrowserWebContentsSecurity(tabContents as unknown as WebContents)).toBe(
      true,
    );
    const attachmentHandler = tabContents.windowOpenHandler;
    expect(
      attachmentHandler?.({
        url: "https://auth.example",
        frameName: "auth",
        features: "width=480,height=640",
        disposition: "new-window",
      }),
    ).toEqual({ action: "deny" });
    access.configureRuntimeWebContents({
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    expect(tabContents.windowOpenHandler).not.toBe(attachmentHandler);
    const runtimeHandler = tabContents.windowOpenHandler;
    expect(ensureAttachedBrowserWebContentsSecurity(tabContents as unknown as WebContents)).toBe(
      false,
    );
    expect(tabContents.windowOpenHandler).toBe(runtimeHandler);
    expect(tabContents.listenerCount("will-navigate")).toBe(2);
    expect(tabContents.listenerCount("will-redirect")).toBe(2);
    access.configureOAuthPopupRuntime({
      threadId: THREAD_ID,
      tabId,
      navigationPolicy: createBrowserPopupNavigationPolicy({
        initialUrl: popup.webContents.getURL(),
        inheritedOrigins: ["https://auth.example", "https://docs.example"],
      }),
      localFilePath: null,
      localPreviewCapability: null,
      window: popup,
      listenerDisposers: [],
    });

    const handlers = [
      tabContents.setWindowOpenHandler.mock.calls.at(-1)?.[0],
      popup.webContents.setWindowOpenHandler.mock.calls.at(-1)?.[0],
    ];
    expect(handlers.every(Boolean)).toBe(true);
    for (const handler of handlers) {
      if (!handler) continue;
      expect(
        handler({
          url: "https://auth.example",
          frameName: "auth",
          features: "width=480,height=640",
          disposition: "new-window",
        }),
      ).toMatchObject({ action: "allow", overrideBrowserWindowOptions: expect.any(Object) });

      const beforeTabOpen = manager.getState({ threadId: THREAD_ID }).tabs.length;
      expect(
        handler({
          url: "https://docs.example",
          frameName: "",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toEqual({ action: "deny" });
      const afterTabOpen = manager.getState({ threadId: THREAD_ID });
      expect(afterTabOpen.tabs).toHaveLength(beforeTabOpen + 1);
      expect(afterTabOpen.tabs.find((tab) => tab.id === afterTabOpen.activeTabId)?.url).toBe(
        "https://docs.example/",
      );

      const beforeSchemeDenial = afterTabOpen.tabs.length;
      expect(
        handler({
          url: "synara://unsafe",
          frameName: "",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toEqual({ action: "deny" });
      expect(manager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(beforeSchemeDenial);
    }

    const preventNavigation = vi.fn();
    tabContents.emit(
      "will-navigate",
      {
        url: "file:///sensitive",
        preventDefault: preventNavigation,
      },
      "file:///sensitive",
    );
    expect(preventNavigation).toHaveBeenCalledTimes(2);
  });

  it("derives nested popup navigation guards through the runtime window chain", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    managerInternals(manager).configureRuntimeWebContents({
      key: `${THREAD_ID}:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    const popup = new FakeOAuthPopupWindow();
    tabContents.emit("did-create-window", popup, {
      url: "https://accounts.example.test/oauth/authorize",
    });
    const nested = new FakeOAuthPopupWindow("about:blank");
    popup.webContents.emit("did-create-window", nested, { url: "about:blank" });

    expect(popup.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(nested.setMenuBarVisibility).toHaveBeenCalledWith(false);
    const preventBoundNavigation = vi.fn();
    nested.webContents.emit(
      "will-navigate",
      {
        url: "https://accounts.example.test/oauth/consent",
        preventDefault: preventBoundNavigation,
      },
      "https://accounts.example.test/oauth/consent",
    );
    expect(preventBoundNavigation).not.toHaveBeenCalled();
    const preventUnboundNavigation = vi.fn();
    nested.webContents.emit(
      "will-navigate",
      {
        url: "https://attacker.example/phish",
        preventDefault: preventUnboundNavigation,
      },
      "https://attacker.example/phish",
    );
    expect(preventUnboundNavigation).toHaveBeenCalledOnce();
    expect(nested.isDestroyed()).toBe(true);
  });

  it("closes capability-scoped popups when a tab changes security identity", () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const popup = seedPopup(manager, tab);

    manager.navigate({
      threadId: THREAD_ID,
      tabId: tab.id,
      url: SECOND_PREVIEW_URL,
      localFilePath: "C:\\work\\second.html",
    });

    expect(popup.destroy).toHaveBeenCalledOnce();
    expect(managerInternals(manager).popupRuntimes.size).toBe(0);
  });

  it("keeps same-capability popups while navigating within the granted tree", () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const popup = seedPopup(manager, tab);

    manager.navigate({
      threadId: THREAD_ID,
      tabId: tab.id,
      url: new URL("assets/demo.html", FIRST_PREVIEW_URL).toString(),
      localFilePath: "C:\\work\\assets\\demo.html",
    });

    expect(popup.destroy).not.toHaveBeenCalled();
    expect(managerInternals(manager).popupRuntimes.size).toBe(1);
  });

  it("does not copy a stale capability URL during a local-to-web transition", () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const internalTab = managerInternals(manager).states.get(THREAD_ID)!.tabs[0]!;
    internalTab.localFilePath = null;
    internalTab.url = "https://example.com/";
    internalTab.lastCommittedUrl = null;

    managerInternals(manager).runtimes.set(`${THREAD_ID}:${tab.id}`, {
      webContents: {
        getURL: () => FIRST_PREVIEW_URL,
        isDestroyed: () => false,
      },
    });
    manager.copyLink({ threadId: THREAD_ID, tabId: tab.id });

    expect(electronMocks.clipboardWriteText).toHaveBeenCalledWith("https://example.com/");
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalledWith(FIRST_PREVIEW_URL);
  });

  it("never copies a capability URL from a local tab", () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    managerInternals(manager).runtimes.set(`${THREAD_ID}:${tab.id}`, {
      webContents: {
        getURL: () => FIRST_PREVIEW_URL,
        isDestroyed: () => false,
      },
    });

    manager.copyLink({ threadId: THREAD_ID, tabId: tab.id });

    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it("never copies an unpaired capability URL from inconsistent tab state", () => {
    const manager = new DesktopBrowserManager();
    const tab = manager.open({
      threadId: THREAD_ID,
      initialUrl: "https://example.com/",
    }).tabs[0]!;
    const internalTab = managerInternals(manager).states.get(THREAD_ID)!.tabs[0]!;
    internalTab.localFilePath = null;
    internalTab.url = FIRST_PREVIEW_URL;
    internalTab.lastCommittedUrl = FIRST_PREVIEW_URL;

    manager.copyLink({ threadId: THREAD_ID, tabId: tab.id });

    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it("drops every page-provided favicon for local tabs while preserving web favicons", async () => {
    const localFaviconUrls = [
      `https://attacker.example/favicon.ico?url=${encodeURIComponent(FIRST_PREVIEW_URL)}`,
      `data:image/svg+xml,${encodeURIComponent(FIRST_PREVIEW_URL)}`,
      `${FIRST_PREVIEW_URL}/favicon.ico`,
    ];

    for (const faviconUrl of localFaviconUrls) {
      const manager = new DesktopBrowserManager();
      const tab = openLocalTab(manager);
      const webContents = new FakeWebContents(FIRST_PREVIEW_URL, "Untrusted local title");
      const runtime = {
        key: `${THREAD_ID}:${tab.id}`,
        threadId: THREAD_ID,
        tabId: tab.id,
        webContents,
        view: null,
        ownsWebContents: false,
        listenerDisposers: [],
      };
      const emittedStates: ThreadBrowserState[] = [];
      manager.subscribe((state) => emittedStates.push(state));
      managerInternals(manager).runtimes.set(`${THREAD_ID}:${tab.id}`, runtime);
      managerInternals(manager).configureRuntimeWebContents(runtime);

      webContents.emit("page-favicon-updated", {}, [faviconUrl]);
      expect(
        managerInternals(manager).pendingRuntimeSyncs.get(`${THREAD_ID}:${tab.id}`)?.faviconUrls,
      ).toEqual([]);
      await Promise.resolve();

      expect(emittedStates.at(-1)?.tabs[0]?.faviconUrl).toBeNull();
      expect(manager.getState({ threadId: THREAD_ID }).tabs[0]?.faviconUrl).toBeNull();
    }

    const transitionManager = new DesktopBrowserManager();
    const transitionTab = openLocalTab(transitionManager);
    const staleLocalContents = new FakeWebContents(FIRST_PREVIEW_URL, "Stale local page");
    const transitionRuntime = {
      key: `${THREAD_ID}:${transitionTab.id}`,
      threadId: THREAD_ID,
      tabId: transitionTab.id,
      webContents: staleLocalContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    };
    managerInternals(transitionManager).runtimes.set(
      `${THREAD_ID}:${transitionTab.id}`,
      transitionRuntime,
    );
    managerInternals(transitionManager).configureRuntimeWebContents(transitionRuntime);
    const transitioningState = managerInternals(transitionManager).states.get(THREAD_ID)!;
    transitioningState.tabs[0]!.localFilePath = null;
    transitioningState.tabs[0]!.url = "https://example.com/";
    transitioningState.tabs[0]!.lastCommittedUrl = null;

    staleLocalContents.emit("page-favicon-updated", {}, [localFaviconUrls[0]]);
    expect(
      managerInternals(transitionManager).pendingRuntimeSyncs.get(
        `${THREAD_ID}:${transitionTab.id}`,
      )?.faviconUrls,
    ).toEqual([]);
    await Promise.resolve();
    expect(transitionManager.getState({ threadId: THREAD_ID }).tabs[0]?.faviconUrl).toBeNull();

    const webManager = new DesktopBrowserManager();
    const webTab = webManager.open({
      threadId: THREAD_ID,
      initialUrl: "https://example.com/",
    }).tabs[0]!;
    const webContents = new FakeWebContents("https://example.com/", "Example");
    const webRuntime = {
      key: `${THREAD_ID}:${webTab.id}`,
      threadId: THREAD_ID,
      tabId: webTab.id,
      webContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    };
    const webFaviconUrl = "https://example.com/favicon.ico";
    managerInternals(webManager).runtimes.set(`${THREAD_ID}:${webTab.id}`, webRuntime);
    managerInternals(webManager).configureRuntimeWebContents(webRuntime);

    webContents.emit("page-favicon-updated", {}, [webFaviconUrl]);
    await Promise.resolve();

    expect(webManager.getState({ threadId: THREAD_ID }).tabs[0]?.faviconUrl).toBe(webFaviconUrl);
  });

  it("filters back and forward history destinations through the active capability", () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const goBack = vi.fn();
    const goForward = vi.fn();
    const entries = [
      { url: "https://example.com/outside" },
      { url: FIRST_PREVIEW_URL },
      { url: new URL("assets/inside.html", FIRST_PREVIEW_URL).toString() },
    ];
    managerInternals(manager).runtimes.set(`${THREAD_ID}:${tab.id}`, {
      webContents: {
        getURL: () => FIRST_PREVIEW_URL,
        isDestroyed: () => false,
        navigationHistory: {
          canGoToOffset: () => true,
          getActiveIndex: () => 1,
          getEntryAtIndex: (index) => entries[index],
          goBack,
          goForward,
        },
      },
    });

    const stateAfterBack = manager.goBack({ threadId: THREAD_ID, tabId: tab.id });
    const stateAfterForward = manager.goForward({ threadId: THREAD_ID, tabId: tab.id });

    expect(goBack).not.toHaveBeenCalled();
    expect(goForward).toHaveBeenCalledOnce();
    expect(stateAfterBack.tabs[0]?.canGoBack).toBe(false);
    expect(stateAfterForward.tabs[0]?.localFilePath).toBe("C:\\work\\index.html");
  });

  it("clears local metadata across normal-to-local-to-normal commands", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID, initialUrl: "https://example.com/" });
    const tabId = initial.tabs[0]!.id;

    const localState = manager.navigate({
      threadId: THREAD_ID,
      tabId,
      url: FIRST_PREVIEW_URL,
      localFilePath: "C:\\work\\index.html",
    });
    const webState = manager.navigate({
      threadId: THREAD_ID,
      tabId,
      url: "https://example.net/next",
    });

    expect(localState.tabs[0]).toMatchObject({
      localFilePath: "C:\\work\\index.html",
      url: FIRST_PREVIEW_URL,
    });
    expect(webState.tabs[0]).toMatchObject({
      localFilePath: null,
      lastCommittedUrl: null,
      securityEpoch: 2,
      url: "https://example.net/next",
    });
  });

  it("destroys the committed local document before adopting web navigation policy", () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const webContents = new FakeWebContents(FIRST_PREVIEW_URL, "Local page");
    const runtime = {
      key: `${THREAD_ID}:${tab.id}`,
      threadId: THREAD_ID,
      tabId: tab.id,
      webContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    };
    managerInternals(manager).runtimes.set(`${THREAD_ID}:${tab.id}`, runtime);
    managerInternals(manager).configureRuntimeWebContents(runtime);

    let localPathAtClose: string | null | undefined;
    webContents.close.mockImplementationOnce(() => {
      localPathAtClose = managerInternals(manager).states.get(THREAD_ID)?.tabs[0]?.localFilePath;
    });

    const state = manager.navigate({
      threadId: THREAD_ID,
      tabId: tab.id,
      url: "https://example.com/next",
    });

    expect(localPathAtClose).toBe("C:\\work\\index.html");
    expect(webContents.stop).toHaveBeenCalledOnce();
    expect(webContents.close).toHaveBeenCalled();
    expect(managerInternals(manager).runtimes.has(`${THREAD_ID}:${tab.id}`)).toBe(false);
    expect(webContents.listenerCount("will-navigate")).toBe(0);
    expect(state.tabs[0]).toMatchObject({
      localFilePath: null,
      securityEpoch: 1,
      url: "https://example.com/next",
    });

    const transitionWindowOpenHandler = webContents.setWindowOpenHandler.mock.calls.at(-1)?.[0];
    expect(
      transitionWindowOpenHandler?.({
        url: "https://attacker.example/escape",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
  });

  it("denies raw browser automation for local preview tabs", async () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const input = { threadId: THREAD_ID, tabId: tab.id };

    await expect(
      manager.executeCdp({ ...input, method: "Runtime.evaluate", params: { expression: "1" } }),
    ).rejects.toThrow("Browser automation is unavailable for local previews.");
    await expect(manager.attachBrowserUseTab(input)).rejects.toThrow(
      "Browser automation is unavailable for local previews.",
    );
    expect(() => manager.subscribeToCdpEvents(input, () => undefined)).toThrow(
      "Browser automation is unavailable for local previews.",
    );
    expect(() => manager.openDevTools(input)).toThrow(
      "DevTools are unavailable for local previews.",
    );
  });

  it("installs the document-start WebRTC guard and fails closed if it detaches", async () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const webContents = new FakeWebContents("about:blank", "Local page");
    const runtime: Parameters<BrowserManagerInternals["configureRuntimeWebContents"]>[0] = {
      key: `${THREAD_ID}:${tab.id}`,
      threadId: THREAD_ID,
      tabId: tab.id,
      webContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    };
    managerInternals(manager).runtimes.set(runtime.key, runtime);
    managerInternals(manager).configureRuntimeWebContents(runtime);

    managerInternals(manager).prepareLocalPreviewRuntimeGuard(runtime, tab);
    const blockedBeforeGuard = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", blockedBeforeGuard, FIRST_PREVIEW_URL);
    expect(blockedBeforeGuard.preventDefault).toHaveBeenCalledOnce();
    expect(runtime.localPreviewGuardInstalled).toBe(false);
    await runtime.localPreviewGuardReady;

    const allowedAfterGuard = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", allowedAfterGuard, FIRST_PREVIEW_URL);
    expect(allowedAfterGuard.preventDefault).not.toHaveBeenCalled();
    expect(runtime.localPreviewGuardInstalled).toBe(true);

    expect(webContents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith("Page.enable");
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.addScriptToEvaluateOnNewDocument",
      expect.objectContaining({
        runImmediately: true,
        source: expect.stringContaining("RTCPeerConnection"),
      }),
    );
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ returnByValue: true }),
    );

    webContents.debugger.emit("detach", {}, "replaced_with_devtools");

    expect(webContents.stop).toHaveBeenCalled();
    expect(webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(managerInternals(manager).runtimes.has(runtime.key)).toBe(false);
    expect(manager.getState({ threadId: THREAD_ID }).tabs[0]).toMatchObject({
      status: "suspended",
      isLoading: false,
      lastError: expect.stringContaining("security guard stopped"),
    });
  });

  it("loads a local capability only after adopting an inert renderer webview", async () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const webContents = new FakeWebContents();
    electronMocks.webContentsFromId.mockReturnValue(webContents);

    await manager.attachWebview({
      threadId: THREAD_ID,
      tabId: tab.id,
      webContentsId: webContents.id,
    });

    expect(webContents.stop).toHaveBeenCalled();
    expect(webContents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(webContents.loadURL).toHaveBeenCalledWith(FIRST_PREVIEW_URL);
  });

  it("closes a renderer webview whose document committed before first adoption", async () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);
    const webContents = new FakeWebContents(FIRST_PREVIEW_URL, "Already running");
    electronMocks.webContentsFromId.mockReturnValue(webContents);

    await expect(
      manager.attachWebview({
        threadId: THREAD_ID,
        tabId: tab.id,
        webContentsId: webContents.id,
      }),
    ).rejects.toThrow("must be inert before it is attached");

    expect(webContents.stop).toHaveBeenCalled();
    expect(webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(webContents.debugger.attach).not.toHaveBeenCalled();
    expect(managerInternals(manager).runtimes.size).toBe(0);
  });

  it("closes rather than reassigns an adopted renderer webview between tabs", async () => {
    const manager = new DesktopBrowserManager();
    const firstTab = openLocalTab(manager);
    const webContents = new FakeWebContents();
    electronMocks.webContentsFromId.mockReturnValue(webContents);
    await manager.attachWebview({
      threadId: THREAD_ID,
      tabId: firstTab.id,
      webContentsId: webContents.id,
    });

    const secondThreadId = "thread-local-preview-2" as ThreadId;
    const secondTab = manager.open({
      threadId: secondThreadId,
      initialUrl: SECOND_PREVIEW_URL,
      localFilePath: "C:\\work\\second.html",
    }).tabs[0]!;

    await expect(
      manager.attachWebview({
        threadId: secondThreadId,
        tabId: secondTab.id,
        webContentsId: webContents.id,
      }),
    ).rejects.toThrow("cannot be reassigned between tabs");

    expect(webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(managerInternals(manager).runtimes.size).toBe(0);
  });

  it("keeps suspended local tabs dormant until the renderer supplies a fresh grant", async () => {
    const manager = new DesktopBrowserManager();
    const tab = openLocalTab(manager);

    manager.setPanelBounds({
      threadId: THREAD_ID,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      surface: "native",
    });
    manager.reload({ threadId: THREAD_ID, tabId: tab.id });

    expect(managerInternals(manager).runtimes.size).toBe(0);
    expect(manager.getState({ threadId: THREAD_ID }).tabs[0]?.status).toBe("suspended");
    expect(() => manager.openDevTools({ threadId: THREAD_ID, tabId: tab.id })).toThrow(
      "DevTools are unavailable for local previews.",
    );
    await expect(manager.captureScreenshot({ threadId: THREAD_ID, tabId: tab.id })).rejects.toThrow(
      "Refresh this local preview before capturing it.",
    );
  });

  it("wires prevention and recovery to every main-frame navigation event", () => {
    const manager = new DesktopBrowserManager();
    const webContents = new EventEmitter();
    const recover = vi.fn();
    const listenerDisposers: Array<() => void> = [];
    managerInternals(manager).registerPageNavigationGuards(
      webContents,
      (url) => url === FIRST_PREVIEW_URL,
      recover,
      listenerDisposers,
    );
    const willNavigateEvent = { preventDefault: vi.fn() };
    const willRedirectEvent = { preventDefault: vi.fn() };

    webContents.emit("will-navigate", willNavigateEvent, "https://example.com/outside");
    webContents.emit("will-redirect", willRedirectEvent, "file:///C:/outside.html");
    webContents.emit("did-navigate", {}, "https://example.com/outside");
    webContents.emit("did-navigate-in-page", {}, "https://example.com/outside#hash", true);
    webContents.emit("did-navigate-in-page", {}, "https://example.com/frame", false);

    expect(willNavigateEvent.preventDefault).toHaveBeenCalledOnce();
    expect(willRedirectEvent.preventDefault).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledTimes(2);
    listenerDisposers[0]?.();
    expect(webContents.listenerCount("will-navigate")).toBe(0);
    expect(webContents.listenerCount("will-redirect")).toBe(0);
    expect(webContents.listenerCount("did-navigate")).toBe(0);
    expect(webContents.listenerCount("did-navigate-in-page")).toBe(0);
  });

  it("denies window.open escapes from local tabs while preserving scoped tabs and web OAuth", () => {
    const localManager = new DesktopBrowserManager();
    const localTab = openLocalTab(localManager);
    const localContents = new FakeWebContents();
    managerInternals(localManager).configureRuntimeWebContents({
      key: `${THREAD_ID}:${localTab.id}`,
      threadId: THREAD_ID,
      tabId: localTab.id,
      webContents: localContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
      localPreviewGuardInstalled: true,
    });
    const localWindowOpenHandler = localContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(localWindowOpenHandler).toBeDefined();
    expect(
      localWindowOpenHandler?.({
        url: "https://example.com/outside",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(
      localWindowOpenHandler?.({
        url: new URL("assets/inside.html", FIRST_PREVIEW_URL).toString(),
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(localManager.getState({ threadId: THREAD_ID }).tabs).toHaveLength(2);
    expect(localManager.getState({ threadId: THREAD_ID }).tabs[1]).toMatchObject({
      localFilePath: "C:\\work\\index.html",
    });

    const webManager = new DesktopBrowserManager();
    const webTab = webManager.open({
      threadId: THREAD_ID,
      initialUrl: "https://example.com/",
    }).tabs[0]!;
    const webContents = new FakeWebContents();
    managerInternals(webManager).configureRuntimeWebContents({
      key: `${THREAD_ID}:${webTab.id}`,
      threadId: THREAD_ID,
      tabId: webTab.id,
      webContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    const webWindowOpenHandler = webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(
      webWindowOpenHandler?.({
        url: "about:blank",
        frameName: "auth",
        features: "width=480,height=640",
        disposition: "new-window",
      }),
    ).toMatchObject({ action: "allow" });
    expect(
      webWindowOpenHandler?.({
        url: "file:///C:/outside.html",
        frameName: "_blank",
        features: "",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
  });
});
