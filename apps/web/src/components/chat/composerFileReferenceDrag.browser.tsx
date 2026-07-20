// FILE: composerFileReferenceDrag.browser.tsx
// Purpose: Browser integration coverage for explorer-to-composer drag wiring.
// Layer: Browser UI test
// Depends on: the shared composer drop hook and the real workspace explorer row.

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDropzone } from "~/hooks/useComposerDropzone";
import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";
import { setComposerFileReferenceDragData } from "~/lib/composerFileReferenceDrag";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { WorkspaceFilesSidebar } from "./workspaceExplorer";

function DropzoneHarness(props: {
  readonly addFiles: (files: readonly File[]) => void;
  readonly addImages: (files: readonly File[]) => void;
  readonly appendReferenceText: (text: string) => void;
  readonly canAppendReferenceText: () => boolean;
  readonly onNestedDrop: () => void;
  readonly onReferenceDropRejected: () => void;
}) {
  const [isDragActive, setIsDragActive] = useState(false);
  const {
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onComposerReferenceDragEnterCapture,
    onComposerReferenceDragOverCapture,
    onComposerReferenceDragLeaveCapture,
    onComposerReferenceDropCapture,
  } = useComposerDropzone({
    addImages: props.addImages,
    fileSupport: {
      genericFiles: "accept",
      addFiles: props.addFiles,
    },
    appendReferenceText: props.appendReferenceText,
    canAppendReferenceText: props.canAppendReferenceText,
    onReferenceDropRejected: props.onReferenceDropRejected,
    setIsDragOverComposer: setIsDragActive,
  });

  return (
    <div
      data-testid="composer-dropzone"
      onDragEnterCapture={onComposerReferenceDragEnterCapture}
      onDragOverCapture={onComposerReferenceDragOverCapture}
      onDragLeaveCapture={onComposerReferenceDragLeaveCapture}
      onDropCapture={onComposerReferenceDropCapture}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      <div data-testid="nested-editor" onDrop={props.onNestedDrop}>
        Nested editor target
      </div>
      <output data-testid="drag-highlight">{isDragActive ? "active" : "idle"}</output>
    </div>
  );
}

async function mountDropzone(options?: { readonly canAppendReferenceText?: () => boolean }) {
  const addFiles = vi.fn<(files: readonly File[]) => void>();
  const addImages = vi.fn<(files: readonly File[]) => void>();
  const appendReferenceText = vi.fn<(text: string) => void>();
  const onNestedDrop = vi.fn<() => void>();
  const onReferenceDropRejected = vi.fn<() => void>();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <DropzoneHarness
      addFiles={addFiles}
      addImages={addImages}
      appendReferenceText={appendReferenceText}
      canAppendReferenceText={options?.canAppendReferenceText ?? (() => true)}
      onNestedDrop={onNestedDrop}
      onReferenceDropRejected={onReferenceDropRejected}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    addFiles,
    addImages,
    appendReferenceText,
    onNestedDrop,
    onReferenceDropRejected,
  };
}

function createReferenceTransfer(path: string): DataTransfer {
  const transfer = new DataTransfer();
  setComposerFileReferenceDragData(transfer, path);
  return transfer;
}

function dispatchDragEvent(
  target: EventTarget,
  type: "dragend" | "dragenter" | "dragstart" | "drop",
  dataTransfer?: DataTransfer,
): DragEvent {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    ...(dataTransfer ? { dataTransfer } : {}),
  });
  target.dispatchEvent(event);
  return event;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing browser-test element: ${selector}`);
  }
  return element;
}

describe("explorer-to-composer file reference drag", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("claims a nested custom drop during capture and appends exactly once", async () => {
    await using mounted = await mountDropzone();
    const transfer = createReferenceTransfer("docs/release notes.md");
    const dropEvent = dispatchDragEvent(
      requireElement('[data-testid="nested-editor"]'),
      "drop",
      transfer,
    );

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(mounted.appendReferenceText).toHaveBeenCalledExactlyOnceWith('@"docs/release notes.md"');
    expect(mounted.onNestedDrop).not.toHaveBeenCalled();
    expect(mounted.addImages).not.toHaveBeenCalled();
    expect(mounted.addFiles).not.toHaveBeenCalled();
    expect(mounted.onReferenceDropRejected).not.toHaveBeenCalled();
  });

  it("lets native Files bypass reference capture and reach attachment handling", async () => {
    await using mounted = await mountDropzone();
    const transfer = new DataTransfer();
    transfer.items.add(new File(["image"], "diagram.png", { type: "image/png" }));
    expect(Array.from(transfer.types)).toContain("Files");

    const dropEvent = dispatchDragEvent(
      requireElement('[data-testid="nested-editor"]'),
      "drop",
      transfer,
    );

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(mounted.onNestedDrop).toHaveBeenCalledOnce();
    expect(mounted.addImages).toHaveBeenCalledOnce();
    expect(mounted.addImages.mock.calls[0]?.[0]?.map((file) => file.name)).toEqual(["diagram.png"]);
    expect(mounted.appendReferenceText).not.toHaveBeenCalled();
    expect(mounted.onReferenceDropRejected).not.toHaveBeenCalled();
  });

  it("checks preflight availability at drop time without requiring a rerender", async () => {
    let sendPreflightInFlight = false;
    await using mounted = await mountDropzone({
      canAppendReferenceText: () => !sendPreflightInFlight,
    });
    sendPreflightInFlight = true;
    const dropEvent = dispatchDragEvent(
      requireElement('[data-testid="nested-editor"]'),
      "drop",
      createReferenceTransfer("src/busy.ts"),
    );

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(mounted.onReferenceDropRejected).toHaveBeenCalledOnce();
    expect(mounted.appendReferenceText).not.toHaveBeenCalled();
    expect(mounted.onNestedDrop).not.toHaveBeenCalled();
    expect(mounted.addImages).not.toHaveBeenCalled();
    expect(mounted.addFiles).not.toHaveBeenCalled();
  });

  it("clears the active highlight on a real window dragend", async () => {
    await using _ = await mountDropzone();
    const nestedEditor = requireElement('[data-testid="nested-editor"]');
    const highlight = requireElement<HTMLOutputElement>('[data-testid="drag-highlight"]');

    dispatchDragEvent(nestedEditor, "dragenter", createReferenceTransfer("src/app.ts"));
    await vi.waitFor(() => expect(highlight.textContent).toBe("active"));

    dispatchDragEvent(window, "dragend");
    await vi.waitFor(() => expect(highlight.textContent).toBe("idle"));
  });

  it("writes the explorer row payload without selecting or opening the file", async () => {
    const workspaceRoot = "/repo/project";
    const filePath = "docs/release notes.md";
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectQueryKeys.listDirectories(workspaceRoot, null, true), {
      entries: [{ path: filePath, name: "release notes.md", kind: "file" }],
    });
    const onSelectFile = vi.fn<(path: string) => void>();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilesSidebar
          workspaceRoot={workspaceRoot}
          selectedFilePath={null}
          expandedDirectories={new Set()}
          onSelectFile={onSelectFile}
          onToggleDirectory={vi.fn()}
          onReferenceInChat={undefined}
        />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      const transfer = new DataTransfer();
      dispatchDragEvent(requireElement(`button[title="${filePath}"]`), "dragstart", transfer);

      expect(transfer.getData(CHAT_FILE_REFERENCE_DRAG_TYPE)).toBe('@"docs/release notes.md"');
      expect(transfer.getData("text/plain")).toBe(filePath);
      expect(onSelectFile).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
      queryClient.clear();
    }
  });
});
