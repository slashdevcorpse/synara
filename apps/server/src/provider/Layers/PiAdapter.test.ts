// FILE: PiAdapter.test.ts
// Purpose: Verifies Pi adapter model discovery respects auth and SDK-supported thinking levels.
// Layer: Provider adapter tests
// Depends on: PiAdapter discovery helpers and Pi model metadata shapes.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupAllPiOwners,
  failPiStartupAfterCleanup,
  getPiDiscoverableModels,
  getPiSupportedThinkingOptions,
  buildPiAgentGatewayCustomTools,
  makePiBashProcessSupervisor,
  makePiRuntimeEventBase,
  makePiStartupProcessOwner,
  makePiUserInputOptions,
  type PiBashProcessSupervisorOptions,
  PLAIN_PI_EXTENSION_THEME,
  retryRetainedPiStartupOwner,
} from "./PiAdapter";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { markWindowsProviderProcessSpawn } from "../windowsProviderProcess.ts";

describe("Pi native Synara gateway tools", () => {
  it("uses canonical MCP schemas and keeps same-cwd thread tokens distinct", async () => {
    const requests: Array<{ readonly token: string | null; readonly body: any }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({
        token: new Headers(init?.headers).get("Authorization"),
        body,
      });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "synara_list_threads",
                    description: "List Synara threads.",
                    inputSchema: {
                      type: "object",
                      properties: { limit: { type: "number" } },
                    },
                  },
                ],
              }
            : {
                content: [{ type: "text", text: body.params.arguments.owner }],
              },
      });
    };
    const defineTool = (tool: any) => tool;
    const first = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-a" },
      defineTool,
      fetch,
    });
    const second = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-b" },
      defineTool,
      fetch,
    });

    expect(first[0]?.parameters).toEqual({
      type: "object",
      properties: { limit: { type: "number" } },
    });
    await expect(
      first[0]?.execute("call-a", { owner: "thread-a" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "thread-a" }] });
    await expect(
      second[0]?.execute("call-b", { owner: "thread-b" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "thread-b" }] });
    expect(requests.map((request) => request.token)).toEqual([
      "Bearer token-a",
      "Bearer token-b",
      "Bearer token-a",
      "Bearer token-b",
    ]);
    expect(requests[2]?.body.params.arguments).toEqual({ owner: "thread-a" });
    expect(requests[3]?.body.params.arguments).toEqual({ owner: "thread-b" });
  });

  it("forwards Pi tool cancellation to the in-flight MCP request", async () => {
    let callSignal: AbortSignal | null = null;
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "synara_create_threads",
                description: "Create Synara threads.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }

      callSignal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () =>
          reject(
            callSignal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
          );
        if (callSignal?.aborted) {
          rejectAborted();
          return;
        }
        callSignal?.addEventListener("abort", rejectAborted, { once: true });
      });
    };
    const tools = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-a" },
      defineTool: (tool) => tool,
      fetch,
    });
    const controller = new AbortController();
    const execution = tools[0]?.execute("call-a", {}, controller.signal, undefined, {} as never);

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(callSignal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("Pi Bash process supervision", () => {
  it("proves a natural POSIX shell exit by draining its exact detached process group", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 64_190,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn<NonNullable<PiBashProcessSupervisorOptions["spawnProcess"]>>(
      () => child,
    );
    const teardownPosixProcessGroup = vi.fn(async () => undefined);
    const supervisor = makePiBashProcessSupervisor({
      platform: "linux",
      getShellConfig: () => ({ shell: "/bin/bash", args: ["-lc"] }),
      spawnProcess,
      teardownPosixProcessGroup,
    });

    const command = supervisor.operations.exec("printf done", process.cwd(), {
      onData: () => undefined,
    });
    (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
    child.emit("exit", 0, null);

    await expect(command).resolves.toEqual({ exitCode: 0 });
    expect(teardownPosixProcessGroup).toHaveBeenCalledExactlyOnceWith(64_190);
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ detached: true });
  });

  it("uses exact POSIX process-group cleanup on timeout", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 64_191,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const teardownPosixProcessGroup = vi.fn(async () => {
      (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
      child.emit("exit", 0, null);
    });
    const supervisor = makePiBashProcessSupervisor({
      platform: "linux",
      getShellConfig: () => ({ shell: "/bin/bash", args: ["-lc"] }),
      spawnProcess: () => child,
      teardownPosixProcessGroup,
    });

    await expect(
      supervisor.operations.exec("sleep 10", process.cwd(), {
        timeout: 0.001,
        onData: () => undefined,
      }),
    ).rejects.toThrow("timeout:0.001");
    expect(teardownPosixProcessGroup).toHaveBeenCalledExactlyOnceWith(64_191);
  });

  it("retains failed POSIX cleanup after abort and retries before replacement", async () => {
    const firstChild = Object.assign(new EventEmitter(), {
      pid: 64_192,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const secondChild = Object.assign(new EventEmitter(), {
      pid: 64_193,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    let releaseRetry!: () => void;
    const retryProof = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const spawnProcess = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const teardownPosixProcessGroup = vi
      .fn<(processGroupId: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Pi process group remains live"))
      .mockImplementationOnce(async () => retryProof)
      .mockResolvedValueOnce(undefined);
    const supervisor = makePiBashProcessSupervisor({
      platform: "linux",
      getShellConfig: () => ({ shell: "/bin/bash", args: ["-lc"] }),
      spawnProcess,
      teardownPosixProcessGroup,
    });
    const abortController = new AbortController();
    const first = supervisor.operations.exec("first", process.cwd(), {
      signal: abortController.signal,
      onData: () => undefined,
    });

    abortController.abort();
    await expect(first).rejects.toThrow("Pi process group remains live");

    const replacement = supervisor.operations.exec("replacement", process.cwd(), {
      onData: () => undefined,
    });
    await vi.waitFor(() => expect(teardownPosixProcessGroup).toHaveBeenCalledTimes(2));
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    releaseRetry();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
    (secondChild as ChildProcess & { exitCode: number | null }).exitCode = 0;
    secondChild.emit("exit", 0, null);

    await expect(replacement).resolves.toEqual({ exitCode: 0 });
    expect(teardownPosixProcessGroup.mock.calls.map(([processGroupId]) => processGroupId)).toEqual([
      64_192, 64_192, 64_193,
    ]);
  });

  it("attempts every active POSIX process group before teardownAll reports failure", async () => {
    const firstChild = Object.assign(new EventEmitter(), {
      pid: 64_194,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const secondChild = Object.assign(new EventEmitter(), {
      pid: 64_195,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const spawnProcess = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    let firstCleanupAttempts = 0;
    const teardownPosixProcessGroup = vi.fn(async (processGroupId: number) => {
      if (processGroupId === 64_194 && firstCleanupAttempts++ === 0) {
        throw new Error("first Pi process group remains live");
      }
    });
    const supervisor = makePiBashProcessSupervisor({
      platform: "linux",
      getShellConfig: () => ({ shell: "/bin/bash", args: ["-lc"] }),
      spawnProcess,
      teardownPosixProcessGroup,
    });
    const first = supervisor.operations.exec("first", process.cwd(), {
      onData: () => undefined,
    });
    const second = supervisor.operations.exec("second", process.cwd(), {
      onData: () => undefined,
    });

    await expect(supervisor.teardownAll()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.objectContaining({ message: "first Pi process group remains live" })],
    });
    expect(
      teardownPosixProcessGroup.mock.calls
        .slice(0, 2)
        .map(([groupId]) => groupId)
        .sort(),
    ).toEqual([64_194, 64_195]);

    (firstChild as ChildProcess & { exitCode: number | null }).exitCode = 0;
    firstChild.emit("exit", 0, null);
    (secondChild as ChildProcess & { exitCode: number | null }).exitCode = 0;
    secondChild.emit("exit", 0, null);
    await expect(first).resolves.toEqual({ exitCode: 0 });
    await expect(second).resolves.toEqual({ exitCode: 0 });
    expect(teardownPosixProcessGroup).toHaveBeenCalledTimes(3);
  });

  it("cleans a PID-bearing post-spawn error immediately and retains failed proof for retry", async () => {
    const firstChild = Object.assign(new EventEmitter(), {
      pid: 64_196,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const secondChild = Object.assign(new EventEmitter(), {
      pid: 64_197,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const spawnProcess = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const cleanupError = new Error("post-spawn process group remains live");
    const teardownPosixProcessGroup = vi
      .fn<(processGroupId: number) => Promise<void>>()
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const supervisor = makePiBashProcessSupervisor({
      platform: "linux",
      getShellConfig: () => ({ shell: "/bin/bash", args: ["-lc"] }),
      spawnProcess,
      teardownPosixProcessGroup,
    });
    const postSpawnError = new Error("child emitted error after receiving a PID");
    const first = supervisor.operations.exec("first", process.cwd(), {
      onData: () => undefined,
    });
    const firstFailure = expect(first).rejects.toMatchObject({
      name: "AggregateError",
      errors: [postSpawnError, cleanupError],
    });

    firstChild.emit("error", postSpawnError);
    await firstFailure;
    expect(teardownPosixProcessGroup).toHaveBeenCalledExactlyOnceWith(64_196);

    const replacement = supervisor.operations.exec("replacement", process.cwd(), {
      onData: () => undefined,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
    (secondChild as ChildProcess & { exitCode: number | null }).exitCode = 0;
    secondChild.emit("exit", 0, null);

    await expect(replacement).resolves.toEqual({ exitCode: 0 });
    expect(teardownPosixProcessGroup.mock.calls.map(([processGroupId]) => processGroupId)).toEqual([
      64_196, 64_196, 64_197,
    ]);
  });

  it("does not invent a cleanup owner for a PID-less spawn error", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const teardownPosixProcessGroup = vi.fn(async () => undefined);
    const supervisor = makePiBashProcessSupervisor({
      platform: "linux",
      getShellConfig: () => ({ shell: "/bin/bash", args: ["-lc"] }),
      spawnProcess: () => child,
      teardownPosixProcessGroup,
    });
    const spawnError = new Error("spawn failed before PID assignment");
    const command = supervisor.operations.exec("missing", process.cwd(), {
      onData: () => undefined,
    });
    const commandFailure = expect(command).rejects.toBe(spawnError);

    child.emit("error", spawnError);
    await commandFailure;
    await expect(supervisor.teardownAll()).resolves.toBeUndefined();
    expect(teardownPosixProcessGroup).not.toHaveBeenCalled();
  });

  it("keeps an aborted command pending until process-tree exit is proven", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 64_201,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    let proveExit!: () => void;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let observeTeardown!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      observeTeardown = resolve;
    });
    const supervisor = makePiBashProcessSupervisor({
      getShellConfig: () =>
        process.platform === "win32"
          ? {
              shell: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
              args: ["/d", "/s", "/c"],
            }
          : { shell: "/bin/sh", args: ["-c"] },
      spawnProcess: () => child,
      teardownProcessTree: async (input) => {
        observeTeardown();
        await exitProof;
        (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
        child.emit("exit", 0, null);
        await input.rootExited;
        return { escalated: false, signalErrors: [] };
      },
    });
    const abortController = new AbortController();
    const command = supervisor.operations.exec("sleep 10", process.cwd(), {
      signal: abortController.signal,
      onData: () => undefined,
    });
    let settled = false;
    void command.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    abortController.abort();
    await teardownStarted;
    await Promise.resolve();
    expect(settled).toBe(false);

    proveExit();
    await expect(command).rejects.toThrow("aborted");
    expect(settled).toBe(true);
  });

  it("retains a natural proof failure and blocks replacement until cleanup is proven", async () => {
    const firstChild = Object.assign(new EventEmitter(), {
      pid: 64_202,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const secondChild = Object.assign(new EventEmitter(), {
      pid: 64_203,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    markWindowsProviderProcessSpawn(
      firstChild,
      {
        command: "C:\\synara-windows-job-launcher.exe",
        args: [],
        shell: false,
        containment: "windows-job-object",
      },
      true,
    );
    const spawnProcess = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const teardownProcessTree = vi
      .fn()
      .mockRejectedValueOnce(new Error("prior Pi tree remains unproven"))
      .mockResolvedValueOnce({ escalated: false, signalErrors: [] });
    const supervisor = makePiBashProcessSupervisor({
      platform: "win32",
      getShellConfig: () =>
        process.platform === "win32"
          ? {
              shell: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
              args: ["/d", "/s", "/c"],
            }
          : { shell: "/bin/sh", args: ["-c"] },
      spawnProcess,
      teardownProcessTree,
    });

    const first = supervisor.operations.exec("first", process.cwd(), {
      onData: () => undefined,
    });
    (firstChild as ChildProcess & { exitCode: number | null }).exitCode = 1;
    firstChild.emit("exit", 1, null);
    await expect(first).rejects.toThrow("without proving");

    await expect(
      supervisor.operations.exec("blocked", process.cwd(), {
        onData: () => undefined,
      }),
    ).rejects.toThrow("prior process-tree cleanup is unproven");
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(teardownProcessTree).toHaveBeenCalledTimes(1);

    const retried = supervisor.operations.exec("retried", process.cwd(), {
      onData: () => undefined,
    });
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
    (secondChild as ChildProcess & { exitCode: number | null }).exitCode = 0;
    secondChild.emit("exit", 0, null);

    await expect(retried).resolves.toEqual({ exitCode: 0 });
    expect(teardownProcessTree).toHaveBeenCalledTimes(2);
  });

  it("holds replacement behind retry after an explicit teardown failure", async () => {
    const firstChild = Object.assign(new EventEmitter(), {
      pid: 64_204,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const secondChild = Object.assign(new EventEmitter(), {
      pid: 64_205,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    let proveRetry!: () => void;
    const retryProof = new Promise<void>((resolve) => {
      proveRetry = resolve;
    });
    const spawnProcess = vi
      .fn<() => ChildProcess>()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const teardownProcessTree = vi
      .fn()
      .mockRejectedValueOnce(new Error("explicit Pi teardown failed"))
      .mockImplementationOnce(async (input) => {
        await retryProof;
        (firstChild as ChildProcess & { exitCode: number | null }).exitCode = 0;
        firstChild.emit("exit", 0, null);
        await input.rootExited;
        return { escalated: false as const, signalErrors: [] };
      });
    const supervisor = makePiBashProcessSupervisor({
      getShellConfig: () =>
        process.platform === "win32"
          ? {
              shell: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
              args: ["/d", "/s", "/c"],
            }
          : { shell: "/bin/sh", args: ["-c"] },
      spawnProcess,
      teardownProcessTree,
    });
    const abortController = new AbortController();
    const first = supervisor.operations.exec("first", process.cwd(), {
      signal: abortController.signal,
      onData: () => undefined,
    });
    const firstFailure = expect(first).rejects.toThrow("explicit Pi teardown failed");

    abortController.abort();
    await vi.waitFor(() => expect(teardownProcessTree).toHaveBeenCalledTimes(1));
    await firstFailure;

    const replacement = supervisor.operations.exec("replacement", process.cwd(), {
      onData: () => undefined,
    });
    await vi.waitFor(() => expect(teardownProcessTree).toHaveBeenCalledTimes(2));
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    proveRetry();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
    (secondChild as ChildProcess & { exitCode: number | null }).exitCode = 0;
    secondChild.emit("exit", 0, null);

    await expect(replacement).resolves.toEqual({ exitCode: 0 });
  });
});

describe("Pi startup and adapter-wide cleanup ownership", () => {
  it("aggregates startup and cleanup failure, retains the owner, then retries it", async () => {
    const threadId = ThreadId.makeUnsafe("thread-pi-startup");
    const startupError = new ProviderAdapterRequestError({
      provider: "pi",
      method: "session/start",
      detail: "Pi SDK startup rejected.",
    });
    const cleanupError = new Error("Pi startup subprocess remains live");
    const teardownAll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined);
    const owner = makePiStartupProcessOwner({
      operations: {} as never,
      setShellPath: () => undefined,
      teardownAll,
    });
    const retainedOwners = new Map();

    await expect(
      Effect.runPromise(
        failPiStartupAfterCleanup({
          threadId,
          startupError,
          owner,
          retainedOwners,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterRequestError",
      method: "session/start-cleanup",
      cause: expect.objectContaining({
        name: "AggregateError",
        errors: [startupError, cleanupError],
      }),
    });
    expect(retainedOwners.get(threadId)).toBe(owner);

    await Effect.runPromise(retryRetainedPiStartupOwner(retainedOwners, threadId));
    expect(teardownAll).toHaveBeenCalledTimes(2);
    expect(retainedOwners.has(threadId)).toBe(false);
  });

  it("attempts every Pi owner before reporting aggregate stopAll failure", async () => {
    const attempts: string[] = [];
    const firstFailure = new Error("first owner failed");
    const thirdFailure = new Error("third owner failed");
    const cleanup = cleanupAllPiOwners([
      {
        threadId: ThreadId.makeUnsafe("pi-1"),
        cleanup: Effect.sync(() => attempts.push("pi-1")).pipe(
          Effect.andThen(Effect.fail(firstFailure)),
        ),
      },
      {
        threadId: ThreadId.makeUnsafe("pi-2"),
        cleanup: Effect.sync(() => attempts.push("pi-2")),
      },
      {
        threadId: ThreadId.makeUnsafe("pi-3"),
        cleanup: Effect.sync(() => attempts.push("pi-3")).pipe(
          Effect.andThen(Effect.fail(thirdFailure)),
        ),
      },
    ]);

    await expect(Effect.runPromise(cleanup)).rejects.toMatchObject({
      _tag: "ProviderAdapterRequestError",
      method: "session/stop-all",
      cause: expect.objectContaining({
        name: "AggregateError",
        errors: [firstFailure, thirdFailure],
      }),
    });
    expect(attempts.sort()).toEqual(["pi-1", "pi-2", "pi-3"]);
  });
});

function makePiModel(input: {
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  return {
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

describe("getPiDiscoverableModels", () => {
  it("includes custom-provider models authenticated through auth.json semantics", () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-models-"));
    const modelsPath = path.join(agentDir, "models.json");

    try {
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            local: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [{ id: "glm-5.2" }],
            },
          },
        }),
      );
      const authStorage = AuthStorage.inMemory({
        local: { type: "api_key", key: "test-key" },
      });
      const registry = ModelRegistry.create(authStorage, modelsPath);

      const models = getPiDiscoverableModels(registry);

      expect(models.some((model) => model.provider === "local" && model.id === "glm-5.2")).toBe(
        true,
      );
      expect(models.some((model) => model.provider === "anthropic")).toBe(false);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("getPiSupportedThinkingOptions", () => {
  it("hides thinking controls for non-reasoning models", () => {
    expect(getPiSupportedThinkingOptions(makePiModel({ reasoning: false }))).toEqual([]);
  });

  it("advertises xhigh only when the concrete Pi model supports it", () => {
    const withoutXHigh = getPiSupportedThinkingOptions(makePiModel({ reasoning: true }));
    const withXHigh = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );

    expect(withoutXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(withXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("respects provider-level disabled thinking levels", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high"]);
  });
});

describe("Pi extension UI helpers", () => {
  it("stamps events from the lifecycle generation captured by the session context", () => {
    const eventBase = makePiRuntimeEventBase({
      lifecycleGeneration: "generation-pi-7",
      session: { threadId: "thread-pi" as never },
      activeTurnId: "turn-pi" as never,
    });

    expect(eventBase).toMatchObject({
      provider: "pi",
      threadId: "thread-pi",
      turnId: "turn-pi",
      lifecycleGeneration: "generation-pi-7",
    });
  });

  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);

    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("provides a no-color theme object for UI-gated extensions", () => {
    expect(PLAIN_PI_EXTENSION_THEME.fg("accent", "ready")).toBe("ready");
    expect(PLAIN_PI_EXTENSION_THEME.bold("done")).toBe("done");
    expect(PLAIN_PI_EXTENSION_THEME.getThinkingBorderColor("medium")("thinking")).toBe("thinking");
  });
});
