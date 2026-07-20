// FILE: terminalContextMenu.browser.tsx
// Purpose: Native Chromium proof for terminal right-click clipboard behavior.
// Layer: Terminal browser integration tests

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeEntry, disposeRuntimeEntry, syncRuntimeConfig } from "./terminalRuntime";
import type { TerminalRuntimeConfig, TerminalRuntimeEntry } from "./terminalRuntimeTypes";

const entries = new Set<TerminalRuntimeEntry>();

function runtimeConfig(terminalRightClickToPaste: boolean): TerminalRuntimeConfig {
  return {
    runtimeKey: "thread::default",
    threadId: "thread",
    terminalId: "default",
    terminalLabel: "Terminal",
    cwd: "C:\\project",
    terminalRightClickToPaste,
    callbacks: {
      onSessionExited: () => undefined,
      onTerminalMetadataChange: () => undefined,
      onTerminalActivityChange: () => undefined,
    },
  };
}

function createEntry(enabled: boolean): TerminalRuntimeEntry {
  const entry = createRuntimeEntry(runtimeConfig(enabled));
  entries.add(entry);
  return entry;
}

function dispatchContextMenu(entry: TerminalRuntimeEntry, ctrlKey = false): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    button: 2,
    cancelable: true,
    ctrlKey,
  });
  entry.wrapper.dispatchEvent(event);
  return event;
}

async function flushClipboardWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  for (const entry of entries) {
    disposeRuntimeEntry(entry);
  }
  entries.clear();
  vi.restoreAllMocks();
});

describe("terminal context-menu paste", () => {
  it("pastes clipboard text for an enabled bare right-click", async () => {
    const entry = createEntry(true);
    const parent = document.createElement("div");
    const parentContextMenu = vi.fn();
    parent.addEventListener("contextmenu", parentContextMenu);
    parent.append(entry.wrapper);
    const readText = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("pasted text");
    const focus = vi.spyOn(entry.terminal, "focus").mockImplementation(() => undefined);
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

    const event = dispatchContextMenu(entry);
    await flushClipboardWork();

    expect(event.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledWith("pasted text");
    expect(parentContextMenu).not.toHaveBeenCalled();
  });

  it("preserves native behavior while the setting is disabled", async () => {
    const entry = createEntry(false);
    const readText = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("ignored");
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

    const event = dispatchContextMenu(entry);
    await flushClipboardWork();

    expect(event.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
  });

  it("preserves the context menu for Ctrl+right-click", async () => {
    const entry = createEntry(true);
    const readText = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("ignored");
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

    const event = dispatchContextMenu(entry, true);
    await flushClipboardWork();

    expect(event.defaultPrevented).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
  });

  it("preserves native behavior when clipboard text reads are unavailable", async () => {
    const clipboard = navigator.clipboard as unknown as {
      readText?: () => Promise<string>;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(clipboard, "readText");
    Object.defineProperty(clipboard, "readText", {
      configurable: true,
      value: undefined,
    });

    try {
      const entry = createEntry(true);
      const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

      const event = dispatchContextMenu(entry);
      await flushClipboardWork();

      expect(event.defaultPrevented).toBe(false);
      expect(paste).not.toHaveBeenCalled();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(clipboard, "readText", originalDescriptor);
      } else {
        delete clipboard.readText;
      }
    }
  });

  it("applies a live false-to-true runtime config update", async () => {
    const entry = createEntry(false);
    const readText = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("live update");
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

    dispatchContextMenu(entry);
    syncRuntimeConfig(entry, runtimeConfig(true));
    const enabledEvent = dispatchContextMenu(entry);
    await flushClipboardWork();

    expect(enabledEvent.defaultPrevented).toBe(true);
    expect(readText).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledWith("live update");
  });

  it("swallows clipboard rejection without attempting a paste", async () => {
    const entry = createEntry(true);
    vi.spyOn(navigator.clipboard, "readText").mockRejectedValue(new Error("permission denied"));
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

    const event = dispatchContextMenu(entry);
    await flushClipboardWork();

    expect(event.defaultPrevented).toBe(true);
    expect(paste).not.toHaveBeenCalled();
  });

  it("swallows a synchronous clipboard failure without attempting a paste", async () => {
    const entry = createEntry(true);
    vi.spyOn(navigator.clipboard, "readText").mockImplementation(() => {
      throw new Error("clipboard unavailable");
    });
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);
    const escapedError = vi.fn((event: ErrorEvent) => event.preventDefault());
    window.addEventListener("error", escapedError);

    try {
      const event = dispatchContextMenu(entry);
      await flushClipboardWork();

      expect(event.defaultPrevented).toBe(true);
      expect(paste).not.toHaveBeenCalled();
      expect(escapedError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", escapedError);
    }
  });

  it("does not paste after the runtime is disposed during clipboard access", async () => {
    let resolveReadText: ((text: string) => void) | undefined;
    const entry = createEntry(true);
    vi.spyOn(navigator.clipboard, "readText").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveReadText = resolve;
        }),
    );
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

    dispatchContextMenu(entry);
    expect(resolveReadText).toBeTypeOf("function");
    disposeRuntimeEntry(entry);
    entries.delete(entry);
    resolveReadText?.("too late");
    await flushClipboardWork();

    expect(paste).not.toHaveBeenCalled();
  });

  it("does not paste when the setting is disabled during clipboard access", async () => {
    let resolveReadText: ((text: string) => void) | undefined;
    const entry = createEntry(true);
    vi.spyOn(navigator.clipboard, "readText").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveReadText = resolve;
        }),
    );
    const paste = vi.spyOn(entry.terminal, "paste").mockImplementation(() => undefined);

    dispatchContextMenu(entry);
    expect(resolveReadText).toBeTypeOf("function");
    syncRuntimeConfig(entry, runtimeConfig(false));
    resolveReadText?.("disabled before completion");
    await flushClipboardWork();

    expect(paste).not.toHaveBeenCalled();
  });
});
