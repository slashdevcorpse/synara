import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { EditorAvailabilitySnapshot } from "./editorAvailability";
import { makeEditorAvailabilityConfigUpdateStream } from "./wsRpc";

function snapshot(
  revision: number,
  availableEditors: EditorAvailabilitySnapshot["availableEditors"],
): EditorAvailabilitySnapshot {
  return {
    availableEditors,
    status: "ready",
    revision,
    confirmedAt: revision * 1_000,
    failureCategory: null,
    retryAt: null,
  };
}

describe("editor availability config updates", () => {
  it("filters the revision already represented by the initial config snapshot", async () => {
    const events = await Effect.runPromise(
      makeEditorAvailabilityConfigUpdateStream(
        Stream.fromIterable([
          snapshot(1, ["cursor"]),
          snapshot(2, ["vscode"]),
          snapshot(3, []),
        ]),
        1,
      ).pipe(Stream.runCollect),
    );

    expect(Array.from(events)).toEqual([
      {
        type: "configUpdated",
        payload: { issues: [], providers: [], availableEditors: ["vscode"] },
      },
      {
        type: "configUpdated",
        payload: { issues: [], providers: [], availableEditors: [] },
      },
    ]);
  });

  it("emits a completed background discovery newer than an empty initial snapshot", async () => {
    const events = await Effect.runPromise(
      makeEditorAvailabilityConfigUpdateStream(Stream.succeed(snapshot(1, ["vscode"])), 0).pipe(
        Stream.runCollect,
      ),
    );

    expect(Array.from(events)).toEqual([
      {
        type: "configUpdated",
        payload: { issues: [], providers: [], availableEditors: ["vscode"] },
      },
    ]);
  });
});
