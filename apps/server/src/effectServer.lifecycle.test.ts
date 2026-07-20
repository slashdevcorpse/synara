import { Effect, Scope } from "effect";
import { describe, expect, it } from "vitest";

import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  closeServerRuntimePipeline,
  reconcileManagedWorktreesBeforeHttpListen,
} from "./effectServer.ts";

describe("server runtime pipeline shutdown", () => {
  it("persists accepted provider terminal work before the engine stops", async () => {
    const order: string[] = [];
    let terminalAccepted = false;
    let terminalPersisted = false;
    let attachmentsDrained = false;
    const subscriptionsScope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(
      Scope.addFinalizer(
        subscriptionsScope,
        Effect.sync(() => {
          expect(terminalAccepted).toBe(true);
          terminalPersisted = true;
          order.push("reactors-drained-and-persisted");
        }),
      ),
    );

    await Effect.runPromise(
      closeServerRuntimePipeline({
        orchestrationEngine: {
          quiesce: Effect.sync(() => order.push("engine-quiesced")),
          drain: Effect.sync(() => order.push("admitted-commands-drained")),
          stop: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            expect(attachmentsDrained).toBe(true);
            order.push("engine-stopped");
          }),
        },
        providerService: {
          closeRuntimeEvents: Effect.sync(() => {
            terminalAccepted = true;
            order.push("provider-terminal-events-fenced");
          }),
        },
        managedAttachmentCleanup: {
          drain: Effect.sync(() => {
            expect(terminalPersisted).toBe(true);
            attachmentsDrained = true;
            order.push("managed-attachments-drained");
          }),
        },
        subscriptionsScope,
      }),
    );

    expect(order).toEqual([
      "engine-quiesced",
      "admitted-commands-drained",
      "provider-terminal-events-fenced",
      "reactors-drained-and-persisted",
      "managed-attachments-drained",
      "engine-stopped",
    ]);
  });

  it("completes managed worktree reconciliation before HTTP listen can begin", async () => {
    const order: string[] = [];

    await Effect.runPromise(
      reconcileManagedWorktreesBeforeHttpListen({
        worktreesDir: `missing-managed-worktrees-${crypto.randomUUID()}`,
        projectionSnapshotQuery: {
          getCommandReadModel: () =>
            Effect.sync(() => {
              order.push("projection-loaded");
              return { threads: [] } as never;
            }),
        } as Pick<ProjectionSnapshotQueryShape, "getCommandReadModel">,
        git: {} as Pick<GitCoreShape, "removeWorktree" | "statusDetails">,
      }).pipe(
        Effect.tap(() => Effect.sync(() => order.push("worktrees-reconciled"))),
        Effect.andThen(Effect.sync(() => order.push("http-listen"))),
      ),
    );

    expect(order).toEqual(["projection-loaded", "worktrees-reconciled", "http-listen"]);
  });
});
