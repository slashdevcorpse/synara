import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeEditorAvailability } from "./editorAvailability";
import { resolveEditorDiscoveryIdentity, type EditorDiscoveryResult } from "./open";

const success = (
  availableEditors: Extract<EditorDiscoveryResult, { status: "success" }>["availableEditors"],
) =>
  ({
    status: "success" as const,
    availableEditors,
    fileSystemOperations: 0,
    subprocessCount: 0,
  });

describe("EditorAvailability", () => {
  it("returns immediately and shares one background discovery across concurrent callers", async () => {
    let calls = 0;
    let resolveDiscovery!: (result: EditorDiscoveryResult) => void;
    const pending = new Promise<EditorDiscoveryResult>((resolve) => {
      resolveDiscovery = resolve;
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const availability = yield* makeEditorAvailability({
            discover: () => {
              calls += 1;
              return pending;
            },
            identity: () => "identity-1",
          });

          const first = yield* availability.getSnapshotAndSchedule;
          const second = yield* availability.getSnapshotAndSchedule;
          const joiningRefresh = yield* availability.refresh.pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          expect(first.availableEditors).toEqual([]);
          expect(first.status).toBe("refreshing");
          expect(second.revision).toBe(0);
          expect(calls).toBe(1);

          resolveDiscovery(success(["vscode"]));
          const confirmed = yield* Fiber.join(joiningRefresh);
          expect(confirmed.availableEditors).toEqual(["vscode"]);
          expect(confirmed.revision).toBe(1);
          expect(calls).toBe(1);
        }),
      ),
    );
  });

  it("queues a changed identity behind a held refresh and never returns the stale result", async () => {
    let currentIdentity = "identity-a";
    const calls: string[] = [];
    const completions = new Map<string, (result: EditorDiscoveryResult) => void>();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const availability = yield* makeEditorAvailability({
            discover: (_signal, identity) =>
              new Promise<EditorDiscoveryResult>((resolve) => {
                calls.push(identity);
                completions.set(identity, resolve);
              }),
            identity: () => currentIdentity,
          });
          yield* availability.getSnapshotAndSchedule;
          yield* Effect.yieldNow;
          expect(calls).toEqual(["identity-a"]);

          currentIdentity = "identity-b";
          const currentIdentityRefresh = yield* availability.refresh.pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(calls).toEqual(["identity-a"]);

          completions.get("identity-a")?.(success(["cursor"]));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(calls).toEqual(["identity-a", "identity-b"]);

          completions.get("identity-b")?.(success(["vscode"]));
          const confirmed = yield* Fiber.join(currentIdentityRefresh);
          expect(confirmed.availableEditors).toEqual(["vscode"]);
          expect(confirmed.revision).toBe(1);
          expect(calls).toEqual(["identity-a", "identity-b"]);
        }),
      ),
    );
  });

  it("coalesces repeated mid-flight identity changes to one latest sequential refresh", async () => {
    let currentIdentity = "identity-a";
    const calls: string[] = [];
    const completions = new Map<string, (result: EditorDiscoveryResult) => void>();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const availability = yield* makeEditorAvailability({
            discover: (_signal, identity) =>
              new Promise<EditorDiscoveryResult>((resolve) => {
                calls.push(identity);
                completions.set(identity, resolve);
              }),
            identity: () => currentIdentity,
          });
          yield* availability.getSnapshotAndSchedule;
          yield* Effect.yieldNow;

          currentIdentity = "identity-b";
          yield* availability.getSnapshotAndSchedule;
          currentIdentity = "identity-c";
          yield* availability.getSnapshotAndSchedule;
          currentIdentity = "identity-d";
          const latestRefresh = yield* availability.refresh.pipe(Effect.forkScoped);

          completions.get("identity-a")?.(success(["cursor"]));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(calls).toEqual(["identity-a", "identity-d"]);

          completions.get("identity-d")?.(success(["vscode"]));
          const confirmed = yield* Fiber.join(latestRefresh);
          expect(confirmed.availableEditors).toEqual(["vscode"]);
          expect(confirmed.revision).toBe(1);
        }),
      ),
    );
  });

  it("refreshes Unicode-distinct cwd identities in either order", async () => {
    const identities = [
      resolveEditorDiscoveryIdentity({
        platform: "win32",
        cwd: "C:\\workspace\\İ",
        env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
      }),
      resolveEditorDiscoveryIdentity({
        platform: "win32",
        cwd: "C:\\workspace\\i\u0307",
        env: { PATH: "C:\\bin", PATHEXT: ".EXE" },
      }),
    ] as const;

    for (const order of [identities, [identities[1], identities[0]] as const]) {
      let currentIdentity = order[0];
      const calls: string[] = [];
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const availability = yield* makeEditorAvailability({
              discover: async (_signal, identity) => {
                calls.push(identity);
                return success(identity === order[0] ? ["cursor"] : ["vscode"]);
              },
              identity: () => currentIdentity,
            });
            yield* availability.refresh;
            currentIdentity = order[1];
            const second = yield* availability.refresh;
            expect(second.availableEditors).toEqual(["vscode"]);
          }),
        ),
      );
      expect(calls).toEqual(order);
    }
  });

  it("retains the last confirmed snapshot on failure and enforces the retry floor", async () => {
    let clock = 10_000;
    let calls = 0;
    const outcomes: EditorDiscoveryResult[] = [
      success(["vscode"]),
      {
        status: "failure",
        category: "windows_store_timeout",
        fileSystemOperations: 4,
        subprocessCount: 1,
      },
      success([]),
    ];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const availability = yield* makeEditorAvailability({
            discover: async () => outcomes[calls++]!,
            identity: () => "identity-1",
            now: () => clock,
          });

          const first = yield* availability.refresh;
          expect(first.availableEditors).toEqual(["vscode"]);
          expect(first.revision).toBe(1);

          const failed = yield* availability.refresh;
          expect(failed.status).toBe("failed");
          expect(failed.availableEditors).toEqual(["vscode"]);
          expect(failed.failureCategory).toBe("windows_store_timeout");
          expect(failed.revision).toBe(1);

          const retryBlocked = yield* availability.refresh;
          expect(retryBlocked.availableEditors).toEqual(["vscode"]);
          expect(calls).toBe(2);

          clock += 2_000;
          const confirmedEmpty = yield* availability.refresh;
          expect(confirmedEmpty.status).toBe("ready");
          expect(confirmedEmpty.availableEditors).toEqual([]);
          expect(confirmedEmpty.revision).toBe(2);
          expect(calls).toBe(3);
        }),
      ),
    );
  });

  it("publishes each successful revision once and never publishes a failed refresh", async () => {
    let clock = 20_000;
    let calls = 0;
    const outcomes: EditorDiscoveryResult[] = [
      success(["cursor"]),
      {
        status: "failure",
        category: "filesystem_transient",
        fileSystemOperations: 1,
        subprocessCount: 0,
      },
      success([]),
    ];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const availability = yield* makeEditorAvailability({
            discover: async () => outcomes[calls++]!,
            identity: () => "identity-1",
            now: () => clock,
          });
          const collected = yield* availability.streamChanges.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          yield* availability.refresh;
          yield* availability.refresh;
          clock += 2_000;
          yield* availability.refresh;

          const events = Array.from(yield* Fiber.join(collected));
          expect(events.map((event) => event.revision)).toEqual([1, 2]);
          expect(events.map((event) => event.availableEditors)).toEqual([["cursor"], []]);
        }),
      ),
    );
  });

  it("aborts and awaits an in-flight discovery when its scope closes", async () => {
    let started = false;
    let aborted = false;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const availability = yield* makeEditorAvailability({
            discover: (signal) =>
              new Promise<EditorDiscoveryResult>((_resolve, reject) => {
                started = true;
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(new Error("aborted"));
                  },
                  { once: true },
                );
              }),
            identity: () => "identity-1",
          });
          yield* availability.getSnapshotAndSchedule;
          yield* Effect.yieldNow;
          expect(started).toBe(true);
        }),
      ),
    );

    expect(aborted).toBe(true);
  });
});
