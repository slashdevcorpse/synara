// FILE: browserManager.ts
// Purpose: Owns the desktop in-app browser runtime and maps thread/tab state onto Electron views.
// Layer: Desktop runtime manager
// Depends on: Electron BrowserWindow/WebContentsView, shared browser IPC contracts

import * as Crypto from "node:crypto";

import {
  BrowserWindow,
  clipboard,
  nativeImage,
  webContents as electronWebContents,
  WebContentsView,
} from "electron";
import type { WebContents } from "electron";
import type {
  BrowserAttachWebviewInput,
  BrowserCaptureScreenshotResult,
  BrowserCopyLinkEvent,
  BrowserDetachWebviewInput,
  BrowserExecuteCdpInput,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserPanelBounds,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  BrowserTabState,
  BrowserThreadInput,
  ThreadBrowserState,
  ThreadId,
} from "@synara/contracts";
import { isBrowserCopyLinkChord } from "@synara/shared/browserShortcuts";
import {
  BROWSER_BLANK_URL as ABOUT_BLANK_URL,
  classifyBrowserWindowOpen,
  isBlankBrowserTabUrl,
  resolveCopyableBrowserTabUrl,
} from "@synara/shared/browserSession";
import {
  adoptAttachedBrowserWebContentsSecurity,
  createBrowserPopupNavigationPolicy,
  enforceBrowserPopupNavigationPolicy,
  type BrowserPopupNavigationPolicy,
} from "./browserSecurity";
import { BROWSER_SESSION_PARTITION, BrowserSessionPolicy } from "./browserSessionPolicy";
import {
  isAllowedBrowserNavigation,
  isLocalPreviewRouteUrl,
  parseLocalPreviewCapabilityUrl,
  resolveManagedBrowserNavigation,
  type LocalPreviewCapability,
  type ManagedBrowserNavigationTarget,
} from "./browserNavigationPolicy";
import localPreviewRuntimeGuard from "./localPreviewRuntimeGuard.json";

export { BROWSER_SESSION_PARTITION } from "./browserSessionPolicy";
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS = 1_500;
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS = 400;
const BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD = 1;
const BROWSER_THREAD_SUSPEND_DELAY_MS = 30_000;
const BROWSER_ERROR_ABORTED = -3;
const LOCAL_PREVIEW_GUARD_ERROR =
  "The local preview security guard could not start. Refresh to try again.";
const LOCAL_PREVIEW_GUARD_VERIFICATION_EXPRESSION =
  "['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'].map((name) => typeof globalThis[name])";

type BrowserStateListener = (state: ThreadBrowserState) => void;
type BrowserCopyLinkListener = (event: BrowserCopyLinkEvent) => void;

interface LiveTabRuntime {
  key: string;
  threadId: ThreadId;
  tabId: string;
  webContents: WebContents;
  view: WebContentsView | null;
  ownsWebContents: boolean;
  listenerDisposers: Array<() => void>;
  localPreviewGuardReady?: Promise<void>;
  localPreviewGuardInstalled?: boolean;
}

interface OAuthPopupContext {
  threadId: ThreadId;
  tabId: string;
  navigationPolicy: BrowserPopupNavigationPolicy | null;
  localFilePath: string | null;
  localPreviewCapability: LocalPreviewCapability | null;
}

interface OAuthPopupRuntime extends Omit<OAuthPopupContext, "navigationPolicy"> {
  navigationPolicy: BrowserPopupNavigationPolicy;
  window: BrowserWindow;
  listenerDisposers: Array<() => void>;
}

interface NativeBrowserViewVisibility {
  setVisible?: (visible: boolean) => void;
}

interface PendingRuntimeSync {
  threadId: ThreadId;
  tabId: string;
  faviconUrls?: string[];
}

const LIVE_TAB_STATUS: BrowserTabState["status"] = "live";
const SUSPENDED_TAB_STATUS: BrowserTabState["status"] = "suspended";

interface BrowserPerformanceSnapshot {
  counters: {
    setPanelBoundsCalls: number;
    setPanelBoundsNoopSkips: number;
    setPanelBoundsViewportUpdates: number;
    stateEmitCalls: number;
    stateEmitSkips: number;
    stateCloneCount: number;
    runtimeSyncQueueFlushes: number;
    syncRuntimeStateCalls: number;
    inactiveTabSuspendScheduled: number;
    inactiveTabSuspendCancelled: number;
    inactiveTabBudgetEvictions: number;
    warmInactiveRuntimeCount: number;
  };
  trackedProcessIds: number[];
}

export interface BrowserUseSnapshot {
  threadId: ThreadId;
  state: ThreadBrowserState;
}

export interface BrowserUseCdpEvent {
  method: string;
  params?: unknown;
}

const BLANK_BROWSER_NAVIGATION: ManagedBrowserNavigationTarget = {
  localFilePath: null,
  localPreviewCapability: null,
  url: ABOUT_BLANK_URL,
};

function createBrowserTab(
  navigation: ManagedBrowserNavigationTarget = BLANK_BROWSER_NAVIGATION,
): BrowserTabState {
  return {
    id: Crypto.randomUUID(),
    localFilePath: navigation.localFilePath,
    securityEpoch: 0,
    url: navigation.url,
    title: defaultTitleForUrl(navigation.url, navigation.localFilePath),
    status: SUSPENDED_TAB_STATUS,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: null,
    lastError: null,
  };
}

function defaultThreadBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    version: 0,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function cloneThreadState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function localFileName(localFilePath: string): string {
  const normalized = localFilePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || localFilePath;
}

function defaultTitleForUrl(url: string, localFilePath: string | null = null): string {
  if (localFilePath) {
    return localFileName(localFilePath);
  }
  if (url === ABOUT_BLANK_URL) {
    return "New tab";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function screenshotFileNameForUrl(url: string): string {
  const fallback = "browser";
  try {
    const hostname = new URL(url).hostname.trim().toLowerCase();
    const normalizedHost = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${normalizedHost || fallback}-${Date.now()}.png`;
  } catch {
    return `${fallback}-${Date.now()}.png`;
  }
}

function localPreviewCapabilityForTab(tab: BrowserTabState): LocalPreviewCapability | null {
  if (!tab.localFilePath) {
    return null;
  }
  return parseLocalPreviewCapabilityUrl(tab.url);
}

function isScopedPageNavigationAllowed(
  localFilePath: string | null,
  localPreviewCapability: LocalPreviewCapability | null,
  url: string,
): boolean {
  if (localFilePath && !localPreviewCapability) {
    return false;
  }
  return isAllowedBrowserNavigation({ url, localPreviewCapability });
}

function isPageNavigationAllowed(tab: BrowserTabState, url: string): boolean {
  return isScopedPageNavigationAllowed(
    tab.localFilePath ?? null,
    localPreviewCapabilityForTab(tab),
    url,
  );
}

function localPreviewCapabilityIdentity(
  localFilePath: string | null | undefined,
  localPreviewCapability: LocalPreviewCapability | null,
): string | null {
  if (!localFilePath) {
    return null;
  }
  return localPreviewCapability
    ? `${localPreviewCapability.origin}${localPreviewCapability.pathPrefix}`
    : "invalid-local-preview";
}

function shouldClearNavigationHistory(
  tab: BrowserTabState,
  navigation: ManagedBrowserNavigationTarget,
): boolean {
  return (
    localPreviewCapabilityIdentity(tab.localFilePath, localPreviewCapabilityForTab(tab)) !==
    localPreviewCapabilityIdentity(navigation.localFilePath, navigation.localPreviewCapability)
  );
}

function browserHistoryTargetUrl(webContents: WebContents, offset: -1 | 1): string | null {
  const history = webContents.navigationHistory;
  if (!history?.canGoToOffset(offset)) {
    return null;
  }
  try {
    return history.getEntryAtIndex(history.getActiveIndex() + offset)?.url ?? null;
  } catch {
    return null;
  }
}

function canNavigateBrowserHistory(
  webContents: WebContents,
  tab: BrowserTabState,
  offset: -1 | 1,
): boolean {
  const targetUrl = browserHistoryTargetUrl(webContents, offset);
  return targetUrl !== null && isPageNavigationAllowed(tab, targetUrl);
}

function clearBrowserNavigationHistory(webContents: WebContents): void {
  try {
    webContents.navigationHistory?.clear();
  } catch {
    // An adopted or tearing-down webContents can reject history access. The
    // destination checks remain the fallback boundary in that case.
  }
}

function normalizeBounds(bounds: BrowserPanelBounds | null): BrowserPanelBounds | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  if (width === 0 || height === 0) {
    return null;
  }

  return {
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
    width,
    height,
  };
}

function isAbortedNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /ERR_ABORTED|\(-3\)/i.test(error.message);
}

function mapBrowserLoadError(errorCode: number): string {
  switch (errorCode) {
    case -102:
      return "Connection refused.";
    case -105:
      return "Couldn't resolve this address.";
    case -106:
      return "You're offline.";
    case -118:
      return "This page took too long to respond.";
    case -137:
      return "A secure connection couldn't be established.";
    case -200:
      return "A secure connection couldn't be established.";
    default:
      return "Couldn't open this page.";
  }
}

function buildRuntimeKey(threadId: ThreadId, tabId: string): string {
  return `${threadId}:${tabId}`;
}

function browserBoundsSignature(bounds: BrowserPanelBounds | null): string {
  if (!bounds) {
    return "hidden";
  }

  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

export class DesktopBrowserManager {
  private window: BrowserWindow | null = null;
  private activeThreadId: ThreadId | null = null;
  private activeBounds: BrowserPanelBounds | null = null;
  private activeBoundsThreadId: ThreadId | null = null;
  private attachedRuntimeKey: string | null = null;
  private attachedBoundsSignature: string | null = null;
  private readonly states = new Map<ThreadId, ThreadBrowserState>();
  private readonly threadVersionById = new Map<ThreadId, number>();
  private readonly snapshotCacheByThreadId = new Map<
    ThreadId,
    { version: number; snapshot: ThreadBrowserState }
  >();
  private readonly lastEmittedVersionByThreadId = new Map<ThreadId, number>();
  private readonly runtimes = new Map<string, LiveTabRuntime>();
  private readonly runtimeLastActiveAtByKey = new Map<string, number>();
  private readonly pendingRuntimeSyncs = new Map<string, PendingRuntimeSync>();
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly copyLinkListeners = new Set<BrowserCopyLinkListener>();
  // OAuth/sign-in popups opened by pages via `window.open`. Tracked so they can be sized over
  // the panel and torn down cleanly without leaking native windows.
  private readonly popupRuntimes = new Map<BrowserWindow, OAuthPopupRuntime>();
  private readonly sessionPolicy = new BrowserSessionPolicy();
  private readonly tabSuspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly suspendTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private runtimeSyncFlushScheduled = false;
  private readonly perfCounters = {
    setPanelBoundsCalls: 0,
    setPanelBoundsNoopSkips: 0,
    setPanelBoundsViewportUpdates: 0,
    stateEmitCalls: 0,
    stateEmitSkips: 0,
    stateCloneCount: 0,
    runtimeSyncQueueFlushes: 0,
    syncRuntimeStateCalls: 0,
    inactiveTabSuspendScheduled: 0,
    inactiveTabSuspendCancelled: 0,
    inactiveTabBudgetEvictions: 0,
    warmInactiveRuntimeCount: 0,
  };

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (window) {
      const bounds = this.activeThreadId
        ? this.getVisibleBoundsForThread(this.activeThreadId)
        : null;
      if (this.activeThreadId && bounds) {
        this.attachActiveTab(this.activeThreadId, bounds);
      }
      return;
    }

    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.closeAllPopupWindows();
  }

  subscribe(listener: BrowserStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeCopyLink(listener: BrowserCopyLinkListener): () => void {
    this.copyLinkListeners.add(listener);
    return () => {
      this.copyLinkListeners.delete(listener);
    };
  }

  private tabForNavigationContext(
    context: Pick<OAuthPopupContext, "threadId" | "tabId">,
  ): BrowserTabState | null {
    const state = this.states.get(context.threadId);
    return state ? this.getTab(state, context.tabId) : null;
  }

  private isRuntimePageNavigationAllowed(context: LiveTabRuntime, url: string): boolean {
    const tab = this.tabForNavigationContext(context);
    return (
      tab !== null &&
      (!tab.localFilePath || context.localPreviewGuardInstalled === true) &&
      isPageNavigationAllowed(tab, url)
    );
  }

  private popupContextForTab(threadId: ThreadId, tabId: string): OAuthPopupContext | null {
    const tab = this.tabForNavigationContext({ threadId, tabId });
    if (!tab) {
      return null;
    }
    return {
      threadId,
      tabId,
      navigationPolicy: null,
      localFilePath: tab.localFilePath ?? null,
      localPreviewCapability: localPreviewCapabilityForTab(tab),
    };
  }

  private isPopupPageNavigationAllowed(context: OAuthPopupContext, url: string): boolean {
    return isScopedPageNavigationAllowed(
      context.localFilePath,
      context.localPreviewCapability,
      url,
    );
  }

  private registerPageNavigationGuards(
    webContents: WebContents,
    isAllowed: (url: string) => boolean,
    onDisallowedNavigation: () => void,
    listenerDisposers: Array<() => void>,
  ): void {
    const preventDisallowedNavigation = (event: Electron.Event, url: string) => {
      if (!isAllowed(url)) {
        event.preventDefault();
      }
    };
    const recoverDisallowedNavigation = (_event: Electron.Event, url: string) => {
      if (!isAllowed(url)) {
        onDisallowedNavigation();
      }
    };
    const recoverDisallowedInPageNavigation = (
      _event: Electron.Event,
      url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && !isAllowed(url)) {
        onDisallowedNavigation();
      }
    };
    webContents.on("will-navigate", preventDisallowedNavigation);
    webContents.on("will-redirect", preventDisallowedNavigation);
    webContents.on("did-navigate", recoverDisallowedNavigation);
    webContents.on("did-navigate-in-page", recoverDisallowedInPageNavigation);
    listenerDisposers.push(() => {
      webContents.removeListener("will-navigate", preventDisallowedNavigation);
      webContents.removeListener("will-redirect", preventDisallowedNavigation);
      webContents.removeListener("did-navigate", recoverDisallowedNavigation);
      webContents.removeListener("did-navigate-in-page", recoverDisallowedInPageNavigation);
    });
  }

  private configureWindowOpenHandling(
    webContents: WebContents,
    context: OAuthPopupContext,
    listenerDisposers: Array<() => void>,
    options: {
      readonly closeOnBlockedNavigation?: () => void;
      readonly isUrlAllowed?: (url: string) => boolean;
      readonly resolveContext?: () => OAuthPopupContext | null;
    } = {},
  ): void {
    const isUrlAllowed =
      options.isUrlAllowed ?? ((url: string) => this.isPopupPageNavigationAllowed(context, url));
    const resolveContext = options.resolveContext ?? (() => context);

    const popupNavigationPolicy = context.navigationPolicy;
    if (popupNavigationPolicy) {
      const willNavigate = (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>) => {
        enforceBrowserPopupNavigationPolicy(
          popupNavigationPolicy,
          event,
          options.closeOnBlockedNavigation,
        );
      };
      const willRedirect = (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
        enforceBrowserPopupNavigationPolicy(
          popupNavigationPolicy,
          event,
          options.closeOnBlockedNavigation,
        );
      };
      webContents.on("will-navigate", willNavigate);
      webContents.on("will-redirect", willRedirect);
      listenerDisposers.push(() => {
        webContents.removeListener("will-navigate", willNavigate);
        webContents.removeListener("will-redirect", willRedirect);
      });
    }

    // Auth providers can chain web popups (provider -> consent). Page-controlled custom
    // schemes and destinations outside a local preview capability are denied here.
    webContents.setWindowOpenHandler((details) => {
      const { url } = details;
      const activeContext = resolveContext();
      if (
        !activeContext ||
        !isUrlAllowed(url) ||
        (activeContext.navigationPolicy !== null &&
          !activeContext.navigationPolicy.allowsNestedOpen(url))
      ) {
        return { action: "deny" };
      }

      const kind = classifyBrowserWindowOpen({
        url,
        frameName: details.frameName,
        features: details.features,
        disposition: details.disposition,
      });
      if (kind === "popup") {
        // Allow (don't deny) so Electron creates a real child window that keeps
        // `window.opener`, which the OAuth callback needs to message the page back.
        return {
          action: "allow",
          overrideBrowserWindowOptions: this.sessionPolicy.buildOAuthPopupWindowOptions(
            this.window,
          ),
        };
      }

      this.newTab({
        threadId: activeContext.threadId,
        url,
        ...(activeContext.localFilePath ? { localFilePath: activeContext.localFilePath } : {}),
        activate: true,
      });
      const bounds = this.getVisibleBoundsForThread(activeContext.threadId);
      if (this.activeThreadId === activeContext.threadId && bounds) {
        this.attachActiveTab(activeContext.threadId, bounds);
      }
      return { action: "deny" };
    });

    const didCreateWindow = (
      childWindow: BrowserWindow,
      details: Electron.DidCreateWindowDetails,
    ) => {
      const activeContext = resolveContext();
      if (!activeContext || !isUrlAllowed(details.url)) {
        if (!childWindow.isDestroyed()) childWindow.destroy();
        return;
      }
      const navigationPolicy = activeContext.navigationPolicy
        ? activeContext.navigationPolicy.deriveNested(details.url)
        : createBrowserPopupNavigationPolicy({
            openerUrl: webContents.getURL(),
            initialUrl: details.url,
            allowAboutBlankOriginBinding: true,
          });
      if (!navigationPolicy) {
        if (!childWindow.isDestroyed()) childWindow.destroy();
        return;
      }
      this.registerOAuthPopupWindow(childWindow, {
        ...activeContext,
        navigationPolicy,
      });
    };
    webContents.on("did-create-window", didCreateWindow);
    listenerDisposers.push(() => {
      webContents.removeListener("did-create-window", didCreateWindow);
    });
  }

  private registerOAuthPopupWindow(
    popup: BrowserWindow,
    context: OAuthPopupContext & { navigationPolicy: BrowserPopupNavigationPolicy },
  ): void {
    if (this.popupRuntimes.has(popup)) {
      return;
    }
    const runtime: OAuthPopupRuntime = {
      ...context,
      window: popup,
      listenerDisposers: [],
    };
    this.popupRuntimes.set(popup, runtime);
    popup.setMenuBarVisibility(false);
    this.configureOAuthPopupRuntime(runtime);
    this.centerPopupWindow(runtime);
  }

  private configureOAuthPopupRuntime(runtime: OAuthPopupRuntime): void {
    const { window: popup } = runtime;
    const { webContents } = popup;
    this.sessionPolicy.applyUserAgent(webContents);
    this.registerPageNavigationGuards(
      webContents,
      (url) => this.isPopupPageNavigationAllowed(runtime, url),
      () => this.closePopupRuntime(runtime),
      runtime.listenerDisposers,
    );
    const closeOnInput = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown") {
        return;
      }
      const key = input.key.toLowerCase();
      const isCloseChord =
        key === "escape" ||
        (key === "w" && !input.shift && !input.alt && (input.meta || input.control));
      if (!isCloseChord) {
        return;
      }
      event.preventDefault();
      this.closePopupRuntime(runtime);
    };
    webContents.on("before-input-event", closeOnInput);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-input-event", closeOnInput);
    });

    this.configureWindowOpenHandling(webContents, runtime, runtime.listenerDisposers, {
      closeOnBlockedNavigation: () => {
        this.closePopupRuntime(runtime);
      },
    });

    popup.once("closed", () => {
      this.removePopupRuntime(runtime);
    });
  }

  private removePopupRuntime(runtime: OAuthPopupRuntime): void {
    if (this.popupRuntimes.get(runtime.window) !== runtime) {
      return;
    }
    for (const dispose of runtime.listenerDisposers.splice(0)) {
      dispose();
    }
    this.popupRuntimes.delete(runtime.window);
  }

  private closePopupRuntime(runtime: OAuthPopupRuntime): void {
    this.removePopupRuntime(runtime);
    if (!runtime.window.isDestroyed()) {
      runtime.window.destroy();
    }
  }

  private centerPopupWindow(runtime: OAuthPopupRuntime): void {
    const parent = this.window;
    const popup = runtime.window;
    if (!parent || parent.isDestroyed() || popup.isDestroyed()) {
      return;
    }
    const parentBounds = parent.getBounds();
    const popupBounds = popup.getBounds();
    const nextBounds = {
      x: Math.round(parentBounds.x + (parentBounds.width - popupBounds.width) / 2),
      y: Math.round(parentBounds.y + (parentBounds.height - popupBounds.height) / 2),
      width: popupBounds.width,
      height: popupBounds.height,
    };
    if (
      popupBounds.x === nextBounds.x &&
      popupBounds.y === nextBounds.y &&
      popupBounds.width === nextBounds.width &&
      popupBounds.height === nextBounds.height
    ) {
      return;
    }
    popup.setBounds(nextBounds);
  }

  private updatePopupWindowsForThread(threadId: ThreadId): void {
    for (const runtime of this.popupRuntimes.values()) {
      if (runtime.threadId === threadId) {
        this.centerPopupWindow(runtime);
      }
    }
  }

  private closePopupWindowsWhere(shouldClose: (runtime: OAuthPopupRuntime) => boolean): void {
    for (const runtime of [...this.popupRuntimes.values()]) {
      if (shouldClose(runtime)) {
        this.closePopupRuntime(runtime);
      }
    }
  }

  private closePopupWindowsForThread(threadId: ThreadId): void {
    this.closePopupWindowsWhere((runtime) => runtime.threadId === threadId);
  }

  private closePopupWindowsForTab(threadId: ThreadId, tabId: string): void {
    this.closePopupWindowsWhere(
      (runtime) => runtime.threadId === threadId && runtime.tabId === tabId,
    );
  }

  private closeAllPopupWindows(): void {
    this.closePopupWindowsWhere(() => true);
  }

  dispose(): void {
    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    for (const timer of this.tabSuspendTimers.values()) {
      clearTimeout(timer);
    }
    this.tabSuspendTimers.clear();
    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.closeAllPopupWindows();
    this.pendingRuntimeSyncs.clear();
    this.runtimeLastActiveAtByKey.clear();
    this.listeners.clear();
    this.copyLinkListeners.clear();
    this.states.clear();
    this.threadVersionById.clear();
    this.snapshotCacheByThreadId.clear();
    this.lastEmittedVersionByThreadId.clear();
    this.window = null;
    this.activeThreadId = null;
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
    this.attachedBoundsSignature = null;
    this.runtimeSyncFlushScheduled = false;
  }

  getPerformanceSnapshot(): BrowserPerformanceSnapshot {
    this.perfCounters.warmInactiveRuntimeCount = this.countWarmInactiveRuntimes();
    return {
      counters: { ...this.perfCounters },
      trackedProcessIds: this.getTrackedProcessIds(),
    };
  }

  getBrowserUseSnapshot(): BrowserUseSnapshot | null {
    if (this.activeThreadId) {
      const activeState = this.states.get(this.activeThreadId);
      if (activeState?.open) {
        return {
          threadId: this.activeThreadId,
          state: this.snapshotThreadState(this.activeThreadId, activeState),
        };
      }
    }

    for (const [threadId, state] of this.states) {
      if (state.open) {
        return {
          threadId,
          state: this.snapshotThreadState(threadId, state),
        };
      }
    }
    return null;
  }

  open(input: BrowserOpenInput): ThreadBrowserState {
    const requestedNavigation =
      input.initialUrl !== undefined || input.localFilePath != null
        ? resolveManagedBrowserNavigation({
            url: input.initialUrl,
            ...(input.localFilePath !== undefined ? { localFilePath: input.localFilePath } : {}),
          })
        : null;
    const state = this.ensureWorkspace(input.threadId, requestedNavigation);
    const didChange = !state.open;
    state.open = true;
    const activeTab = requestedNavigation ? this.getActiveTab(state) : null;
    if (
      requestedNavigation &&
      activeTab &&
      (activeTab.url !== requestedNavigation.url ||
        activeTab.localFilePath !== requestedNavigation.localFilePath)
    ) {
      return this.navigate({
        threadId: input.threadId,
        tabId: activeTab.id,
        url: requestedNavigation.url,
        ...(requestedNavigation.localFilePath
          ? { localFilePath: requestedNavigation.localFilePath }
          : {}),
      });
    }

    const nextDidChange = syncThreadLastError(state) || didChange;

    if (
      this.activeBounds &&
      this.activeBoundsThreadId === input.threadId &&
      (this.activeThreadId === null || this.activeThreadId === input.threadId)
    ) {
      const visibleTab = this.getActiveTab(state);
      if (!isBlankBrowserTabUrl(visibleTab)) {
        this.activateThread(input.threadId, this.activeBounds);
      }
    }

    if (nextDidChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  close(input: BrowserThreadInput): ThreadBrowserState {
    this.clearSuspendTimer(input.threadId);

    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }
    this.clearActiveBoundsForThread(input.threadId);
    this.closePopupWindowsForThread(input.threadId);

    this.destroyThreadRuntimes(input.threadId);

    const state = this.getOrCreateState(input.threadId);
    state.open = false;
    state.activeTabId = null;
    state.tabs = [];
    state.lastError = null;
    this.markThreadStateChanged(input.threadId);
    this.lastEmittedVersionByThreadId.delete(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  hide(input: BrowserThreadInput): void {
    const state = this.states.get(input.threadId);
    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }

    if (!state?.open) {
      return;
    }

    this.scheduleThreadSuspend(input.threadId);
  }

  getState(input: BrowserThreadInput): ThreadBrowserState {
    return this.snapshotThreadState(input.threadId);
  }

  setPanelBounds(input: BrowserSetPanelBoundsInput): void {
    this.perfCounters.setPanelBoundsCalls += 1;
    const state = this.getOrCreateState(input.threadId);
    const nextBounds = normalizeBounds(input.bounds);
    const nextBoundsSignature = browserBoundsSignature(nextBounds);
    const activeTabId = this.getActiveTab(state)?.id ?? null;
    const activeRuntimeKey = activeTabId ? buildRuntimeKey(input.threadId, activeTabId) : null;
    const activeRuntime = activeRuntimeKey ? this.runtimes.get(activeRuntimeKey) : null;
    this.setActiveBounds(input.threadId, nextBounds);

    if (!state.open || nextBounds === null) {
      if (this.activeThreadId === input.threadId) {
        this.detachAttachedRuntime();
        this.activeThreadId = null;
        this.scheduleThreadSuspend(input.threadId);
      }
      return;
    }

    if (
      input.surface === "native" &&
      activeTabId &&
      activeRuntime &&
      !activeRuntime.ownsWebContents
    ) {
      // Sheet mode renders more reliably with the native WebContentsView than a translated <webview>.
      this.destroyRuntime(input.threadId, activeTabId);
      const activeTab = this.getTab(state, activeTabId);
      if (activeTab) {
        suspendTabState(activeTab);
        this.markThreadStateChanged(input.threadId);
      }
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
    }

    if (input.surface === "renderer" && activeTabId && !activeRuntime) {
      this.activateThreadForPendingRenderer(input.threadId, nextBounds);
      return;
    }

    // Bounds sync fires often during panel motion. If the visible runtime and
    // applied viewport are already current, avoid waking the browser stack again.
    if (
      this.activeThreadId === input.threadId &&
      this.attachedRuntimeKey === activeRuntimeKey &&
      this.attachedBoundsSignature === nextBoundsSignature
    ) {
      this.perfCounters.setPanelBoundsNoopSkips += 1;
      return;
    }

    this.updatePopupWindowsForThread(input.threadId);

    if (this.activeThreadId === input.threadId) {
      if (activeRuntimeKey && this.attachedRuntimeKey === activeRuntimeKey) {
        const runtime = this.runtimes.get(activeRuntimeKey);
        if (runtime) {
          this.perfCounters.setPanelBoundsViewportUpdates += 1;
          this.attachRuntime(runtime, nextBounds);
          return;
        }
      }
      this.attachActiveTab(input.threadId, nextBounds);
      return;
    }

    this.activateThread(input.threadId, nextBounds);
  }

  // Adopts the renderer-owned <webview> so the visible page and browser-use tools
  // share one WebContents instead of racing a hidden native WebContentsView.
  async attachWebview(input: BrowserAttachWebviewInput): Promise<ThreadBrowserState> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const webContents = electronWebContents.fromId(input.webContentsId);
    if (!webContents || webContents.isDestroyed()) {
      throw new Error("The visible browser webview is not available.");
    }
    if (webContents.getType() !== "webview") {
      throw new Error("Only an attached browser webview can become the visible browser surface.");
    }

    const key = buildRuntimeKey(input.threadId, tab.id);
    const existingRendererRuntime = this.findRendererRuntimeByWebContentsId(webContents.id);
    if (existingRendererRuntime && existingRendererRuntime.key !== key) {
      this.destroyRuntimeForSecurityTransition(
        existingRendererRuntime.threadId,
        existingRendererRuntime.tabId,
      );
      throw new Error("A browser webview cannot be reassigned between tabs.");
    }

    const existing = this.runtimes.get(key);
    let createdRuntime = false;
    if (existing?.webContents.id !== webContents.id) {
      if (existing) {
        this.destroyRuntimeForSecurityTransition(input.threadId, tab.id);
      }

      // will-attach-webview also overwrites renderer input with about:blank.
      // Stop first to cancel a renderer-triggered navigation that has not yet
      // committed, then reject any document that was already allowed to run.
      webContents.stop();
      const initialUrl = webContents.getURL();
      if (initialUrl.length > 0 && initialUrl !== ABOUT_BLANK_URL) {
        this.closeUnmanagedRendererWebContents(webContents);
        throw new Error("A browser webview must be inert before it is attached.");
      }
      const runtime: LiveTabRuntime = {
        key,
        threadId: input.threadId,
        tabId: tab.id,
        webContents,
        view: null,
        ownsWebContents: false,
        listenerDisposers: [],
      };
      this.configureRuntimeWebContents(runtime);
      this.runtimes.set(key, runtime);
      this.prepareLocalPreviewRuntimeGuard(runtime, tab);
      createdRuntime = true;
    }

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    const runtime = this.runtimes.get(key);
    if (runtime) {
      this.prepareLocalPreviewRuntimeGuard(runtime, tab);
    }
    const adoptedUrl = runtime?.webContents.getURL() ?? "";
    let loadedManagedUrl = false;
    if (runtime?.localPreviewGuardReady) {
      try {
        await runtime.localPreviewGuardReady;
      } catch {
        this.failClosedLocalPreviewRuntime(runtime, LOCAL_PREVIEW_GUARD_ERROR);
        throw new Error(LOCAL_PREVIEW_GUARD_ERROR);
      }
    }
    if (
      runtime &&
      ((createdRuntime && tab.url !== ABOUT_BLANK_URL) ||
        !adoptedUrl ||
        !isPageNavigationAllowed(tab, adoptedUrl))
    ) {
      runtime.webContents.stop();
      await this.loadTab(input.threadId, tab.id, { force: true, runtime });
      loadedManagedUrl = true;
    }
    if (runtime && bounds) {
      this.attachRuntime(runtime, bounds);
    }

    const didChange =
      tab.status !== LIVE_TAB_STATUS || (!loadedManagedUrl && tab.lastError !== null);
    tab.status = LIVE_TAB_STATUS;
    if (!loadedManagedUrl) {
      tab.lastError = null;
    }
    syncThreadLastError(state);
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.queueRuntimeStateSync(input.threadId, tab.id);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  // Drops main-process ownership of a renderer-owned <webview> that React removed.
  // The webContents id guard keeps stale cleanup calls from tearing down a newly attached view.
  detachWebview(input: BrowserDetachWebviewInput): void {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state || !tab) {
      return;
    }

    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (!runtime || runtime.ownsWebContents || runtime.webContents.id !== input.webContentsId) {
      return;
    }

    this.destroyRuntime(input.threadId, input.tabId);
    const didChange = suspendTabState(tab) || syncThreadLastError(state);
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }
  }

  navigate(input: BrowserNavigateInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const navigation = resolveManagedBrowserNavigation({
      url: input.url,
      ...(input.localFilePath !== undefined ? { localFilePath: input.localFilePath } : {}),
    });
    const clearHistory = shouldClearNavigationHistory(tab, navigation);
    let waitForRendererRemount = false;
    if (clearHistory) {
      this.closePopupWindowsForTab(input.threadId, tab.id);
      waitForRendererRemount =
        this.destroyRuntimeForSecurityTransition(input.threadId, tab.id) === "renderer";
      tab.securityEpoch = (tab.securityEpoch ?? 0) + 1;
    }
    tab.localFilePath = navigation.localFilePath;
    tab.url = navigation.url;
    tab.title = defaultTitleForUrl(navigation.url, navigation.localFilePath);
    tab.faviconUrl = null;
    tab.lastCommittedUrl = null;
    tab.lastError = null;
    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);

    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    if (runtime) {
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachRuntime(runtime, bounds);
      }
      void this.loadTab(input.threadId, tab.id, { clearHistory, force: true, runtime });
    } else if (this.activeThreadId === input.threadId && !waitForRendererRemount) {
      // Load the target tab directly so we don't clobber its pending URL with a
      // thread-wide runtime sync from the old live page state.
      const nextRuntime = this.ensureLiveRuntime(input.threadId, tab.id);
      this.clearSuspendTimer(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachRuntime(nextRuntime, bounds);
      }
      void this.loadTab(input.threadId, tab.id, {
        clearHistory,
        force: true,
        runtime: nextRuntime,
      });
    }

    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  reload(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    if (runtime) {
      const currentUrl = runtime.webContents.getURL() || tab.url;
      if (isPageNavigationAllowed(tab, currentUrl)) {
        runtime.webContents.reload();
      }
    } else if (this.activeThreadId === input.threadId && !tab.localFilePath) {
      this.resumeThread(input.threadId);
      void this.loadTab(input.threadId, tab.id, { force: true });
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  goBack(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && canNavigateBrowserHistory(runtime.webContents, tab, -1)) {
      runtime.webContents.navigationHistory.goBack();
    }
    return this.getState({ threadId: input.threadId });
  }

  goForward(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && canNavigateBrowserHistory(runtime.webContents, tab, 1)) {
      runtime.webContents.navigationHistory.goForward();
    }
    return this.getState({ threadId: input.threadId });
  }

  newTab(input: BrowserNewTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const navigation = resolveManagedBrowserNavigation({
      url: input.url,
      ...(input.localFilePath !== undefined ? { localFilePath: input.localFilePath } : {}),
    });
    const tab = createBrowserTab(navigation);
    state.tabs = [...state.tabs, tab];
    if (input.activate !== false || !state.activeTabId) {
      state.activeTabId = tab.id;
    }

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachActiveTab(input.threadId, bounds, { forceLoad: true });
      }
    } else {
      tab.status = "suspended";
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  closeTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
    if (nextTabs.length === state.tabs.length) {
      return this.snapshotThreadState(input.threadId, state);
    }

    this.closePopupWindowsForTab(input.threadId, input.tabId);
    this.destroyRuntime(input.threadId, input.tabId);
    state.tabs = nextTabs;

    if (nextTabs.length === 0) {
      // Closing the last tab keeps the browser open on a fresh blank tab (the same state
      // as a brand-new browser session) so the user can type a new URL in the search box,
      // instead of tearing the whole panel down.
      const replacementTab = createBrowserTab();
      state.tabs = [replacementTab];
      state.activeTabId = replacementTab.id;
      state.lastError = null;

      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
      return this.snapshotThreadState(input.threadId, state);
    }

    if (!state.activeTabId || state.activeTabId === input.tabId) {
      state.activeTabId = nextTabs[Math.max(0, nextTabs.length - 1)]?.id ?? null;
    }

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (this.activeThreadId === input.threadId && bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  selectTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.activateTab(input.threadId, state, tab);

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (bounds) {
        this.attachActiveTab(input.threadId, bounds);
      }
    }

    return this.snapshotThreadState(input.threadId, state);
  }

  openDevTools(input: BrowserTabInput): void {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.activateTab(input.threadId, state, tab);

    if (tab.localFilePath) {
      throw new Error("DevTools are unavailable for local previews.");
    }
    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }
    runtime.webContents.openDevTools({ mode: "detach" });
  }

  // Ensures the requested tab is active/live, then returns a fresh PNG capture
  // from the native browser surface for whichever destination needs it next.
  private async captureScreenshotPng(input: BrowserTabInput): Promise<{
    name: string;
    pngBytes: Buffer;
  }> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.activateTab(input.threadId, state, tab);

    this.resumeThread(input.threadId);
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    if (wasSuspended && tab.localFilePath) {
      throw new Error("Refresh this local preview before capturing it.");
    }
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.webContents;
    const expectedUrl = resolveManagedBrowserNavigation({
      url: tab.lastCommittedUrl ?? tab.url,
      ...(tab.localFilePath ? { localFilePath: tab.localFilePath } : {}),
    }).url;
    const currentUrl = webContents.getURL();
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    if (wasSuspended || currentUrl.length === 0 || currentUrl !== expectedUrl) {
      await this.loadTab(input.threadId, tab.id, { runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    const pngBytes = (await webContents.capturePage()).toPNG();
    if (pngBytes.byteLength === 0) {
      throw new Error("Couldn't capture a browser screenshot.");
    }

    return {
      name: screenshotFileNameForUrl(tab.lastCommittedUrl ?? tab.url),
      pngBytes,
    };
  }

  // Captures the current browser viewport as a PNG so the renderer can attach
  // it directly to the composer without introducing temp-file disk churn.
  async captureScreenshot(input: BrowserTabInput): Promise<BrowserCaptureScreenshotResult> {
    const { name, pngBytes } = await this.captureScreenshotPng(input);

    return {
      name,
      mimeType: "image/png",
      sizeBytes: pngBytes.byteLength,
      bytes: Uint8Array.from(pngBytes),
    };
  }

  // Copies the active tab's URL via the native clipboard and emits the copy-link
  // event, mirroring the keyboard-chord path. The renderer's navigator.clipboard
  // can reject with "Document is not focused" while the native page view holds
  // focus, so the React toolbar button routes through here for reliability.
  copyLink(input: BrowserTabInput): void {
    this.copyTabLink(input.threadId, input.tabId);
  }

  // Writes the current browser viewport screenshot straight to the native
  // clipboard so the renderer does not have to ferry image payloads over IPC.
  async copyScreenshotToClipboard(input: BrowserTabInput): Promise<void> {
    const { pngBytes } = await this.captureScreenshotPng(input);
    const image = nativeImage.createFromBuffer(pngBytes);
    if (image.isEmpty()) {
      throw new Error("Couldn't copy a browser screenshot to the clipboard.");
    }
    clipboard.writeImage(image);
  }

  // Runs a Chrome DevTools Protocol command against the requested tab so higher-level
  // browser automation can reuse the native browser runtime instead of scripting React.
  async executeCdp(input: BrowserExecuteCdpInput): Promise<unknown> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.assertBrowserAutomationAllowed(tab);
    this.activateTab(input.threadId, state, tab);

    this.resumeThread(input.threadId);
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.webContents;
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    if (wasSuspended) {
      await this.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    try {
      return await webContents.debugger.sendCommand(input.method, input.params ?? {});
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`CDP ${input.method} failed: ${error.message}`);
      }
      throw error;
    }
  }

  async attachBrowserUseTab(input: BrowserTabInput): Promise<void> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.assertBrowserAutomationAllowed(tab);
    this.activateTab(input.threadId, state, tab);

    this.resumeThread(input.threadId);
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    if (this.activeBounds && this.activeBoundsThreadId === input.threadId) {
      this.activateThread(input.threadId, this.activeBounds);
    }

    if (wasSuspended) {
      await this.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    if (!runtime.webContents.debugger.isAttached()) {
      runtime.webContents.debugger.attach("1.3");
    }
  }

  subscribeToCdpEvents(
    input: BrowserTabInput,
    listener: (event: BrowserUseCdpEvent) => void,
  ): () => void {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    this.assertBrowserAutomationAllowed(tab);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (!runtime) {
      return () => {};
    }

    const handleMessage = (_event: Electron.Event, method: string, params?: unknown) => {
      listener({
        method,
        ...(params !== undefined ? { params } : {}),
      });
    };

    runtime.webContents.debugger.on("message", handleMessage);
    return () => {
      runtime.webContents.debugger.removeListener("message", handleMessage);
    };
  }

  private assertBrowserAutomationAllowed(tab: BrowserTabState): void {
    if (
      tab.localFilePath ||
      isLocalPreviewRouteUrl(tab.url) ||
      (tab.lastCommittedUrl ? isLocalPreviewRouteUrl(tab.lastCommittedUrl) : false)
    ) {
      throw new Error("Browser automation is unavailable for local previews.");
    }
  }

  private activateThread(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const previousThreadId = this.activeThreadId;
    if (this.activeThreadId && this.activeThreadId !== threadId) {
      this.scheduleThreadSuspend(this.activeThreadId);
    }

    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
    if (previousThreadId && previousThreadId !== threadId) {
      this.updatePopupWindowsForThread(previousThreadId);
    }
    this.resumeThread(threadId);
    this.attachActiveTab(threadId, bounds);
    this.updatePopupWindowsForThread(threadId);
  }

  // Renderer panels create their own <webview>; keep active-thread bookkeeping current while
  // waiting for attachWebview so startup does not create a duplicate native WebContentsView.
  private activateThreadForPendingRenderer(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const previousThreadId = this.activeThreadId;
    if (previousThreadId && previousThreadId !== threadId) {
      this.scheduleThreadSuspend(previousThreadId);
      this.updatePopupWindowsForThread(previousThreadId);
    }
    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
    this.clearSuspendTimer(threadId);
    this.updatePopupWindowsForThread(threadId);
  }

  private setActiveBounds(threadId: ThreadId, bounds: BrowserPanelBounds | null): void {
    if (!bounds) {
      this.clearActiveBoundsForThread(threadId);
      return;
    }
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
  }

  private clearActiveBoundsForThread(threadId: ThreadId): void {
    if (this.activeBoundsThreadId !== threadId) {
      return;
    }
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
  }

  private getVisibleBoundsForThread(threadId: ThreadId): BrowserPanelBounds | null {
    return this.activeBoundsThreadId === threadId ? this.activeBounds : null;
  }

  private resumeThread(threadId: ThreadId): void {
    const state = this.ensureWorkspace(threadId);
    if (!state.open) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const activeTab = this.getActiveTab(state);
    let didChange = this.suspendInactiveTabs(threadId, activeTab?.id ?? null);

    // Only resume the visible tab. Waking every tab can fan out into several
    // Chromium renderer processes and background page activity at once.
    for (const tab of state.tabs) {
      if (tab.id !== activeTab?.id) {
        continue;
      }
      const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
      if (wasSuspended && tab.localFilePath) {
        continue;
      }
      const runtime = this.ensureLiveRuntime(threadId, tab.id);
      if (wasSuspended) {
        void this.loadTab(threadId, tab.id, { force: true, runtime });
      } else {
        didChange = syncTabStateFromRuntime(state, tab, runtime.webContents) || didChange;
      }
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private suspendInactiveTabs(threadId: ThreadId, activeTabId: string | null): boolean {
    const state = this.states.get(threadId);
    if (!state) {
      return false;
    }

    let didChange = false;
    const inactiveRuntimeTabIds = state.tabs
      .filter((tab) => tab.id !== activeTabId)
      .filter((tab) => this.runtimes.has(buildRuntimeKey(threadId, tab.id)))
      .sort((left, right) => {
        const leftKey = buildRuntimeKey(threadId, left.id);
        const rightKey = buildRuntimeKey(threadId, right.id);
        return (
          (this.runtimeLastActiveAtByKey.get(rightKey) ?? 0) -
          (this.runtimeLastActiveAtByKey.get(leftKey) ?? 0)
        );
      });
    const warmRuntimeTabIds = new Set(
      inactiveRuntimeTabIds
        .slice(0, BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD)
        .map((tab) => tab.id),
    );

    for (const tab of state.tabs) {
      if (tab.id === activeTabId) {
        this.clearTabSuspendTimer(threadId, tab.id);
        continue;
      }

      const runtime = this.runtimes.get(buildRuntimeKey(threadId, tab.id));
      if (runtime) {
        if (warmRuntimeTabIds.has(tab.id)) {
          this.scheduleInactiveTabSuspend(threadId, tab.id);
          continue;
        }

        this.perfCounters.inactiveTabBudgetEvictions += 1;
        this.destroyRuntime(threadId, tab.id);
        didChange = suspendTabState(tab) || didChange;
        continue;
      }

      didChange = suspendTabState(tab) || didChange;
    }

    return didChange;
  }

  private scheduleThreadSuspend(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state?.open || this.activeThreadId === threadId) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const timer = setTimeout(() => {
      this.suspendThread(threadId);
      this.suspendTimers.delete(threadId);
    }, BROWSER_THREAD_SUSPEND_DELAY_MS);
    timer.unref();
    this.suspendTimers.set(threadId, timer);
  }

  private suspendThread(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state || this.activeThreadId === threadId) {
      return;
    }

    let didChange = false;
    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
      didChange = suspendTabState(tab) || didChange;
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private clearSuspendTimer(threadId: ThreadId): void {
    const existing = this.suspendTimers.get(threadId);
    if (!existing) {
      return;
    }
    clearTimeout(existing);
    this.suspendTimers.delete(threadId);
  }

  private scheduleInactiveTabSuspend(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    if (this.tabSuspendTimers.has(key)) {
      return;
    }

    this.perfCounters.inactiveTabSuspendScheduled += 1;
    const delayMs = this.resolveInactiveTabSuspendDelay(threadId);
    const timer = setTimeout(() => {
      this.tabSuspendTimers.delete(key);
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      this.destroyRuntime(threadId, tabId);
      const didChange = suspendTabState(tab) || syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
    }, delayMs);
    timer.unref();
    this.tabSuspendTimers.set(key, timer);
  }

  private clearTabSuspendTimer(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.tabSuspendTimers.get(key);
    if (!existing) {
      return;
    }

    clearTimeout(existing);
    this.tabSuspendTimers.delete(key);
    this.perfCounters.inactiveTabSuspendCancelled += 1;
  }

  private attachActiveTab(
    threadId: ThreadId,
    bounds: BrowserPanelBounds,
    options: { forceLoad?: boolean } = {},
  ): void {
    const state = this.ensureWorkspace(threadId);
    const activeTab = this.getActiveTab(state);
    if (!activeTab) {
      return;
    }

    this.suspendInactiveTabs(threadId, activeTab.id);
    const wasSuspended = activeTab.status === SUSPENDED_TAB_STATUS;
    if (wasSuspended && activeTab.localFilePath && options.forceLoad !== true) {
      return;
    }
    const runtime = this.ensureLiveRuntime(threadId, activeTab.id);
    this.attachRuntime(runtime, bounds);
    if (options.forceLoad || wasSuspended) {
      void this.loadTab(threadId, activeTab.id, {
        force: options.forceLoad || wasSuspended,
        runtime,
      });
    } else {
      this.syncRuntimeState(threadId, activeTab.id);
    }
  }

  private attachRuntime(runtime: LiveTabRuntime, bounds: BrowserPanelBounds): void {
    const window = this.window;
    if (!window) {
      return;
    }

    const nextBoundsSignature = browserBoundsSignature(bounds);
    this.runtimeLastActiveAtByKey.set(runtime.key, Date.now());
    // Renderer-owned <webview> runtimes are already visible in React; keep any
    // old native view detached so it cannot cover the real browser surface.
    if (!runtime.ownsWebContents) {
      if (this.attachedRuntimeKey && this.attachedRuntimeKey !== runtime.key) {
        this.detachAttachedRuntime();
      }
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }
    if (!runtime.view) {
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }
    if (this.attachedRuntimeKey === runtime.key) {
      this.setRuntimeViewHidden(runtime, false);
      this.bringRuntimeViewToFront(runtime);
      if (this.attachedBoundsSignature === nextBoundsSignature) {
        return;
      }
      runtime.view.setBounds(bounds);
      this.attachedBoundsSignature = nextBoundsSignature;
      this.updatePopupWindowsForThread(runtime.threadId);
      return;
    }

    this.detachAttachedRuntime();
    this.setRuntimeViewHidden(runtime, false);
    this.bringRuntimeViewToFront(runtime);
    runtime.view.setBounds(bounds);
    this.attachedRuntimeKey = runtime.key;
    this.attachedBoundsSignature = nextBoundsSignature;
    this.updatePopupWindowsForThread(runtime.threadId);
  }

  private bringRuntimeViewToFront(runtime: LiveTabRuntime): void {
    const window = this.window;
    if (!window || !runtime.view) {
      return;
    }

    try {
      window.contentView.removeChildView(runtime.view);
    } catch {
      // Electron throws when the view is not attached yet; adding it below is the desired state.
    }
    window.contentView.addChildView(runtime.view);
  }

  private detachAttachedRuntime(): void {
    if (!this.window || !this.attachedRuntimeKey) {
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
      return;
    }

    const runtime = this.runtimes.get(this.attachedRuntimeKey);
    if (runtime?.view) {
      this.setRuntimeViewHidden(runtime, true);
      this.window.contentView.removeChildView(runtime.view);
    }
    this.attachedRuntimeKey = null;
    this.attachedBoundsSignature = null;
  }

  private setRuntimeViewHidden(runtime: LiveTabRuntime, hidden: boolean): void {
    if (!runtime.view) {
      return;
    }
    const nativeView = runtime.view as typeof runtime.view & NativeBrowserViewVisibility;
    nativeView.setVisible?.(!hidden);
    if (hidden) {
      runtime.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  private ensureLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) {
      if (existing.webContents.isDestroyed()) {
        this.destroyRuntime(threadId, tabId);
      } else {
        return existing;
      }
    }

    const runtime = this.createLiveRuntime(threadId, tabId);
    this.runtimes.set(key, runtime);
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (tab) {
      const didChange = tab.status !== "live" || tab.lastError !== null;
      tab.status = "live";
      tab.lastError = null;
      syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
      }
    }
    return runtime;
  }

  private createLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const tab = this.getTab(this.ensureWorkspace(threadId), tabId);
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const runtime: LiveTabRuntime = {
      key: buildRuntimeKey(threadId, tabId),
      threadId,
      tabId,
      webContents: view.webContents,
      view,
      ownsWebContents: true,
      listenerDisposers: [],
    };
    const initialBlankReady = tab?.localFilePath
      ? view.webContents.loadURL(ABOUT_BLANK_URL)
      : undefined;
    this.configureRuntimeWebContents(runtime);
    if (tab) {
      this.prepareLocalPreviewRuntimeGuard(runtime, tab, initialBlankReady);
    }
    return runtime;
  }

  private prepareLocalPreviewRuntimeGuard(
    runtime: LiveTabRuntime,
    tab: BrowserTabState,
    initialBlankReady?: Promise<void>,
  ): void {
    if (!tab.localFilePath || runtime.localPreviewGuardReady) {
      return;
    }

    runtime.localPreviewGuardInstalled = false;
    runtime.localPreviewGuardReady = (async () => {
      if (initialBlankReady) {
        await initialBlankReady;
      }
      const { webContents } = runtime;
      if (webContents.isDestroyed()) {
        throw new Error("The local preview web contents closed before security setup.");
      }

      const runtimeDebugger = webContents.debugger;
      if (runtimeDebugger.isAttached()) {
        throw new Error("A debugger was already attached to the local preview.");
      }
      runtimeDebugger.attach("1.3");
      const handleDebuggerDetach = (_event: Electron.Event, reason: string) => {
        runtime.localPreviewGuardInstalled = false;
        if (this.runtimes.get(runtime.key) !== runtime) {
          return;
        }
        this.failClosedLocalPreviewRuntime(
          runtime,
          `The local preview security guard stopped (${reason || "unknown reason"}). Refresh to try again.`,
        );
      };
      runtimeDebugger.on("detach", handleDebuggerDetach);
      runtime.listenerDisposers.push(() => {
        runtimeDebugger.removeListener("detach", handleDebuggerDetach);
      });
      await runtimeDebugger.sendCommand("Page.enable");
      const registration = (await runtimeDebugger.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source: localPreviewRuntimeGuard.source,
          runImmediately: true,
        },
      )) as { identifier?: unknown };
      if (typeof registration.identifier !== "string" || registration.identifier.length === 0) {
        throw new Error("Chromium did not register the local preview security guard.");
      }

      const verification = (await runtimeDebugger.sendCommand("Runtime.evaluate", {
        expression: LOCAL_PREVIEW_GUARD_VERIFICATION_EXPRESSION,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const values = verification.result?.value;
      if (
        !Array.isArray(values) ||
        values.length !== 3 ||
        values.some((value) => value !== "undefined")
      ) {
        throw new Error("Chromium did not activate the local preview security guard.");
      }
      runtime.localPreviewGuardInstalled = true;
    })();
  }

  private failClosedLocalPreviewRuntime(runtime: LiveTabRuntime, message: string): void {
    if (this.runtimes.get(runtime.key) !== runtime) {
      return;
    }

    runtime.localPreviewGuardInstalled = false;
    const { threadId, tabId, webContents } = runtime;
    try {
      webContents.stop();
    } catch {
      // Continue with forced teardown.
    }
    this.destroyRuntime(threadId, tabId);
    if (!webContents.isDestroyed()) {
      try {
        webContents.close({ waitForBeforeUnload: false });
      } catch {
        // The manager references and listeners are already gone.
      }
    }

    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    if (!state || !tab) {
      return;
    }
    tab.status = SUSPENDED_TAB_STATUS;
    tab.isLoading = false;
    tab.lastError = message;
    syncThreadLastError(state);
    this.markThreadStateChanged(threadId);
    this.emitState(threadId);
  }

  private configureRuntimeWebContents(runtime: LiveTabRuntime): void {
    const { threadId, tabId, webContents } = runtime;

    // Belt-and-suspenders alongside the session-level UA: also covers an adopted renderer
    // <webview> for any navigation after it attaches.
    this.sessionPolicy.applyUserAgent(webContents);
    adoptAttachedBrowserWebContentsSecurity(webContents, () => {
      this.registerPageNavigationGuards(
        webContents,
        (url) => url === ABOUT_BLANK_URL || this.isRuntimePageNavigationAllowed(runtime, url),
        () => {
          webContents.stop();
          void this.loadTab(threadId, tabId, { force: true, runtime });
        },
        runtime.listenerDisposers,
      );

      const windowOpenContext = this.popupContextForTab(threadId, tabId);
      if (windowOpenContext) {
        this.configureWindowOpenHandling(
          webContents,
          windowOpenContext,
          runtime.listenerDisposers,
          {
            isUrlAllowed: (url) => this.isRuntimePageNavigationAllowed(runtime, url),
            resolveContext: () => this.popupContextForTab(threadId, tabId),
          },
        );
      } else {
        webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      }
    });

    // The native page owns keyboard focus while browsing, so the renderer never sees the
    // copy-link chord. Intercept it here, copy the live URL, and let the shell toast.
    const beforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown") {
        return;
      }
      const matches = isBrowserCopyLinkChord(
        {
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
          key: input.key,
        },
        process.platform === "darwin",
      );
      if (!matches) {
        return;
      }
      event.preventDefault();
      this.copyTabLink(threadId, tabId);
    };
    webContents.on("before-input-event", beforeInputEvent);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-input-event", beforeInputEvent);
    });

    const pageTitleUpdated = (event: Electron.Event) => {
      event.preventDefault();
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("page-title-updated", pageTitleUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-title-updated", pageTitleUpdated);
    });

    const pageFaviconUpdated = (_event: Electron.Event, faviconUrls: string[]) => {
      const tab = this.tabForNavigationContext({ threadId, tabId });
      const currentUrl = webContents.getURL();
      const canUsePageFavicon =
        tab !== null &&
        !tab.localFilePath &&
        currentUrl.length > 0 &&
        isPageNavigationAllowed(tab, currentUrl);
      this.queueRuntimeStateSync(threadId, tabId, canUsePageFavicon ? faviconUrls : []);
    };
    webContents.on("page-favicon-updated", pageFaviconUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-favicon-updated", pageFaviconUpdated);
    });

    const didStartLoading = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-start-loading", didStartLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-start-loading", didStartLoading);
    });

    const didStopLoading = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-stop-loading", didStopLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-stop-loading", didStopLoading);
    });

    const didNavigate = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-navigate", didNavigate);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate", didNavigate);
    });

    const didNavigateInPage = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-navigate-in-page", didNavigateInPage);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate-in-page", didNavigateInPage);
    });

    const didFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      _errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || errorCode === BROWSER_ERROR_ABORTED) {
        return;
      }

      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      tab.url = validatedURL && isPageNavigationAllowed(tab, validatedURL) ? validatedURL : tab.url;
      tab.title = defaultTitleForUrl(tab.url, tab.localFilePath ?? null);
      tab.isLoading = false;
      tab.lastError = mapBrowserLoadError(errorCode);
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    };
    webContents.on("did-fail-load", didFailLoad);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-fail-load", didFailLoad);
    });

    const renderProcessGone = () => {
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      this.destroyRuntime(threadId, tabId);
      if (state && tab) {
        tab.status = "suspended";
        tab.isLoading = false;
        tab.lastError = "This tab stopped unexpectedly.";
        syncThreadLastError(state);
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
      const bounds = this.getVisibleBoundsForThread(threadId);
      if (this.activeThreadId === threadId && bounds) {
        this.attachActiveTab(threadId, bounds);
      }
    };
    webContents.on("render-process-gone", renderProcessGone);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("render-process-gone", renderProcessGone);
    });
  }

  private async loadTab(
    threadId: ThreadId,
    tabId: string,
    options: { clearHistory?: boolean; force?: boolean; runtime?: LiveTabRuntime } = {},
  ): Promise<void> {
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (!tab) {
      return;
    }

    const runtime = options.runtime ?? this.ensureLiveRuntime(threadId, tabId);
    const webContents = runtime.webContents;
    if (tab.localFilePath) {
      this.prepareLocalPreviewRuntimeGuard(runtime, tab);
      try {
        await runtime.localPreviewGuardReady;
      } catch {
        if (this.runtimes.get(runtime.key) === runtime && tab.localFilePath) {
          this.failClosedLocalPreviewRuntime(runtime, LOCAL_PREVIEW_GUARD_ERROR);
        }
        return;
      }
      if (
        this.runtimes.get(runtime.key) !== runtime ||
        webContents.isDestroyed() ||
        !tab.localFilePath
      ) {
        return;
      }
    }
    const navigation = resolveManagedBrowserNavigation({
      url: options.force === true ? tab.url : (tab.lastCommittedUrl ?? tab.url),
      ...(tab.localFilePath ? { localFilePath: tab.localFilePath } : {}),
    });
    const nextUrl = navigation.url;
    const currentUrl = webContents.getURL();
    const shouldLoad = options.force === true || currentUrl !== nextUrl || currentUrl.length === 0;

    if (!shouldLoad) {
      this.queueRuntimeStateSync(threadId, tabId);
      return;
    }

    if (options.clearHistory) {
      webContents.stop();
      clearBrowserNavigationHistory(webContents);
    }
    tab.localFilePath = navigation.localFilePath;
    tab.url = nextUrl;
    tab.status = "live";
    tab.isLoading = true;
    tab.lastError = null;
    syncThreadLastError(state);
    this.markThreadStateChanged(threadId);
    this.emitState(threadId);

    try {
      await webContents.loadURL(nextUrl);
      if (options.clearHistory) {
        clearBrowserNavigationHistory(webContents);
      }
      this.queueRuntimeStateSync(threadId, tabId);
    } catch (error) {
      if (isAbortedNavigationError(error)) {
        this.queueRuntimeStateSync(threadId, tabId);
        return;
      }

      tab.isLoading = false;
      tab.lastError = "Couldn't open this page.";
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private syncRuntimeState(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    this.perfCounters.syncRuntimeStateCalls += 1;
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!state || !tab || !runtime) {
      return;
    }

    const didChange = syncTabStateFromRuntime(state, tab, runtime.webContents, faviconUrls);
    const nextDidChange = syncThreadLastError(state) || didChange;
    if (nextDidChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private queueRuntimeStateSync(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.pendingRuntimeSyncs.get(key);
    const nextPendingSync: PendingRuntimeSync = {
      threadId,
      tabId,
    };
    const nextFaviconUrls = faviconUrls ?? existing?.faviconUrls;
    if (nextFaviconUrls !== undefined) {
      nextPendingSync.faviconUrls = nextFaviconUrls;
    }
    this.pendingRuntimeSyncs.set(key, nextPendingSync);

    if (this.runtimeSyncFlushScheduled) {
      return;
    }

    this.runtimeSyncFlushScheduled = true;
    queueMicrotask(() => {
      this.runtimeSyncFlushScheduled = false;
      if (this.pendingRuntimeSyncs.size === 0) {
        return;
      }

      this.perfCounters.runtimeSyncQueueFlushes += 1;
      const pendingSyncs = [...this.pendingRuntimeSyncs.values()];
      this.pendingRuntimeSyncs.clear();
      for (const pendingSync of pendingSyncs) {
        this.syncRuntimeState(pendingSync.threadId, pendingSync.tabId, pendingSync.faviconUrls);
      }
    });
  }

  private destroyThreadRuntimes(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state) {
      return;
    }

    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
    }
  }

  private destroyAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      this.destroyRuntime(runtime.threadId, runtime.tabId);
    }
  }

  private destroyRuntime(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    this.pendingRuntimeSyncs.delete(key);
    this.runtimeLastActiveAtByKey.delete(key);
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      return;
    }

    if (this.attachedRuntimeKey === key) {
      this.detachAttachedRuntime();
    }

    this.runtimes.delete(key);
    const webContents = runtime.webContents;
    runtime.localPreviewGuardInstalled = false;
    for (const disposeListener of runtime.listenerDisposers.splice(0)) {
      disposeListener();
    }
    if (!webContents.isDestroyed()) {
      if (webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach();
        } catch {
          // The runtime is being torn down anyway; ignore stale-debugger cleanup noise.
        }
      }
      if (runtime.ownsWebContents) {
        webContents.close({ waitForBeforeUnload: false });
      }
    }
  }

  private findRendererRuntimeByWebContentsId(webContentsId: number): LiveTabRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.ownsWebContents && runtime.webContents.id === webContentsId) {
        return runtime;
      }
    }
    return null;
  }

  private getOrCreateState(threadId: ThreadId): ThreadBrowserState {
    const existing = this.states.get(threadId);
    if (existing) {
      return existing;
    }

    const initial = defaultThreadBrowserState(threadId);
    this.states.set(threadId, initial);
    this.threadVersionById.set(threadId, 0);
    return initial;
  }

  private markThreadStateChanged(threadId: ThreadId): void {
    const nextVersion = (this.threadVersionById.get(threadId) ?? 0) + 1;
    this.threadVersionById.set(threadId, nextVersion);
    const state = this.states.get(threadId);
    if (state) {
      state.version = nextVersion;
    }
  }

  private snapshotThreadState(
    threadId: ThreadId,
    state = this.getOrCreateState(threadId),
  ): ThreadBrowserState {
    const version = state.version;
    const cached = this.snapshotCacheByThreadId.get(threadId);
    if (cached && cached.version === version) {
      return cached.snapshot;
    }

    const snapshot = cloneThreadState(state);
    this.perfCounters.stateCloneCount += 1;
    this.snapshotCacheByThreadId.set(threadId, {
      version,
      snapshot,
    });
    return snapshot;
  }

  private getTrackedProcessIds(): number[] {
    const processIds = new Set<number>();
    for (const runtime of this.runtimes.values()) {
      const webContents = runtime.webContents;
      if (webContents.isDestroyed()) {
        continue;
      }
      processIds.add(webContents.getProcessId());
    }
    return [...processIds];
  }

  private countWarmInactiveRuntimes(): number {
    let count = 0;
    for (const [key] of this.tabSuspendTimers) {
      if (this.runtimes.has(key)) {
        count += 1;
      }
    }
    return count;
  }

  private resolveInactiveTabSuspendDelay(threadId: ThreadId): number {
    const threadRuntimeCount = [...this.runtimes.values()].filter(
      (runtime) => runtime.threadId === threadId,
    ).length;
    if (
      threadRuntimeCount > BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD + 1 ||
      this.runtimes.size > 4
    ) {
      return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS;
    }

    return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS;
  }

  private ensureWorkspace(
    threadId: ThreadId,
    initialNavigation?: ManagedBrowserNavigationTarget | null,
  ): ThreadBrowserState {
    this.sessionPolicy.ensureConfigured();
    const state = this.getOrCreateState(threadId);
    if (state.tabs.length === 0) {
      const initialTab = createBrowserTab(initialNavigation ?? BLANK_BROWSER_NAVIGATION);
      state.tabs = [initialTab];
      state.activeTabId = initialTab.id;
    }

    if (!state.activeTabId || !state.tabs.some((tab) => tab.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0]?.id ?? null;
    }

    return state;
  }

  private resolveTab(state: ThreadBrowserState, tabId?: string): BrowserTabState {
    const resolvedTabId = tabId ?? state.activeTabId;
    const existing =
      (resolvedTabId ? state.tabs.find((tab) => tab.id === resolvedTabId) : undefined) ??
      state.tabs[0];
    if (existing) {
      return existing;
    }

    const fallback = createBrowserTab();
    state.tabs = [fallback];
    state.activeTabId = fallback.id;
    return fallback;
  }

  private activateTab(threadId: ThreadId, state: ThreadBrowserState, tab: BrowserTabState): void {
    if (state.activeTabId === tab.id) {
      return;
    }

    state.activeTabId = tab.id;
    syncThreadLastError(state);
    this.markThreadStateChanged(threadId);
    this.emitState(threadId);
  }

  private getActiveTab(state: ThreadBrowserState): BrowserTabState | null {
    if (!state.activeTabId) {
      return state.tabs[0] ?? null;
    }
    return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
  }

  private getTab(state: ThreadBrowserState, tabId: string): BrowserTabState | null {
    return state.tabs.find((tab) => tab.id === tabId) ?? null;
  }

  // Resolves the most accurate URL for a tab, preferring the live page over cached state and
  // ignoring blank placeholders so the copy-link chord never yields "about:blank".
  private resolveCopyableTabUrl(
    threadId: ThreadId,
    tabId: string,
    runtime: LiveTabRuntime | undefined,
  ): string | null {
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    if (!tab) {
      return null;
    }
    const storedUrl = tab.lastCommittedUrl ?? tab.url;
    if (!isPageNavigationAllowed(tab, storedUrl)) {
      return null;
    }
    const runtimeUrl =
      runtime && !runtime.webContents.isDestroyed() ? runtime.webContents.getURL() : null;
    const liveUrl = runtimeUrl && isPageNavigationAllowed(tab, runtimeUrl) ? runtimeUrl : null;
    return resolveCopyableBrowserTabUrl(tab, liveUrl);
  }

  private destroyRuntimeForSecurityTransition(
    threadId: ThreadId,
    tabId: string,
  ): "native" | "renderer" | null {
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!runtime) {
      return null;
    }

    // Lock and close the old document synchronously before mutating the tab's
    // desired security identity. This prevents its timers/unload handlers from
    // being evaluated using the destination page's broader navigation policy.
    const { webContents } = runtime;
    if (!webContents.isDestroyed()) {
      try {
        webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      } catch {
        // A renderer that is already exiting is still torn down below.
      }
      try {
        webContents.stop();
      } catch {
        // Continue with forced close.
      }
      try {
        webContents.close({ waitForBeforeUnload: false });
      } catch {
        // destroyRuntime still removes every listener and manager reference.
      }
    }

    const ownership = runtime.ownsWebContents ? "native" : "renderer";
    this.destroyRuntime(threadId, tabId);
    return ownership;
  }

  private closeUnmanagedRendererWebContents(webContents: WebContents): void {
    if (webContents.isDestroyed()) {
      return;
    }
    try {
      webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    } catch {
      // The untrusted guest is still stopped and closed below.
    }
    try {
      webContents.stop();
    } catch {
      // Continue with forced close.
    }
    try {
      webContents.close({ waitForBeforeUnload: false });
    } catch {
      // No manager references or listeners were installed for this guest.
    }
  }

  private copyTabLink(threadId: ThreadId, tabId: string): void {
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    const url = this.resolveCopyableTabUrl(threadId, tabId, runtime);
    if (!url) {
      return;
    }
    clipboard.writeText(url);
    const event: BrowserCopyLinkEvent = { threadId, url };
    for (const listener of this.copyLinkListeners) {
      listener(event);
    }
  }

  private emitState(threadId: ThreadId): void {
    this.perfCounters.stateEmitCalls += 1;
    const state = this.getOrCreateState(threadId);
    const nextVersion = state.version;
    if (this.lastEmittedVersionByThreadId.get(threadId) === nextVersion) {
      this.perfCounters.stateEmitSkips += 1;
      return;
    }
    this.lastEmittedVersionByThreadId.set(threadId, nextVersion);
    const snapshot = this.snapshotThreadState(threadId, state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function setIfChanged<T>(current: T, next: T, apply: (value: T) => void): boolean {
  if (Object.is(current, next)) {
    return false;
  }
  apply(next);
  return true;
}

function suspendTabState(tab: BrowserTabState): boolean {
  let didChange = false;
  didChange =
    setIfChanged(tab.status, SUSPENDED_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, false, (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, false, (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, false, (value) => {
      tab.canGoForward = value;
    }) || didChange;
  return didChange;
}

function syncTabStateFromRuntime(
  state: ThreadBrowserState,
  tab: BrowserTabState,
  webContents: WebContents,
  faviconUrls?: string[],
): boolean {
  const currentUrl = webContents.getURL();
  const acceptedCurrentUrl =
    currentUrl && isPageNavigationAllowed(tab, currentUrl) ? currentUrl : "";
  const nextUrl = acceptedCurrentUrl || tab.url;
  const nextTitle = webContents.getTitle();
  let didChange = false;
  didChange =
    setIfChanged(tab.status, LIVE_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.url, nextUrl, (value) => {
      tab.url = value;
    }) || didChange;
  const resolvedTitle = tab.localFilePath
    ? defaultTitleForUrl(nextUrl, tab.localFilePath)
    : !nextTitle || nextTitle === ABOUT_BLANK_URL
      ? defaultTitleForUrl(nextUrl)
      : nextTitle;
  didChange =
    setIfChanged(tab.title, resolvedTitle, (value) => {
      tab.title = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, webContents.isLoading(), (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, canNavigateBrowserHistory(webContents, tab, -1), (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, canNavigateBrowserHistory(webContents, tab, 1), (value) => {
      tab.canGoForward = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.lastCommittedUrl, acceptedCurrentUrl || tab.lastCommittedUrl, (value) => {
      tab.lastCommittedUrl = value;
    }) || didChange;
  if (tab.localFilePath) {
    didChange =
      setIfChanged(tab.faviconUrl, null, (value) => {
        tab.faviconUrl = value;
      }) || didChange;
  } else if (faviconUrls) {
    didChange =
      setIfChanged(tab.faviconUrl, faviconUrls[0] ?? tab.faviconUrl, (value) => {
        tab.faviconUrl = value;
      }) || didChange;
  }
  if (tab.lastError && !tab.isLoading) {
    tab.lastError = null;
    didChange = true;
  }
  didChange = syncThreadLastError(state) || didChange;
  return didChange;
}

function syncThreadLastError(state: ThreadBrowserState): boolean {
  const activeTab =
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  const nextLastError = activeTab?.lastError ?? null;
  if (state.lastError === nextLastError) {
    return false;
  }
  state.lastError = nextLastError;
  return true;
}
