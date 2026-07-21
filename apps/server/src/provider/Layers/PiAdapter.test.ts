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
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderMaintenanceOwnedResourceCoordinator } from "../providerMaintenanceOwnedResources.ts";
import { prepareWindowsProviderProcess } from "../windowsProviderProcess.ts";
import { supervisePreparedNodeProcess } from "../windowsJobProcessSupervisor.ts";
import {
  getPiDiscoverableModels,
  getPiSupportedThinkingOptions,
  buildPiAgentGatewayCustomTools,
  makePiBashProcessSupervisor,
  makePiRuntimeEventBase,
  makePiUserInputOptions,
  PLAIN_PI_EXTENSION_THEME,
} from "./PiAdapter";

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
      getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
      platform: "linux",
      spawnProcess: () => child,
      superviseProcess: (_prepared, process, options) => ({
        rootPid: Number(process.pid),
        requestTermination: () => true,
        proveExit: async () => ({ escalated: false, signalErrors: [] }),
        teardown: () => {
          const rootExited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
          return options.teardownProcessTree!({
            rootPid: Number(process.pid),
            rootExited,
            ownedProcessGroupId: Number(process.pid),
          });
        },
      }),
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
    const command = supervisor.operations.exec("sleep 10", "/tmp", {
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

  it("uses cooperative exact Job supervision for a branded Windows command", async () => {
    const rawKill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 64_202,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: rawKill,
    }) as unknown as ChildProcess;
    const requestStop = vi.fn(async () => {
      (child as ChildProcess & { exitCode: number | null }).exitCode = 143;
      child.emit("exit", 143, null);
    });
    const verifyExit = vi.fn(async () => undefined);
    const supervisor = makePiBashProcessSupervisor({
      getShellConfig: () => ({ shell: "C:\\tools\\bash.exe", args: ["-c"] }),
      platform: "win32",
      prepareProcess: (command, args, input) =>
        prepareWindowsProviderProcess(command, args, {
          ...input,
          platform: "win32",
          arch: "x64",
          controlDirectory: "C:\\Temp",
          launcherPath: "C:\\synara\\synara-windows-job-launcher.exe",
          fileExists: () => true,
        }),
      superviseProcess: (prepared, process, options) =>
        supervisePreparedNodeProcess(prepared, process, {
          ...options,
          requestStop,
          verifyExit,
        }),
      spawnProcess: () => child,
    });
    const abortController = new AbortController();
    const command = supervisor.operations.exec("sleep 10", "C:\\workspace", {
      signal: abortController.signal,
      onData: () => undefined,
    });

    abortController.abort();
    await expect(command).rejects.toThrow("aborted");
    expect(requestStop).toHaveBeenCalledOnce();
    expect(verifyExit).toHaveBeenCalledOnce();
    expect(rawKill).not.toHaveBeenCalled();
  });

  it("retains a naturally exited Windows Job owner until drain proof can be retried", async () => {
    const rawKill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 64_203,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: rawKill,
    }) as unknown as ChildProcess;
    const requestStop = vi.fn(async () => undefined);
    const verifyExit = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("initial drain proof unavailable"))
      .mockRejectedValueOnce(new Error("retry drain proof unavailable"))
      .mockResolvedValue(undefined);
    const supervisor = makePiBashProcessSupervisor({
      getShellConfig: () => ({ shell: "C:\\tools\\bash.exe", args: ["-c"] }),
      platform: "win32",
      prepareProcess: (command, args, input) =>
        prepareWindowsProviderProcess(command, args, {
          ...input,
          platform: "win32",
          arch: "x64",
          controlDirectory: "C:\\Temp",
          launcherPath: "C:\\synara\\synara-windows-job-launcher.exe",
          fileExists: () => true,
        }),
      superviseProcess: (prepared, process, options) =>
        supervisePreparedNodeProcess(prepared, process, {
          ...options,
          requestStop,
          verifyExit,
        }),
      spawnProcess: () => child,
    });
    const command = supervisor.operations.exec("exit 0", "C:\\workspace", {
      onData: () => undefined,
    });

    (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
    child.emit("exit", 0, null);

    await expect(command).rejects.toThrow("initial drain proof unavailable");
    await expect(supervisor.teardownAll()).rejects.toThrow(
      "Failed to prove all Pi subprocess trees exited.",
    );
    await expect(supervisor.teardownAll()).resolves.toBeUndefined();
    await expect(supervisor.teardownAll()).resolves.toBeUndefined();
    expect(verifyExit).toHaveBeenCalledTimes(3);
    expect(requestStop).not.toHaveBeenCalled();
    expect(rawKill).not.toHaveBeenCalled();
  });

  it("rejects an aborted command when teardown proof fails without waiting for exit", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 64_204,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const teardown = vi
      .fn<() => Promise<{ escalated: boolean; signalErrors: never[] }>>()
      .mockRejectedValueOnce(new Error("abort teardown proof failed"))
      .mockResolvedValue({ escalated: false, signalErrors: [] });
    const processSupervisor = makePiBashProcessSupervisor({
      getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
      platform: "linux",
      spawnProcess: () => child,
      superviseProcess: (_prepared, process) => ({
        rootPid: Number(process.pid),
        requestTermination: () => true,
        proveExit: async () => ({ escalated: false, signalErrors: [] }),
        teardown,
      }),
    });
    const abortController = new AbortController();
    const command = processSupervisor.operations.exec("sleep forever", "/tmp", {
      signal: abortController.signal,
      onData: () => undefined,
    });

    abortController.abort();
    await expect(
      Promise.race([
        command,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("command remained pending")), 250),
        ),
      ]),
    ).rejects.toThrow("abort teardown proof failed");
    expect(teardown).toHaveBeenCalledTimes(1);

    await expect(processSupervisor.teardownAll()).resolves.toBeUndefined();
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it("surfaces a PID-less later spawn error without constructing a fake owner", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const superviseProcess = vi.fn(() => {
      throw new Error("must not install a PID-less supervisor");
    });
    const processSupervisor = makePiBashProcessSupervisor({
      getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
      platform: "linux",
      spawnProcess: () => child,
      superviseProcess,
    });
    const command = processSupervisor.operations.exec("echo never-started", "/tmp", {
      onData: () => undefined,
    });
    const spawnFailure = new Error("spawn failed after returning the child handle");

    child.emit("error", spawnFailure);
    child.emit("close", null, null);

    await expect(command).rejects.toBe(spawnFailure);
    expect(superviseProcess).not.toHaveBeenCalled();
    await expect(processSupervisor.teardownAll()).resolves.toBeUndefined();
  });

  it("drains an owner retained before coordinator registration failed", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 64_205,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
    const maintenanceOwnedResources = {
      register: () => Effect.die(new Error("Pi owner registration failed")),
      drainProviderResources: () => Effect.void,
    } as unknown as ProviderMaintenanceOwnedResourceCoordinator;
    const processSupervisor = makePiBashProcessSupervisor({
      getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
      platform: "linux",
      spawnProcess: () => child,
      maintenanceOwnedResources,
      superviseProcess: (_prepared, process) => ({
        rootPid: Number(process.pid),
        requestTermination: () => true,
        proveExit: async () => ({ escalated: false, signalErrors: [] }),
        teardown,
      }),
    });

    await expect(
      processSupervisor.operations.exec("echo retained", "/tmp", {
        onData: () => undefined,
      }),
    ).rejects.toThrow("Pi owner registration failed");
    expect(teardown).not.toHaveBeenCalled();

    await expect(processSupervisor.teardownAll()).resolves.toBeUndefined();
    await expect(processSupervisor.teardownAll()).resolves.toBeUndefined();
    expect(teardown).toHaveBeenCalledTimes(1);
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
