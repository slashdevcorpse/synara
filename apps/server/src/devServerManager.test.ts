// FILE: devServerManager.test.ts
// Purpose: Covers project dev-server registry helpers without starting PTYs.
// Layer: Server unit tests for DevServerManager support logic.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  type ProjectDevServer,
  type ServerLocalServerProcess,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import {
  DevServerManager,
  DevServerManagerLive,
  type DevServerManagerShape,
  findProjectDevServerForLocalServer,
  requireActiveProjectForDevServer,
} from "./devServerManager";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager";

function makeTerminalManager(): TerminalManagerShape {
  const snapshot = (input: { readonly threadId: string; readonly cwd: string }) => ({
    threadId: input.threadId,
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: input.cwd,
    status: "running" as const,
    pid: 4242,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-07-20T12:00:00.000Z",
  });
  return {
    open: (input) => Effect.succeed(snapshot(input)),
    write: () => Effect.void,
    ackOutput: () => Effect.void,
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: (input) => Effect.succeed(snapshot(input)),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    dispose: Effect.void,
  };
}

async function withDevServerManager(
  use: (manager: DevServerManagerShape) => Promise<void>,
): Promise<void> {
  const layer = DevServerManagerLive.pipe(
    Layer.provide(Layer.succeed(TerminalManager, makeTerminalManager())),
  );
  const runtime = ManagedRuntime.make(layer);
  try {
    const manager = await runtime.runPromise(Effect.service(DevServerManager));
    await use(manager);
  } finally {
    await runtime.dispose();
  }
}

function makeDevServer(overrides: Partial<ProjectDevServer> = {}): ProjectDevServer {
  return {
    projectId: ProjectId.makeUnsafe("project-1"),
    command: "pnpm run dev",
    cwd: "/repo/app",
    pid: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function makeLocalServer(
  overrides: Partial<ServerLocalServerProcess> = {},
): ServerLocalServerProcess {
  return {
    id: "200:5173",
    pid: 200,
    command: "node",
    displayName: "Vite",
    args: "node ./node_modules/.bin/vite",
    ports: [5173],
    addresses: [{ host: "127.0.0.1", port: 5173, url: "http://127.0.0.1:5173", family: "tcp4" }],
    isStoppable: true,
    ...overrides,
  };
}

describe("findProjectDevServerForLocalServer", () => {
  it("matches a local server owned by the tracked PTY pid", () => {
    const devServer = makeDevServer({ pid: 200 });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ pid: 200 }),
        devServers: [devServer],
      }),
    ).toBe(devServer);
  });

  it("uses the shared local-server ownership rule for cwd matches", () => {
    const devServer = makeDevServer({ cwd: "/repo/app", pid: null });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app/packages/web", pid: 200 }),
        devServers: [devServer],
      }),
    ).toBe(devServer);
  });

  it("does not match sibling folders with the same prefix", () => {
    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app-other" }),
        devServers: [makeDevServer({ cwd: "/repo/app" })],
      }),
    ).toBeNull();
  });
});

describe("DevServerManager project archive lifecycle", () => {
  it("rejects archive reservation while leaving the existing dev server running", async () => {
    await withDevServerManager(async (manager) => {
      const projectId = ProjectId.makeUnsafe("project-running-during-archive");
      const started = await Effect.runPromise(
        manager.run({ projectId, command: "bun run dev", cwd: "C:\\work\\running" }),
      );

      await expect(Effect.runPromise(manager.reserveProjectArchive(projectId))).resolves.toEqual({
        status: "dev-server-active",
      });
      await expect(Effect.runPromise(manager.list)).resolves.toEqual({
        servers: [started.server],
      });
    });
  });

  it("blocks starts until the owning archive reservation is cancelled", async () => {
    await withDevServerManager(async (manager) => {
      const projectId = ProjectId.makeUnsafe("project-archive-reservation-owner");
      const reservation = await Effect.runPromise(manager.reserveProjectArchive(projectId));
      expect(reservation.status).toBe("acquired");
      if (reservation.status !== "acquired") return;

      await Effect.runPromise(
        manager.cancelProjectArchiveReservation({
          projectId,
          reservationId: "not-the-owner",
        }),
      );
      await expect(
        Effect.runPromise(
          manager.run({ projectId, command: "bun run dev", cwd: "C:\\work\\reserved" }),
        ),
      ).rejects.toThrow(/archived or being archived/);

      await Effect.runPromise(
        manager.cancelProjectArchiveReservation({
          projectId,
          reservationId: reservation.reservationId,
        }),
      );
      await expect(
        Effect.runPromise(
          manager.run({ projectId, command: "bun run dev", cwd: "C:\\work\\reserved" }),
        ),
      ).resolves.toMatchObject({ server: { projectId } });
    });
  });

  it("rejects a stale start for an archived project after manager state is lost", async () => {
    const projectId = ProjectId.makeUnsafe("project-archived-before-manager-restart");

    await expect(
      Effect.runPromise(
        requireActiveProjectForDevServer({
          projectId,
          project: Option.none(),
        }),
      ),
    ).rejects.toThrow(/unavailable or archived/);
  });
});
