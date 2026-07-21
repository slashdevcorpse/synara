// FILE: BrowserPanel.logic.ts
// Purpose: Holds the address-bar sync rules and suggestions for the in-app browser panel.
// Layer: Component logic helper
// Exports: browserAddressDisplayValue, normalizeBrowserAddressInput, buildBrowserAddressSuggestions
// Depends on: shared browser URL rules, browser tab metadata, and thread-local browser history

import {
  BROWSER_BLANK_URL,
  BROWSER_SEARCH_URL_PREFIX,
  classifyBrowserInput,
  normalizeBrowserUrlInput,
} from "@synara/shared/browserSession";
import type { BrowserTabState } from "@synara/contracts";
import type { BrowserHistoryEntry } from "../browserStateStore";

const BROWSER_SUGGESTION_LIMIT = 6;

interface ResolveBrowserAddressSyncInput {
  activeTabId: string | null;
  previousActiveTabId: string | null;
  savedDraft: string | undefined;
  nextDisplayValue: string;
  lastSyncedValue: string | undefined;
  isEditing: boolean;
}

type BrowserAddressSyncDecision =
  | {
      type: "keep";
    }
  | {
      type: "replace";
      value: string;
      syncedValue: string | undefined;
    };

export interface BrowserAddressSuggestion {
  id: string;
  kind: "navigate" | "tab" | "history";
  title: string;
  detail: string;
  url: string;
  tabId?: string;
  faviconUrl?: string | null;
}

interface BuildBrowserAddressSuggestionsInput {
  query: string;
  activeTabId: string | null;
  tabs: Array<
    Pick<
      BrowserTabState,
      "id" | "title" | "url" | "faviconUrl" | "lastCommittedUrl" | "localFilePath"
    >
  >;
  recentHistory: BrowserHistoryEntry[];
}

export interface BrowserChromeStatus {
  tone: "default" | "error";
  label: string;
}

export type BrowserAddressResolution =
  | { kind: "navigate"; url: string }
  | { kind: "local-file"; path: string }
  | { kind: "error"; message: string };

export function resolveBrowserAddressInput(input: string): BrowserAddressResolution {
  const classification = classifyBrowserInput(input);
  if (classification.kind === "local-file") {
    return { kind: "local-file", path: classification.path };
  }
  if (classification.kind === "rejected-local") {
    const message =
      classification.reason === "network-file-url" || classification.reason === "network-path"
        ? "Network file paths are not supported. Choose an HTML file inside this workspace."
        : classification.reason === "nul-byte"
          ? "The local file path contains an invalid null byte."
          : "Enter a valid absolute path to an HTML file inside this workspace.";
    return { kind: "error", message };
  }
  return { kind: "navigate", url: classification.url };
}

// Hides about:blank from the address bar so new tabs behave like real browsers.
export function browserAddressDisplayValue(
  tab: Pick<BrowserTabState, "url" | "localFilePath"> | null | undefined,
): string {
  if (tab?.localFilePath) {
    return tab.localFilePath;
  }
  const nextUrl = tab?.url?.trim() ?? "";
  return nextUrl === BROWSER_BLANK_URL ? "" : nextUrl;
}

export function browserWebviewSecurityIdentity(
  tab: Pick<BrowserTabState, "id" | "securityEpoch">,
): string {
  return `${tab.id}:${tab.securityEpoch ?? 0}`;
}

export function browserNavigationRetryDelay(attempt: number): number | null {
  return Number.isInteger(attempt) && attempt >= 1 && attempt < 3 ? attempt * 250 : null;
}

// Component-facing alias for the shared desktop/web browser URL normalizer.
export const normalizeBrowserAddressInput = normalizeBrowserUrlInput;

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function displaySuggestionUrl(value: string): string {
  return value.trim().replace(/^about:blank$/i, "");
}

function suggestionMatches(query: string, candidate: string): boolean {
  if (query.length === 0) {
    return true;
  }
  return normalizeQuery(candidate).includes(query);
}

function pushSuggestion(
  suggestions: BrowserAddressSuggestion[],
  seenUrls: Set<string>,
  suggestion: BrowserAddressSuggestion,
): void {
  if (suggestions.length >= BROWSER_SUGGESTION_LIMIT || seenUrls.has(suggestion.url)) {
    return;
  }

  seenUrls.add(suggestion.url);
  suggestions.push(suggestion);
}

// Builds browser-like suggestions from the typed query, open tabs, and recent history.
export function buildBrowserAddressSuggestions(
  input: BuildBrowserAddressSuggestionsInput,
): BrowserAddressSuggestion[] {
  const query = normalizeQuery(input.query);
  const suggestions: BrowserAddressSuggestion[] = [];
  const seenUrls = new Set<string>();
  const directResolution = resolveBrowserAddressInput(input.query);

  if (query.length > 0 && directResolution.kind !== "error") {
    const directTarget =
      directResolution.kind === "local-file" ? directResolution.path : directResolution.url;
    const directTitle = directTarget.startsWith(BROWSER_SEARCH_URL_PREFIX)
      ? `Search the web for "${input.query.trim()}"`
      : directResolution.kind === "local-file"
        ? `Open local file ${directResolution.path}`
        : `Open ${directTarget}`;
    pushSuggestion(suggestions, seenUrls, {
      id: `direct:${directTarget}`,
      kind: "navigate",
      title: directTitle,
      detail: directTarget,
      url: directTarget,
    });
  }

  for (const tab of input.tabs) {
    const tabUrl = tab.localFilePath ?? displaySuggestionUrl(tab.lastCommittedUrl ?? tab.url);
    if (tabUrl.length === 0 || tab.id === input.activeTabId) {
      continue;
    }
    if (!suggestionMatches(query, `${tab.title} ${tabUrl}`)) {
      continue;
    }
    pushSuggestion(suggestions, seenUrls, {
      id: `tab:${tab.id}`,
      kind: "tab",
      title: tab.title || tabUrl,
      detail: tabUrl,
      url: tabUrl,
      tabId: tab.id,
      faviconUrl: tab.faviconUrl,
    });
  }

  for (const entry of input.recentHistory) {
    const entryUrl = displaySuggestionUrl(entry.url);
    if (entryUrl.length === 0) {
      continue;
    }
    if (!suggestionMatches(query, `${entry.title} ${entryUrl}`)) {
      continue;
    }
    pushSuggestion(suggestions, seenUrls, {
      id: `history:${entry.url}`,
      kind: "history",
      title: entry.title || entryUrl,
      detail: entryUrl,
      url: entryUrl,
    });
  }

  return suggestions.slice(0, BROWSER_SUGGESTION_LIMIT);
}

// Only shows transient browser state; the address field already reflects the active URL.
export function resolveBrowserChromeStatus(input: {
  localError: string | null;
  threadLastError: string | null | undefined;
  activeTabStatus: string;
  hasActiveTab: boolean;
  workspaceReady: boolean;
}): BrowserChromeStatus | null {
  if (input.localError) {
    return {
      tone: "error",
      label: input.localError,
    };
  }

  if (input.threadLastError) {
    return {
      tone: "error",
      label: input.threadLastError,
    };
  }

  if (!input.hasActiveTab) {
    return {
      tone: "default",
      label: input.workspaceReady ? "No tabs open" : "Starting browser...",
    };
  }

  if (input.activeTabStatus === "suspended") {
    return {
      tone: "default",
      label: "Restoring tab...",
    };
  }

  return null;
}

// Decides when browser state should replace the visible address input.
export function resolveBrowserAddressSync(
  input: ResolveBrowserAddressSyncInput,
): BrowserAddressSyncDecision {
  if (!input.activeTabId) {
    return {
      type: "replace",
      value: "",
      syncedValue: undefined,
    };
  }

  if (input.activeTabId !== input.previousActiveTabId) {
    if (input.savedDraft !== undefined) {
      return {
        type: "replace",
        value: input.savedDraft,
        syncedValue: input.lastSyncedValue,
      };
    }

    return {
      type: "replace",
      value: input.nextDisplayValue,
      syncedValue: input.nextDisplayValue,
    };
  }

  if (input.isEditing || input.lastSyncedValue === input.nextDisplayValue) {
    return { type: "keep" };
  }

  return {
    type: "replace",
    value: input.nextDisplayValue,
    syncedValue: input.nextDisplayValue,
  };
}
