import { describe, expect, it } from "vitest";

import {
  browserAddressDisplayValue,
  browserNavigationRetryDelay,
  browserWebviewSecurityIdentity,
  buildBrowserAddressSuggestions,
  normalizeBrowserAddressInput,
  resolveBrowserAddressInput,
  resolveBrowserChromeStatus,
  resolveBrowserAddressSync,
} from "./BrowserPanel.logic";

describe("browserWebviewSecurityIdentity", () => {
  it("changes across tabs and local-preview identity transitions", () => {
    expect(browserWebviewSecurityIdentity({ id: "tab-1" })).toBe("tab-1:0");
    expect(browserWebviewSecurityIdentity({ id: "tab-1", securityEpoch: 1 })).toBe("tab-1:1");
    expect(browserWebviewSecurityIdentity({ id: "tab-2", securityEpoch: 1 })).toBe("tab-2:1");
  });
});

describe("browserNavigationRetryDelay", () => {
  it("retries a one-shot navigation twice and then stops", () => {
    expect(browserNavigationRetryDelay(1)).toBe(250);
    expect(browserNavigationRetryDelay(2)).toBe(500);
    expect(browserNavigationRetryDelay(3)).toBeNull();
  });
});

describe("browserAddressDisplayValue", () => {
  it("hides about:blank for new tabs", () => {
    expect(browserAddressDisplayValue({ url: "about:blank" })).toBe("");
  });

  it("keeps real urls visible", () => {
    expect(browserAddressDisplayValue({ url: "https://x.com/" })).toBe("https://x.com/");
  });

  it("shows the canonical local path instead of a capability URL", () => {
    expect(
      browserAddressDisplayValue({
        url: "http://127.0.0.1:58090/api/local-preview/secret/docs/demo.html",
        localFilePath: "C:\\workspace\\docs\\demo.html",
      }),
    ).toBe("C:\\workspace\\docs\\demo.html");
  });
});

describe("resolveBrowserAddressInput", () => {
  it("keeps local Windows and file URL inputs out of search navigation", () => {
    expect(resolveBrowserAddressInput("C:\\workspace\\docs\\demo.html")).toEqual({
      kind: "local-file",
      path: "C:\\workspace\\docs\\demo.html",
    });
    expect(resolveBrowserAddressInput("file:///C:/workspace/docs/demo.html")).toEqual({
      kind: "local-file",
      path: "C:/workspace/docs/demo.html",
    });
  });

  it("returns a visible denial for network paths", () => {
    expect(resolveBrowserAddressInput("\\\\server\\share\\demo.html")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Network file paths"),
    });
  });

  it("preserves ordinary navigation and search behavior", () => {
    expect(resolveBrowserAddressInput("example.com")).toEqual({
      kind: "navigate",
      url: "https://example.com/",
    });
    expect(resolveBrowserAddressInput("find local docs")).toMatchObject({
      kind: "navigate",
      url: expect.stringContaining("google.com/search"),
    });
  });
});

describe("resolveBrowserAddressSync", () => {
  it("restores a saved draft when switching to another tab", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-1",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "x.com",
      syncedValue: "",
    });
  });

  it("keeps the typed value while the active tab is still being edited", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: true,
      }),
    ).toEqual({
      type: "keep",
    });
  });

  it("updates the input when a submitted navigation resolves to a new url", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "https://x.com/",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "https://x.com/",
      syncedValue: "https://x.com/",
    });
  });
});

describe("normalizeBrowserAddressInput", () => {
  it("adds https to naked domains", () => {
    expect(normalizeBrowserAddressInput("phodex.app")).toBe("https://phodex.app/");
  });

  it("turns spaced text into a search url", () => {
    expect(normalizeBrowserAddressInput("how to bake bread")).toContain(
      "https://www.google.com/search?q=how%20to%20bake%20bread",
    );
  });
});

describe("buildBrowserAddressSuggestions", () => {
  it("hides blank tabs and surfaces direct navigation", () => {
    const suggestions = buildBrowserAddressSuggestions({
      query: "open",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "New tab",
          url: "about:blank",
          faviconUrl: null,
          lastCommittedUrl: null,
        },
        {
          id: "tab-2",
          title: "OpenAI",
          url: "https://openai.com/",
          faviconUrl: null,
          lastCommittedUrl: "https://openai.com/",
        },
      ],
      recentHistory: [
        {
          url: "about:blank",
          title: "Blank",
          tabId: "tab-1",
        },
        {
          url: "https://news.ycombinator.com/",
          title: "Hacker News",
          tabId: "tab-3",
        },
      ],
    });

    expect(suggestions[0]).toMatchObject({
      kind: "navigate",
      url: "https://www.google.com/search?q=open",
    });
    expect(suggestions.some((suggestion) => suggestion.url === "about:blank")).toBe(false);
    expect(suggestions.some((suggestion) => suggestion.url === "https://openai.com/")).toBe(true);
  });
});

describe("resolveBrowserChromeStatus", () => {
  it("surfaces recoverable browser errors ahead of idle state", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: "Couldn't complete that browser action.",
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toEqual({
      tone: "error",
      label: "Couldn't complete that browser action.",
    });
  });

  it("does not duplicate the current url when a page is loaded", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toBeNull();
  });

  it("keeps onboarding copy for empty browser states", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "suspended",
        hasActiveTab: false,
        workspaceReady: false,
      }),
    ).toEqual({
      tone: "default",
      label: "Starting browser...",
    });
  });
});
