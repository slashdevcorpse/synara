// FILE: fake-codex.ts
// Purpose: Deterministic process-level Codex CLI/app-server fixture for desktop E2E tests.

import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";
import { spawnSync } from "node:child_process";
import "./network-guard.cjs";

type JsonRecord = Record<string, unknown>;

interface PendingApproval {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly cwd: string;
  readonly command: string;
}

interface FakeCodexConfig {
  readonly invocationLogPath: string;
  readonly networkGuardPath: string;
  readonly networkLogPath: string;
  readonly protocolLogPath: string;
  readonly workspacePath: string;
}

function loadFixtureConfig(): FakeCodexConfig {
  const runtimePath = process.argv[1];
  if (!runtimePath) {
    throw new Error("Fake Codex could not resolve its runtime path.");
  }
  const configPath = Path.join(Path.dirname(runtimePath), "fake-codex-config.json");
  const parsed = JSON.parse(FS.readFileSync(configPath, "utf8")) as Partial<FakeCodexConfig>;
  for (const key of [
    "invocationLogPath",
    "networkGuardPath",
    "networkLogPath",
    "protocolLogPath",
    "workspacePath",
  ] as const) {
    if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
      throw new Error(`Fake Codex config is missing ${key}.`);
    }
  }
  return parsed as FakeCodexConfig;
}

const args = process.argv.slice(2);
const fixtureConfig = loadFixtureConfig();
const protocolLogPath = fixtureConfig.protocolLogPath;
const invocationLogPath = fixtureConfig.invocationLogPath;
const networkGuardPath = fixtureConfig.networkGuardPath;
const controlledWorkspacePath = fixtureConfig.workspacePath;
FS.mkdirSync(Path.dirname(invocationLogPath), { recursive: true });
FS.appendFileSync(
  invocationLogPath,
  `${JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    args,
    runtime: {
      executable: process.execPath,
      bun: typeof process.versions.bun === "string",
    },
  })}\n`,
  "utf8",
);
let nextThread = 1;
let nextTurn = 1;
let nextApproval = 10_000;
const pendingApprovals = new Map<string, PendingApproval>();
const pendingInterrupts = new Map<string, { readonly threadId: string; readonly turnId: string }>();
const threadCwds = new Map<string, string>();
const APPROVAL_MARKER_FILENAME = "e2e-approval-command-output.txt";
const APPROVAL_COMMAND_OUTPUT = "E2E_APPROVAL_COMMAND_OUTPUT";
const APPROVAL_COMMAND_SCRIPT = [
  'const fs = require("node:fs");',
  `fs.writeFileSync(${JSON.stringify(APPROVAL_MARKER_FILENAME)}, ${JSON.stringify(`${APPROVAL_COMMAND_OUTPUT}\n`)}, "utf8");`,
  `process.stdout.write(${JSON.stringify(`${APPROVAL_COMMAND_OUTPUT}\n`)});`,
].join(" ");

function appendProtocolLog(direction: string, payload: unknown): void {
  if (!protocolLogPath) return;
  FS.mkdirSync(Path.dirname(protocolLogPath), { recursive: true });
  FS.appendFileSync(
    protocolLogPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      provider: "codex",
      direction,
      payload,
    })}\n`,
    "utf8",
  );
}

process.once("exit", (code) => {
  appendProtocolLog("fixture", { event: "process-exit", code });
});

function argumentValue(name: string): string | null {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function runTextGeneration(): void {
  const schemaPath = argumentValue("--output-schema");
  const outputPath = argumentValue("--output-last-message");
  if (!schemaPath || !outputPath) {
    throw new Error("Fake Codex text generation requires schema and output paths.");
  }
  const schema = JSON.parse(FS.readFileSync(schemaPath, "utf8")) as {
    readonly properties?: Record<string, unknown>;
  };
  if (!schema.properties || !("title" in schema.properties)) {
    throw new Error("Fake Codex text generation only supports the thread-title schema.");
  }
  appendProtocolLog("fixture", { event: "text-generation-awaiting-stdin" });
  FS.readFileSync(0, "utf8");
  appendProtocolLog("fixture", { event: "text-generation-stdin-complete" });
  FS.writeFileSync(outputPath, JSON.stringify({ title: "E2E Test Thread" }), "utf8");
  appendProtocolLog("fixture", { event: "text-generation-output-written" });
}

function writeStdoutAndExit(output: string): void {
  process.stdout.write(output, () => process.exit(0));
}

function writeMessage(message: JsonRecord): void {
  appendProtocolLog("out", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number, result: unknown = {}): void {
  writeMessage({ id, result });
}

function respondMethodNotFound(id: string | number, method: string): void {
  writeMessage({
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method || "<missing>"}`,
    },
  });
}

function notify(method: string, params: unknown): void {
  writeMessage({ method, params });
}

function promptFromTurnStart(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const input = (params as { input?: unknown }).input;
  if (!Array.isArray(input)) return "";
  return input
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
}

function sendAssistantTurn(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
}): void {
  const itemId = `assistant_${input.turnId}`;
  notify("turn/started", {
    threadId: input.threadId,
    turn: { id: input.turnId, status: "inProgress" },
  });
  notify("item/started", {
    threadId: input.threadId,
    turnId: input.turnId,
    item: { type: "agentMessage", id: itemId, text: "", status: "inProgress" },
  });
  notify("item/agentMessage/delta", {
    threadId: input.threadId,
    turnId: input.turnId,
    itemId,
    delta: input.text,
  });
  notify("item/completed", {
    threadId: input.threadId,
    turnId: input.turnId,
    item: { type: "agentMessage", id: itemId, text: input.text, status: "completed" },
  });
  notify("turn/completed", {
    threadId: input.threadId,
    turn: { id: input.turnId, status: "completed" },
  });
}

function finishAssistantTurn(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
}): void {
  const itemId = `assistant_${input.turnId}`;
  notify("item/started", {
    threadId: input.threadId,
    turnId: input.turnId,
    item: { type: "agentMessage", id: itemId, text: "", status: "inProgress" },
  });
  notify("item/agentMessage/delta", {
    threadId: input.threadId,
    turnId: input.turnId,
    itemId,
    delta: input.text,
  });
  notify("item/completed", {
    threadId: input.threadId,
    turnId: input.turnId,
    item: { type: "agentMessage", id: itemId, text: input.text, status: "completed" },
  });
  notify("turn/completed", {
    threadId: input.threadId,
    turn: { id: input.turnId, status: "completed" },
  });
}

function beginApproval(threadId: string, turnId: string): void {
  const itemId = `command_${turnId}`;
  const requestId = String(nextApproval++);
  const cwd = threadCwds.get(threadId) ?? controlledWorkspacePath;
  if (!cwd) {
    throw new Error("Fake Codex approval has no controlled E2E workspace path.");
  }
  const command = `E2E fixture action: write ${APPROVAL_MARKER_FILENAME}`;
  pendingApprovals.set(requestId, { threadId, turnId, itemId, cwd, command });
  notify("turn/started", {
    threadId,
    turn: { id: turnId, status: "inProgress" },
  });
  notify("item/started", {
    threadId,
    turnId,
    item: {
      type: "commandExecution",
      id: itemId,
      command,
      cwd,
      status: "inProgress",
    },
  });
  writeMessage({
    id: Number(requestId),
    method: "item/commandExecution/requestApproval",
    params: {
      threadId,
      turnId,
      itemId,
      command,
      cwd,
    },
  });
}

function finishApproval(requestId: string, result: unknown): void {
  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    appendProtocolLog("fixture", {
      event: "unexpected-response",
      requestId,
      result,
    });
    return;
  }
  pendingApprovals.delete(requestId);
  const decision =
    result &&
    typeof result === "object" &&
    typeof (result as { decision?: unknown }).decision === "string"
      ? (result as { decision: string }).decision
      : "unknown";
  const startedAt = Date.now();
  const execution =
    decision === "accept"
      ? spawnSync(
          process.execPath,
          ["--require", networkGuardPath, "-e", APPROVAL_COMMAND_SCRIPT],
          {
            cwd: pending.cwd,
            encoding: "utf8",
            env: {
              ...process.env,
              SYNARA_E2E_NETWORK_ROLE: "approval-child",
              SYNARA_FAKE_CODEX_NETWORK_LOG_PATH: fixtureConfig.networkLogPath,
            },
            windowsHide: true,
          },
        )
      : null;
  if (execution) {
    appendProtocolLog("fixture", {
      event: "approval-command-completed",
      pid: execution.pid,
      status: execution.status,
      signal: execution.signal,
      error: execution.error?.message ?? null,
    });
  }
  const output = execution ? `${execution.stdout ?? ""}${execution.stderr ?? ""}` : "";
  if (output.length > 0) {
    notify("item/commandExecution/outputDelta", {
      threadId: pending.threadId,
      turnId: pending.turnId,
      itemId: pending.itemId,
      delta: output,
    });
  }
  const commandSucceeded = execution?.status === 0 && execution.error === undefined;
  notify("item/completed", {
    threadId: pending.threadId,
    turnId: pending.turnId,
    item: {
      type: "commandExecution",
      id: pending.itemId,
      command: pending.command,
      cwd: pending.cwd,
      status: decision === "decline" ? "declined" : commandSucceeded ? "completed" : "failed",
      aggregatedOutput: output,
      exitCode: execution?.status ?? null,
      durationMs: Date.now() - startedAt,
    },
  });
  finishAssistantTurn({
    threadId: pending.threadId,
    turnId: pending.turnId,
    text:
      decision === "accept" && commandSucceeded
        ? "E2E_APPROVAL_ACCEPTED"
        : decision === "accept"
          ? "E2E_APPROVAL_FAILED"
          : `E2E_APPROVAL_${decision.toUpperCase()}`,
  });
}

function beginInterrupt(threadId: string, turnId: string): void {
  const itemId = `assistant_${turnId}`;
  pendingInterrupts.set(turnId, { threadId, turnId });
  notify("turn/started", {
    threadId,
    turn: { id: turnId, status: "inProgress" },
  });
  notify("item/started", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: itemId, text: "", status: "inProgress" },
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId,
    delta: "E2E_INTERRUPT_RUNNING",
  });
}

function handleRequest(message: JsonRecord): void {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  if (typeof id !== "string" && typeof id !== "number") return;

  if (method === "initialize" || method === "skills/extraRoots/set") {
    respond(id);
    return;
  }
  if (method === "model/list") {
    respond(id, {
      data: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          supported_reasoning_efforts: ["low", "medium", "high"],
          default_reasoning_effort: "medium",
        },
        {
          id: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          supported_reasoning_efforts: ["low", "medium", "high"],
          default_reasoning_effort: "medium",
        },
      ],
    });
    return;
  }
  if (method === "plugin/list") {
    respond(id, {
      marketplaces: [],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [],
    });
    return;
  }
  if (method === "account/read") {
    respond(id, { account: { type: "apiKey" } });
    return;
  }
  if (method === "thread/start") {
    const params = message.params as { cwd?: unknown } | undefined;
    const threadId = `e2e_thread_${process.pid}_${nextThread++}`;
    if (typeof params?.cwd === "string") threadCwds.set(threadId, params.cwd);
    respond(id, { thread: { id: threadId } });
    return;
  }
  if (method === "thread/resume") {
    const params = message.params as { threadId?: unknown; cwd?: unknown } | undefined;
    const threadId =
      typeof params?.threadId === "string" ? params.threadId : `e2e_thread_${process.pid}`;
    if (typeof params?.cwd === "string") threadCwds.set(threadId, params.cwd);
    respond(id, { thread: { id: threadId } });
    return;
  }
  if (method === "thread/read") {
    const params = message.params as { threadId?: unknown } | undefined;
    const threadId =
      typeof params?.threadId === "string" ? params.threadId : `e2e_thread_${process.pid}`;
    respond(id, { thread: { id: threadId, turns: [] } });
    return;
  }
  if (method === "turn/start") {
    const params = message.params as { threadId?: unknown } | undefined;
    const threadId =
      typeof params?.threadId === "string" ? params.threadId : `e2e_thread_${process.pid}`;
    const turnId = `e2e_turn_${process.pid}_${nextTurn++}`;
    const prompt = promptFromTurnStart(message.params);
    respond(id, { turn: { id: turnId } });
    setTimeout(() => {
      if (prompt.includes("E2E_APPROVAL")) {
        beginApproval(threadId, turnId);
        return;
      }
      if (prompt.includes("E2E_INTERRUPT")) {
        beginInterrupt(threadId, turnId);
        return;
      }
      sendAssistantTurn({
        threadId,
        turnId,
        text: prompt.includes("E2E_AFTER_RECOVERY") ? "E2E_RECOVERY_REPLY" : "E2E_ASSISTANT_REPLY",
      });
    }, 25);
    return;
  }
  if (method === "turn/interrupt") {
    const params = message.params as { threadId?: unknown; turnId?: unknown } | undefined;
    const turnId = typeof params?.turnId === "string" ? params.turnId : "";
    const pending = pendingInterrupts.get(turnId);
    pendingInterrupts.delete(turnId);
    respond(id);
    if (pending) {
      notify("turn/aborted", {
        threadId: pending.threadId,
        turn: { id: pending.turnId, status: "interrupted" },
      });
    }
    return;
  }

  respondMethodNotFound(id, method);
}

function startAppServer(): void {
  appendProtocolLog("fixture", { event: "process-started", args });
  const reader = Readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRecord;
    try {
      message = JSON.parse(trimmed) as JsonRecord;
    } catch {
      appendProtocolLog("invalid-json", trimmed);
      return;
    }
    appendProtocolLog("in", message);

    if ("id" in message && !("method" in message)) {
      finishApproval(String(message.id), message.result);
      return;
    }
    if (typeof message.method === "string" && "id" in message) {
      handleRequest(message);
      return;
    }
    if (message.method !== "initialized") {
      appendProtocolLog("fixture", {
        event: "unexpected-notification",
        message,
      });
    }
  });
  reader.on("close", () => {
    appendProtocolLog("fixture", { event: "process-stdin-closed" });
    process.exit(0);
  });
}

if (args.length === 1 && args[0] === "--version") {
  writeStdoutAndExit("codex-cli 0.99.0\n");
} else if (args[0] === "login" && args[1] === "status") {
  writeStdoutAndExit("Logged in\n");
} else if (args[0] === "exec") {
  runTextGeneration();
  process.exit(0);
} else if (args.includes("app-server")) {
  startAppServer();
} else {
  process.stderr.write(`Unsupported fake Codex invocation: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
