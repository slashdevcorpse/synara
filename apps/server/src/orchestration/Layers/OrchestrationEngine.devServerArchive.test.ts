import { CommandId, ProjectId, type ProjectDevServer, type ProjectKind } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { DevServerManager, type DevServerManagerShape } from "../../devServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineWithDevServerLifecycleLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

function makeLifecycleManager(activeServers: readonly ProjectDevServer[] = []) {
  const servers = new Map(activeServers.map((server) => [server.projectId, server]));
  const reservations = new Map<ProjectId, string>();
  const cancellationCalls: Array<{
    readonly projectId: ProjectId;
    readonly reservationId: string;
  }> = [];
  const releaseCalls: ProjectId[] = [];
  let stopCalls = 0;

  const manager: DevServerManagerShape = {
    run: () => Effect.die("not used by archive integration tests"),
    stop: (input) =>
      Effect.sync(() => {
        stopCalls += 1;
        return { stopped: servers.delete(input.projectId) };
      }),
    list: Effect.sync(() => ({ servers: Array.from(servers.values()) })),
    reserveProjectArchive: (projectId) =>
      Effect.sync(() => {
        if (servers.has(projectId)) return { status: "dev-server-active" } as const;
        if (reservations.has(projectId)) return { status: "already-reserved" } as const;
        const reservationId = `reservation:${projectId}`;
        reservations.set(projectId, reservationId);
        return { status: "acquired", reservationId } as const;
      }),
    cancelProjectArchiveReservation: (input) =>
      Effect.sync(() => {
        cancellationCalls.push(input);
        if (reservations.get(input.projectId) === input.reservationId) {
          reservations.delete(input.projectId);
        }
      }),
    releaseProjectArchive: (projectId) =>
      Effect.sync(() => {
        releaseCalls.push(projectId);
        reservations.delete(projectId);
      }),
    stream: Stream.empty,
  };

  return {
    manager,
    cancellationCalls,
    releaseCalls,
    hasReservation: (projectId: ProjectId) => reservations.has(projectId),
    get stopCalls() {
      return stopCalls;
    },
  };
}

async function createSystem(devServerManager: DevServerManagerShape) {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-dev-server-archive-test-",
  });
  const engineLayer = OrchestrationEngineWithDevServerLifecycleLive.pipe(
    Layer.provide(Layer.succeed(DevServerManager, devServerManager)),
  );
  const layer = engineLayer.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    engine: await runtime.runPromise(Effect.service(OrchestrationEngineService)),
    query: await runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

async function createProject(input: {
  readonly engine: OrchestrationEngineShape;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly projectId: ProjectId;
  readonly kind?: ProjectKind;
}) {
  await input.run(
    input.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(`command:create:${input.projectId}`),
      projectId: input.projectId,
      kind: input.kind ?? "project",
      title: `Project ${input.projectId}`,
      workspaceRoot: `C:\\work\\${input.projectId}`,
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      createdAt: "2026-07-20T12:00:00.000Z",
    }),
  );
}

describe("OrchestrationEngine dev-server archive lifecycle", () => {
  it("rejects archive without stopping or hiding the existing dev server", async () => {
    const projectId = ProjectId.makeUnsafe("project-active-dev-server");
    const server: ProjectDevServer = {
      projectId,
      command: "bun run dev",
      cwd: "C:\\work\\project-active-dev-server",
      pid: 4242,
      startedAt: "2026-07-20T12:01:00.000Z",
      status: "running",
    };
    const lifecycle = makeLifecycleManager([server]);
    const system = await createSystem(lifecycle.manager);

    try {
      await createProject({ ...system, projectId });
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.archive",
            commandId: CommandId.makeUnsafe("command:archive:active-dev-server"),
            projectId,
            createdAt: "2026-07-20T12:02:00.000Z",
          }),
        ),
      ).rejects.toThrow(/cannot be archived while its dev server is running/);

      expect(lifecycle.stopCalls).toBe(0);
      await expect(Effect.runPromise(lifecycle.manager.list)).resolves.toEqual({
        servers: [server],
      });
      expect(Option.isSome(await system.run(system.query.getProjectShellById(projectId)))).toBe(
        true,
      );
    } finally {
      await system.dispose();
    }
  });

  it("cancels exactly its own reservation when archive validation fails", async () => {
    const projectId = ProjectId.makeUnsafe("studio-archive-rejected");
    const lifecycle = makeLifecycleManager();
    const system = await createSystem(lifecycle.manager);

    try {
      await createProject({ ...system, projectId, kind: "studio" });
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.archive",
            commandId: CommandId.makeUnsafe("command:archive:studio-rejected"),
            projectId,
            createdAt: "2026-07-20T12:02:00.000Z",
          }),
        ),
      ).rejects.toThrow(/Only regular projects can be archived/);

      expect(lifecycle.cancellationCalls).toEqual([
        { projectId, reservationId: `reservation:${projectId}` },
      ]);
      expect(lifecycle.hasReservation(projectId)).toBe(false);
    } finally {
      await system.dispose();
    }
  });

  it("retains the reservation after archive and releases it only after restore", async () => {
    const projectId = ProjectId.makeUnsafe("project-archive-reservation-retained");
    const lifecycle = makeLifecycleManager();
    const system = await createSystem(lifecycle.manager);

    try {
      await createProject({ ...system, projectId });
      await system.run(
        system.engine.dispatch({
          type: "project.archive",
          commandId: CommandId.makeUnsafe("command:archive:reservation-retained"),
          projectId,
          createdAt: "2026-07-20T12:02:00.000Z",
        }),
      );
      expect(lifecycle.hasReservation(projectId)).toBe(true);
      expect(lifecycle.cancellationCalls).toEqual([]);
      expect(Option.isNone(await system.run(system.query.getProjectShellById(projectId)))).toBe(
        true,
      );

      await system.run(
        system.engine.dispatch({
          type: "project.unarchive",
          commandId: CommandId.makeUnsafe("command:unarchive:reservation-released"),
          projectId,
          createdAt: "2026-07-20T12:03:00.000Z",
        }),
      );
      expect(lifecycle.hasReservation(projectId)).toBe(false);
      expect(lifecycle.releaseCalls).toEqual([projectId]);
      expect(Option.isSome(await system.run(system.query.getProjectShellById(projectId)))).toBe(
        true,
      );
    } finally {
      await system.dispose();
    }
  });
});
