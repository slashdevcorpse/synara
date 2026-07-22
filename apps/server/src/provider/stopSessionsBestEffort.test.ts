import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { stopSessionsBestEffort } from "./stopSessionsBestEffort.ts";

describe("stopSessionsBestEffort", () => {
  it("attempts every snapshotted session and re-raises the first failure cause", async () => {
    const firstFailure = new Error("first session stop failed");
    const sessions = new Map([
      ["one", { id: "one" }],
      ["two", { id: "two" }],
      ["three", { id: "three" }],
    ]);
    const attempted: string[] = [];

    const exit = await Effect.runPromise(
      Effect.exit(
        stopSessionsBestEffort(sessions.values(), (session) => {
          attempted.push(session.id);
          sessions.delete(session.id);
          if (session.id === "one") return Effect.fail(firstFailure);
          if (session.id === "two") return Effect.die(new Error("later session stop defect"));
          return Effect.void;
        }),
      ),
    );

    expect(attempted).toEqual(["one", "two", "three"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBe(firstFailure);
    }
  });
});
