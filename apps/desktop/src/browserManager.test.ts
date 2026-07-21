import { EventEmitter } from "node:events";

import { ThreadId } from "@synara/contracts";
import type { BrowserWindow, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopBrowserManager } from "./browserManager";
import { ensureAttachedBrowserWebContentsSecurity } from "./browserSecurity";

vi.mock("electron", () => ({
  app: {
    getName: () => "Synara",
    getPreferredSystemLanguages: () => ["en-US"],
    userAgentFallback:
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Electron/40.0.0 Safari/537.36",
  },
  BrowserWindow: class {},
  clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  session: {
    fromPartition: () => ({
      setUserAgent: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
    }),
  },
  webContents: { fromId: vi.fn(() => null) },
  WebContentsView: class {},
}));

interface WindowOpenDetails {
  url: string;
  frameName: string;
  features: string;
  disposition: string;
}

type WindowOpenHandler = (details: WindowOpenDetails) => {
  action: "allow" | "deny";
  overrideBrowserWindowOptions?: object;
};

class FakeWebContents extends EventEmitter {
  readonly id = 1;
  windowOpenHandler: WindowOpenHandler | null = null;

  setUserAgent = vi.fn();

  constructor(private readonly url = "https://app.example.test/") {
    super();
  }

  setWindowOpenHandler(handler: WindowOpenHandler): void {
    this.windowOpenHandler = handler;
  }

  getURL(): string {
    return this.url;
  }
}

class FakePopupWindow extends EventEmitter {
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

  destroy(): void {
    this.destroyed = true;
    this.emit("closed");
  }
}

interface BrowserManagerCharacterizationAccess {
  configureRuntimeWebContents(runtime: {
    key: string;
    threadId: ThreadId;
    tabId: string;
    webContents: WebContents;
    view: null;
    ownsWebContents: false;
    listenerDisposers: Array<() => void>;
  }): void;
  configureOAuthPopupRuntime(runtime: {
    threadId: ThreadId;
    tabId: string;
    window: BrowserWindow;
    listenerDisposers: Array<() => void>;
  }): void;
}

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function asCharacterizationAccess(
  manager: DesktopBrowserManager,
): BrowserManagerCharacterizationAccess {
  return manager as unknown as BrowserManagerCharacterizationAccess;
}

describe("DesktopBrowserManager repeated workflow characterization", () => {
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
    const popup = new FakePopupWindow();
    const access = asCharacterizationAccess(manager);
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
      key: `thread-1:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
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
    expect(tabContents.listenerCount("will-navigate")).toBe(1);
    expect(tabContents.listenerCount("will-redirect")).toBe(1);
    access.configureOAuthPopupRuntime({
      threadId: THREAD_ID,
      tabId,
      window: popup as unknown as BrowserWindow,
      listenerDisposers: [],
    });

    const handlers = [tabContents.windowOpenHandler, popup.webContents.windowOpenHandler];
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
    tabContents.emit("will-navigate", {
      url: "file:///sensitive",
      preventDefault: preventNavigation,
    });
    expect(preventNavigation).toHaveBeenCalledOnce();
  });

  it("derives nested popup navigation guards through the runtime window chain", () => {
    const manager = new DesktopBrowserManager();
    const initial = manager.open({ threadId: THREAD_ID });
    const tabId = initial.activeTabId;
    expect(tabId).not.toBeNull();
    if (!tabId) return;

    const tabContents = new FakeWebContents();
    asCharacterizationAccess(manager).configureRuntimeWebContents({
      key: `thread-1:${tabId}`,
      threadId: THREAD_ID,
      tabId,
      webContents: tabContents as unknown as WebContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    });
    const popup = new FakePopupWindow();
    tabContents.emit("did-create-window", popup, {
      url: "https://accounts.example.test/oauth/authorize",
    });
    const nested = new FakePopupWindow("about:blank");
    popup.webContents.emit("did-create-window", nested, { url: "about:blank" });

    expect(popup.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(nested.setMenuBarVisibility).toHaveBeenCalledWith(false);
    const preventBoundNavigation = vi.fn();
    nested.webContents.emit("will-navigate", {
      url: "https://accounts.example.test/oauth/consent",
      preventDefault: preventBoundNavigation,
    });
    expect(preventBoundNavigation).not.toHaveBeenCalled();
    const preventUnboundNavigation = vi.fn();
    nested.webContents.emit("will-navigate", {
      url: "https://attacker.example/phish",
      preventDefault: preventUnboundNavigation,
    });
    expect(preventUnboundNavigation).toHaveBeenCalledOnce();
    expect(nested.isDestroyed()).toBe(true);
  });
});
