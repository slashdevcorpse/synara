// FILE: composerFileReferenceDrag.ts
// Purpose: Isolate explorer-to-composer drag payloads and event claiming from
//          OS file drops and editor-native drop handling.
// Layer: Web composer drag utility
// Exports: source payload writer, drop availability, and pure drag handlers.

import { CHAT_FILE_REFERENCE_DRAG_TYPE, formatChatFileReference } from "./chatReferences";

export interface ComposerFileReferenceDragSourceTransfer {
  effectAllowed: DataTransfer["effectAllowed"];
  setData(format: string, data: string): void;
}

/**
 * Tags an explorer row drag as a copy-only composer reference. The custom MIME
 * type keeps this path separate from OS `Files` drops, while `text/plain`
 * remains a useful fallback when the row leaves Synara.
 */
export function setComposerFileReferenceDragData(
  dataTransfer: ComposerFileReferenceDragSourceTransfer,
  path: string,
): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CHAT_FILE_REFERENCE_DRAG_TYPE, formatChatFileReference({ path }));
  dataTransfer.setData("text/plain", path);
}

export interface ComposerFileReferenceDropAvailability {
  readonly isConnecting: boolean;
  readonly isComposerApprovalState: boolean;
  readonly isSendBusy: boolean;
  readonly pendingUserInputCount: number;
}

/**
 * Live turns intentionally remain editable for follow-up requests. Only states
 * that disable or repurpose the composer, or can race the active send snapshot,
 * reject an explorer reference drop.
 */
export function canAcceptComposerFileReferenceDrop(
  availability: ComposerFileReferenceDropAvailability,
): boolean {
  return (
    !availability.isConnecting &&
    !availability.isComposerApprovalState &&
    !availability.isSendBusy &&
    availability.pendingUserInputCount === 0
  );
}

export interface ComposerFileReferenceDragTransfer {
  readonly types: ReadonlyArray<string>;
  getData(format: string): string;
  dropEffect: DataTransfer["dropEffect"];
}

export interface ComposerFileReferenceDragEvent {
  readonly dataTransfer: ComposerFileReferenceDragTransfer;
  readonly nativeEvent: { stopPropagation(): void };
  preventDefault(): void;
  stopPropagation(): void;
}

export function dataTransferHasComposerFileReference(types: ReadonlyArray<string>): boolean {
  return types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE);
}

/**
 * Claims only explorer reference drags. React's synthetic stop is not enough:
 * the native event must also stop before Lexical sees the `text/plain` fallback
 * and inserts it independently of the controlled composer draft.
 */
export function claimComposerFileReferenceDragEvent(
  event: ComposerFileReferenceDragEvent,
): boolean {
  if (!dataTransferHasComposerFileReference(event.dataTransfer.types)) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  event.nativeEvent.stopPropagation();
  return true;
}

export interface ComposerFileReferenceDropHost {
  insertReferenceText(text: string): boolean;
  setDragActive(active: boolean): void;
  resetDragState(): void;
  onInsertRejected(): void;
}

export interface ComposerFileReferenceDragHandlers {
  onDragEnter(event: ComposerFileReferenceDragEvent): void;
  onDragOver(event: ComposerFileReferenceDragEvent): void;
  onDrop(event: ComposerFileReferenceDragEvent): void;
  onDragEnd(): void;
}

/** Pure controller shared by React capture handlers and focused unit tests. */
export function makeComposerFileReferenceDragHandlers(
  host: ComposerFileReferenceDropHost,
): ComposerFileReferenceDragHandlers {
  return {
    onDragEnter(event) {
      if (claimComposerFileReferenceDragEvent(event)) {
        host.setDragActive(true);
      }
    },
    onDragOver(event) {
      if (!claimComposerFileReferenceDragEvent(event)) {
        return;
      }
      // The explorer source advertises copy-only; a mismatched effect cancels
      // the browser drop before `drop` can fire.
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDrop(event) {
      if (!claimComposerFileReferenceDragEvent(event)) {
        return;
      }
      host.resetDragState();
      const referenceText = event.dataTransfer.getData(CHAT_FILE_REFERENCE_DRAG_TYPE);
      if (referenceText.length === 0) {
        return;
      }
      if (!host.insertReferenceText(referenceText)) {
        host.onInsertRejected();
      }
    },
    onDragEnd() {
      host.resetDragState();
    },
  };
}
