// FILE: composerFileReferenceDrag.test.ts
// Purpose: Covers explorer drag payloads, composer claiming, busy rejection,
//          OS drop isolation, and cancelled-drag cleanup.
// Layer: Web composer drag utility tests

import { describe, expect, it } from "vitest";

import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "./chatReferences";
import {
  canAcceptComposerFileReferenceDrop,
  makeComposerFileReferenceDragHandlers,
  setComposerFileReferenceDragData,
  type ComposerFileReferenceDragEvent,
  type ComposerFileReferenceDropHost,
} from "./composerFileReferenceDrag";

function makeDragEvent(input?: { referenceText?: string; types?: ReadonlyArray<string> }) {
  const calls: string[] = [];
  const event: ComposerFileReferenceDragEvent = {
    dataTransfer: {
      types: input?.types ?? [CHAT_FILE_REFERENCE_DRAG_TYPE, "text/plain"],
      getData: (format) =>
        format === CHAT_FILE_REFERENCE_DRAG_TYPE
          ? (input?.referenceText ?? "@apps/web/src/main.tsx")
          : "",
      dropEffect: "none",
    },
    nativeEvent: {
      stopPropagation: () => calls.push("native-stop"),
    },
    preventDefault: () => calls.push("prevent-default"),
    stopPropagation: () => calls.push("synthetic-stop"),
  };
  return { calls, event };
}

function makeHost(insertResult = true) {
  const calls: string[] = [];
  const host: ComposerFileReferenceDropHost = {
    insertReferenceText: (text) => {
      calls.push(`insert:${text}`);
      return insertResult;
    },
    setDragActive: (active) => calls.push(`active:${active}`),
    resetDragState: () => calls.push("reset"),
    onInsertRejected: () => calls.push("rejected"),
  };
  return { calls, host };
}

describe("setComposerFileReferenceDragData", () => {
  it("writes a copy-only custom mention payload without impersonating an OS file drop", () => {
    const payloads = new Map<string, string>();
    const transfer = {
      effectAllowed: "all" as DataTransfer["effectAllowed"],
      setData: (format: string, data: string) => payloads.set(format, data),
    };

    setComposerFileReferenceDragData(transfer, "docs/release notes.md");

    expect(transfer.effectAllowed).toBe("copy");
    expect(payloads.get(CHAT_FILE_REFERENCE_DRAG_TYPE)).toBe('@"docs/release notes.md"');
    expect(payloads.get("text/plain")).toBe("docs/release notes.md");
    expect(payloads.has("Files")).toBe(false);
  });
});

describe("canAcceptComposerFileReferenceDrop", () => {
  const ready = {
    isConnecting: false,
    isComposerApprovalState: false,
    isSendBusy: false,
    pendingUserInputCount: 0,
  } as const;

  it("accepts a reference while the normal composer is ready", () => {
    expect(canAcceptComposerFileReferenceDrop(ready)).toBe(true);
  });

  it.each([
    { ...ready, isConnecting: true },
    { ...ready, isComposerApprovalState: true },
    { ...ready, isSendBusy: true },
    { ...ready, pendingUserInputCount: 1 },
  ])("rejects states that disable, repurpose, or race the composer", (availability) => {
    expect(canAcceptComposerFileReferenceDrop(availability)).toBe(false);
  });
});

describe("makeComposerFileReferenceDragHandlers", () => {
  it("leaves OS file and image drags untouched", () => {
    const { calls: hostCalls, host } = makeHost();
    const handlers = makeComposerFileReferenceDragHandlers(host);
    const { calls: eventCalls, event } = makeDragEvent({ types: ["Files"] });

    handlers.onDragEnter(event);
    handlers.onDragOver(event);
    handlers.onDrop(event);

    expect(eventCalls).toEqual([]);
    expect(hostCalls).toEqual([]);
  });

  it("claims the custom payload before the editor and inserts it once", () => {
    const { calls: hostCalls, host } = makeHost();
    const handlers = makeComposerFileReferenceDragHandlers(host);
    const { calls: eventCalls, event } = makeDragEvent({ referenceText: "@src/app.ts" });

    handlers.onDrop(event);

    expect(eventCalls).toEqual(["prevent-default", "synthetic-stop", "native-stop"]);
    expect(hostCalls).toEqual(["reset", "insert:@src/app.ts"]);
  });

  it("uses the copy effect advertised by the explorer source", () => {
    const { host } = makeHost();
    const handlers = makeComposerFileReferenceDragHandlers(host);
    const { event } = makeDragEvent();

    handlers.onDragOver(event);

    expect(event.dataTransfer.dropEffect).toBe("copy");
  });

  it("reports a busy-state insertion rejection instead of mutating silently", () => {
    const { calls, host } = makeHost(false);
    const handlers = makeComposerFileReferenceDragHandlers(host);

    handlers.onDrop(makeDragEvent().event);

    expect(calls).toEqual(["reset", "insert:@apps/web/src/main.tsx", "rejected"]);
  });

  it("cleans up an empty or malformed custom drop", () => {
    const { calls, host } = makeHost();
    const handlers = makeComposerFileReferenceDragHandlers(host);

    handlers.onDrop(makeDragEvent({ referenceText: "" }).event);

    expect(calls).toEqual(["reset"]);
  });

  it("cleans up the active highlight when a drag ends without a drop", () => {
    const { calls, host } = makeHost();
    const handlers = makeComposerFileReferenceDragHandlers(host);

    handlers.onDragEnter(makeDragEvent().event);
    handlers.onDragEnd();

    expect(calls).toEqual(["active:true", "reset"]);
  });
});
