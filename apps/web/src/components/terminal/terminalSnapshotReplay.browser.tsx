// FILE: terminalSnapshotReplay.browser.tsx
// Purpose: Native Chromium proof for recovered-grid replay using real xterm parsing.
// Layer: Terminal browser integration tests

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { NativeApi, TerminalEvent, TerminalSessionSnapshot } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyReplayOnce,
  createRecoveredGridOutputBuffer,
  type ReplayIdentityState,
  replaySnapshotAtDestinationGrid,
  replaySnapshotAtRecoveredGrid,
  shouldReplayColdSnapshot,
  TERMINAL_WRITE_BATCH_SIZE_LIMIT,
} from "./terminalSnapshotReplay";
import {
  attachRuntimeToContainer,
  createRuntimeEntry,
  disposeRuntimeEntry,
} from "./terminalRuntime";
import { emitTerminalResnapshotRequired, emitWsTransportState } from "../../wsTransportEvents";

const terminals: Terminal[] = [];
const hosts: HTMLDivElement[] = [];
const waitUntilTerminalEventStreamReady = async () => ({
  type: "ready" as const,
  generation: "generation-1",
});

interface TerminalHarness {
  fitAddon: FitAddon;
  host: HTMLDivElement;
  terminal: Terminal;
}

function createTerminal(cols = 80, rows = 12, width = 800, height = 300): TerminalHarness {
  const host = document.createElement("div");
  host.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${width}px`,
    `height:${height}px`,
  ].join(";");
  document.body.append(host);
  hosts.push(host);

  const terminal = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });
  const fitAddon = new FitAddon();
  terminals.push(terminal);
  terminal.loadAddon(fitAddon);
  terminal.open(host);
  return { fitAddon, host, terminal };
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function restoreWindowNativeApi(previousNativeApi: NativeApi | undefined): void {
  if (previousNativeApi === undefined) {
    delete window.nativeApi;
    return;
  }
  window.nativeApi = previousNativeApi;
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function bufferText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function hasWrappedLine(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer.getLine(index)?.isWrapped) return true;
  }
  return false;
}

function hasAnsiRedCell(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  const reusableCell = buffer.getNullCell();
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line.getCell(column, reusableCell);
      if (cell?.getChars() === "r" && cell.isFgPalette() && cell.getFgColor() === 1) {
        return true;
      }
    }
  }
  return false;
}

function dimensionedSnapshot(
  cols: number,
  rows: number,
  identity = "a".repeat(64),
  history = complexHistory(),
): TerminalSessionSnapshot & { recoveredCols: number; recoveredRows: number } {
  return {
    threadId: "thread",
    terminalId: "default",
    cwd: "C:\\project",
    status: "running",
    pid: 1,
    history,
    recoveredCols: cols,
    recoveredRows: rows,
    historyRecordIdentity: identity,
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function legacySnapshot(history: string): TerminalSessionSnapshot {
  return {
    threadId: "thread",
    terminalId: "default",
    cwd: "C:\\project",
    status: "running",
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function complexHistory(): string {
  return [
    "ASCII 中 e\u0301 👩‍💻 \u001b[31mred\u001b[0m\r\n",
    `${"wrapped-content-".repeat(12)}\r\n`,
    "\u001b[4;7Hcursor",
  ].join("");
}

async function seedDirtyDestination(terminal: Terminal, suffix: string): Promise<void> {
  await write(
    terminal,
    [
      `SCROLLBACK-SENTINEL-${suffix}\r\n`,
      ...Array.from({ length: 45 }, (_, index) => `old-${suffix}-${index}\r\n`),
      `DIRTY-DESTINATION-${suffix}`,
    ].join(""),
  );
}

afterEach(() => {
  terminals.splice(0).forEach((terminal) => terminal.dispose());
  hosts.splice(0).forEach((host) => host.remove());
});

describe("recovered terminal snapshot replay in real xterm", () => {
  it.each([
    ["shrink", 24, 8],
    ["grow", 120, 20],
    ["equal", 80, 12],
  ])(
    "replays a cold %s restore at its source grid without erasing scrollback",
    async (name, sourceCols, sourceRows) => {
      const { terminal } = createTerminal(80, 12);
      await seedDirtyDestination(terminal, name);
      const writes: string[] = [];
      const backendResizes: Array<{ cols: number; rows: number }> = [];
      const originalWrite = terminal.write.bind(terminal);
      terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        if (typeof data === "string") writes.push(data);
        originalWrite(data, callback);
      }) as Terminal["write"];

      await replaySnapshotAtRecoveredGrid({
        terminal,
        snapshot: dimensionedSnapshot(sourceCols, sourceRows),
        backendOpenDimensions: { cols: 80, rows: 12 },
        measureFinalGrid: () => ({ cols: 80, rows: 12 }),
        resizeBackend: async (dimensions) => {
          backendResizes.push(dimensions);
        },
      });

      const text = bufferText(terminal);
      expect(text).toContain(`SCROLLBACK-SENTINEL-${name}`);
      expect(text).not.toContain(`DIRTY-DESTINATION-${name}`);
      expect(text).toContain("ASCII");
      expect(text).toContain("中");
      expect(text).toContain("é");
      expect(text).toContain("👩‍💻");
      expect(text).toContain("red");
      expect(text).toContain("wrapped-content-");
      expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
      expect(hasWrappedLine(terminal)).toBe(true);
      expect(hasAnsiRedCell(terminal)).toBe(true);
      expect(terminal.buffer.active.cursorX).toBe(12);
      expect(terminal.buffer.active.cursorY).toBe(3);
      expect(writes[0]).toBe("\u001b[2J\u001b[H");
      expect(writes.every((value) => !value.includes("\u001b[3J"))).toBe(true);
      expect(backendResizes).toEqual([]);
    },
  );

  it("waits for clear parsing, fits one changed container, and sends one final backend resize", async () => {
    const { fitAddon, host, terminal } = createTerminal(80, 12, 960, 360);
    await nextAnimationFrame();
    fitAddon.fit();
    const backendOpenDimensions = { cols: terminal.cols, rows: terminal.rows };
    expect(backendOpenDimensions.cols).toBeGreaterThan(0);
    expect(backendOpenDimensions.rows).toBeGreaterThan(0);

    host.style.width = "620px";
    host.style.height = "230px";
    await nextAnimationFrame();

    const order: string[] = [];
    const backendResizes: Array<{ cols: number; rows: number }> = [];
    const originalWrite = terminal.write.bind(terminal);
    let firstWrite = true;
    terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      if (firstWrite) {
        firstWrite = false;
        originalWrite(data, () => {
          setTimeout(() => {
            order.push("clear-parsed");
            callback?.();
          }, 20);
        });
        return;
      }
      order.push("history-write");
      originalWrite(data, callback);
    }) as Terminal["write"];
    const originalResize = terminal.resize.bind(terminal);
    terminal.resize = ((cols: number, rows: number) => {
      order.push(`local:${cols}x${rows}`);
      originalResize(cols, rows);
    }) as Terminal["resize"];
    let fitCalls = 0;

    await replaySnapshotAtRecoveredGrid({
      terminal,
      snapshot: dimensionedSnapshot(40, 8),
      backendOpenDimensions,
      measureFinalGrid: () => {
        fitCalls += 1;
        return fitAddon.proposeDimensions();
      },
      resizeBackend: async (dimensions) => {
        backendResizes.push(dimensions);
        order.push("backend");
      },
    });

    const finalDimensions = { cols: terminal.cols, rows: terminal.rows };
    expect(host.getBoundingClientRect().width).toBe(620);
    expect(host.getBoundingClientRect().height).toBe(230);
    expect(finalDimensions).not.toEqual(backendOpenDimensions);
    expect(order.indexOf("clear-parsed")).toBeLessThan(order.indexOf("local:40x8"));
    expect(order.indexOf("history-write")).toBeGreaterThan(order.indexOf("local:40x8"));
    expect(fitCalls).toBe(1);
    expect(backendResizes).toEqual([finalDimensions]);
  });

  it("keeps legacy dimensionless replay on the destination grid", async () => {
    const { terminal } = createTerminal(72, 11);
    const history = `legacy-destination\r\n${"legacy-wrap-".repeat(12)}`;
    await new Promise<void>((resolve) => {
      replaySnapshotAtDestinationGrid(terminal, legacySnapshot(history), resolve);
    });

    expect(terminal.cols).toBe(72);
    expect(terminal.rows).toBe(11);
    expect(bufferText(terminal)).toContain("legacy-destination");
    expect(hasWrappedLine(terminal)).toBe(true);
  });

  it("keeps a warm live terminal on its current grid and output path", async () => {
    const { terminal } = createTerminal(76, 13);
    await write(terminal, "WARM-LIVE-OUTPUT");
    const snapshot = dimensionedSnapshot(30, 8, "b".repeat(64), "COLD-HISTORY");

    const coldReplaySelected = shouldReplayColdSnapshot(snapshot, 7, 8);
    expect(shouldReplayColdSnapshot(snapshot, 7, 7)).toBe(false);
    if (coldReplaySelected) {
      await replaySnapshotAtRecoveredGrid({
        terminal,
        snapshot,
        backendOpenDimensions: { cols: 76, rows: 13 },
        measureFinalGrid: () => ({ cols: 76, rows: 13 }),
        resizeBackend: async () => undefined,
      });
    }

    expect(coldReplaySelected).toBe(false);
    expect(terminal.cols).toBe(76);
    expect(terminal.rows).toBe(13);
    expect(bufferText(terminal)).toContain("WARM-LIVE-OUTPUT");
    expect(bufferText(terminal)).not.toContain("COLD-HISTORY");
  });

  it("deduplicates concurrent RPC and push delivery but applies a new equal-text record", async () => {
    const { terminal } = createTerminal(80, 12);
    const state: ReplayIdentityState = {
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    };
    const backendResizes: Array<{ cols: number; rows: number }> = [];
    const history = "IDENTITY-REPLAY";
    let replayCalls = 0;
    const replay = (snapshot: ReturnType<typeof dimensionedSnapshot>) => async () => {
      replayCalls += 1;
      await replaySnapshotAtRecoveredGrid({
        terminal,
        snapshot,
        backendOpenDimensions: { cols: 80, rows: 12 },
        measureFinalGrid: () => ({ cols: 80, rows: 12 }),
        resizeBackend: async (dimensions) => {
          backendResizes.push(dimensions);
        },
      });
    };
    const firstSnapshot = dimensionedSnapshot(40, 8, "c".repeat(64), history);

    const [rpcApplied, pushApplied] = await Promise.all([
      applyReplayOnce(state, firstSnapshot.historyRecordIdentity, replay(firstSnapshot)),
      applyReplayOnce(state, firstSnapshot.historyRecordIdentity, replay(firstSnapshot)),
    ]);
    const changedGridSnapshot = dimensionedSnapshot(50, 9, "d".repeat(64), history);
    const changedGridApplied = await applyReplayOnce(
      state,
      changedGridSnapshot.historyRecordIdentity,
      replay(changedGridSnapshot),
    );

    expect([rpcApplied, pushApplied].toSorted()).toEqual([false, true]);
    expect(changedGridApplied).toBe(true);
    expect(replayCalls).toBe(2);
    expect(backendResizes).toEqual([]);
    expect(bufferText(terminal)).toContain(history);
  });

  it("restores the final grid before releasing live output from an invalidated parse", async () => {
    const { terminal } = createTerminal(90, 14);
    const state: ReplayIdentityState = {
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    };
    const snapshot = dimensionedSnapshot(32, 8, "e".repeat(64), "RETRY-SUCCEEDED");
    const backendResizes: Array<{ cols: number; rows: number }> = [];
    const order: string[] = [];
    let backendDimensions = { cols: 90, rows: 14 };
    let active = true;
    let attempt = 0;
    let historyWrites = 0;
    let activeOutputBuffer: ReturnType<typeof createRecoveredGridOutputBuffer> | null = null;
    const originalWrite = terminal.write.bind(terminal);
    terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      if (data === snapshot.history) {
        historyWrites += 1;
        originalWrite(data, callback);
        if (attempt === 1) {
          activeOutputBuffer?.enqueue({ data: "\r\nLIVE-ONE", byteLength: 10 });
          activeOutputBuffer?.enqueue({ data: "\r\nLIVE-二", byteLength: 10 });
          active = false;
          order.push("history-started-and-invalidated");
        }
        return;
      }
      originalWrite(data, callback);
    }) as Terminal["write"];
    const replay = async () => {
      attempt += 1;
      const outputBuffer = createRecoveredGridOutputBuffer();
      activeOutputBuffer = outputBuffer;
      try {
        await replaySnapshotAtRecoveredGrid({
          terminal,
          snapshot,
          backendOpenDimensions: backendDimensions,
          measureFinalGrid: () => {
            order.push("measure:80x12");
            return { cols: 80, rows: 12 };
          },
          resizeBackend: async (dimensions) => {
            backendResizes.push(dimensions);
            backendDimensions = dimensions;
            order.push(`backend:${dimensions.cols}x${dimensions.rows}`);
          },
          isActive: () => active,
        });
      } finally {
        activeOutputBuffer = null;
        for (const output of outputBuffer.drain()) {
          order.push(`live:${output.data.trim()}@${terminal.cols}x${terminal.rows}`);
          await write(terminal, output.data);
        }
      }
    };

    await expect(applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).rejects.toThrow(
      "aborted",
    );
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(12);
    expect(backendResizes).toEqual([{ cols: 80, rows: 12 }]);
    expect(bufferText(terminal)).toContain("LIVE-ONE");
    expect(bufferText(terminal)).toContain("LIVE-二");
    expect(order.indexOf("backend:80x12")).toBeLessThan(order.indexOf("live:LIVE-ONE@80x12"));
    expect(state).toEqual({
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    });

    active = true;
    expect(await applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).toBe(true);
    expect(await applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).toBe(false);
    expect(historyWrites).toBe(2);
    expect(backendResizes).toEqual([{ cols: 80, rows: 12 }]);
    expect(state.appliedHistoryRecordIdentity).toBe(snapshot.historyRecordIdentity);
  });

  it.each(["throws", "is unavailable"])(
    "falls back before releasing invalidating live output when fit measurement %s",
    async (measurementFailure) => {
      const { terminal } = createTerminal(90, 14);
      const snapshot = dimensionedSnapshot(32, 8, "f".repeat(64), "RECOVERED-HISTORY");
      const outputBuffer = createRecoveredGridOutputBuffer();
      const backendResizes: Array<{ cols: number; rows: number }> = [];
      const order: string[] = [];
      let active = true;
      const originalWrite = terminal.write.bind(terminal);
      terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        if (typeof data === "string") {
          order.push(`write:${data.trim()}@${terminal.cols}x${terminal.rows}`);
        }
        if (data === snapshot.history) {
          originalWrite(data, () => {
            outputBuffer.enqueue({ data: "\r\nLIVE-A", byteLength: 8 });
            outputBuffer.enqueue({ data: "\r\nLIVE-β", byteLength: 9 });
            active = false;
            callback?.();
          });
          return;
        }
        originalWrite(data, callback);
      }) as Terminal["write"];

      try {
        await expect(
          replaySnapshotAtRecoveredGrid({
            terminal,
            snapshot,
            backendOpenDimensions: { cols: 90, rows: 14 },
            measureFinalGrid: () => {
              order.push("measure");
              if (measurementFailure === "throws") throw new Error("renderer unavailable");
              return undefined;
            },
            resizeBackend: async (dimensions) => {
              backendResizes.push(dimensions);
            },
            isActive: () => active,
          }),
        ).rejects.toThrow("aborted");
      } finally {
        for (const output of outputBuffer.drain()) await write(terminal, output.data);
      }

      expect(terminal.cols).toBe(90);
      expect(terminal.rows).toBe(14);
      expect(backendResizes).toEqual([]);
      expect(bufferText(terminal)).toContain("RECOVERED-HISTORY");
      expect(bufferText(terminal)).toContain("LIVE-A");
      expect(bufferText(terminal)).toContain("LIVE-β");
      expect(order).toContain("write:RECOVERED-HISTORY@32x8");
      expect(order).toContain("write:LIVE-A@90x14");
      expect(order).toContain("write:LIVE-β@90x14");
      expect(order.indexOf("measure")).toBeLessThan(order.indexOf("write:LIVE-A@90x14"));
      expect(order.indexOf("write:LIVE-A@90x14")).toBeLessThan(order.indexOf("write:LIVE-β@90x14"));
    },
  );

  it("detects a no-op measured fit and releases live output only after fallback", async () => {
    const { terminal } = createTerminal(90, 14);
    const snapshot = dimensionedSnapshot(32, 8, "1".repeat(64), "NO-OP-HISTORY");
    const outputBuffer = createRecoveredGridOutputBuffer();
    const order: string[] = [];
    let ignoreMeasuredResize = true;
    let active = true;
    const originalResize = terminal.resize.bind(terminal);
    terminal.resize = ((cols: number, rows: number) => {
      if (cols === 80 && rows === 12 && ignoreMeasuredResize) {
        ignoreMeasuredResize = false;
        order.push("measured-resize-no-op");
        return;
      }
      originalResize(cols, rows);
      order.push(`resize:${cols}x${rows}`);
    }) as Terminal["resize"];
    const originalWrite = terminal.write.bind(terminal);
    terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      if (typeof data === "string") {
        order.push(`write:${data.trim()}@${terminal.cols}x${terminal.rows}`);
      }
      if (data === snapshot.history) {
        originalWrite(data, () => {
          outputBuffer.enqueue({ data: "\r\nLIVE-AFTER-NO-OP", byteLength: 18 });
          active = false;
          callback?.();
        });
        return;
      }
      originalWrite(data, callback);
    }) as Terminal["write"];

    try {
      await expect(
        replaySnapshotAtRecoveredGrid({
          terminal,
          snapshot,
          backendOpenDimensions: { cols: 90, rows: 14 },
          measureFinalGrid: () => ({ cols: 80, rows: 12 }),
          resizeBackend: async () => {
            order.push("backend");
          },
          isActive: () => active,
        }),
      ).rejects.toThrow("aborted");
    } finally {
      for (const output of outputBuffer.drain()) await write(terminal, output.data);
    }

    expect(terminal.cols).toBe(90);
    expect(terminal.rows).toBe(14);
    expect(order).toContain("measured-resize-no-op");
    expect(order).toContain("resize:90x14");
    expect(order).toContain("write:LIVE-AFTER-NO-OP@90x14");
    expect(order).not.toContain("backend");
    expect(order.indexOf("resize:90x14")).toBeLessThan(
      order.indexOf("write:LIVE-AFTER-NO-OP@90x14"),
    );
  });

  it.each(["before applying", "after partial application"])(
    "restores when staging resize throws %s before releasing output",
    async (failurePoint) => {
      const { terminal } = createTerminal(90, 14);
      const snapshot = dimensionedSnapshot(32, 8, "2".repeat(64), "MUST-NOT-PARSE");
      const outputBuffer = createRecoveredGridOutputBuffer();
      outputBuffer.enqueue({ data: "LIVE-AFTER-STAGING-FAILURE", byteLength: 26 });
      const order: string[] = [];
      let failStaging = true;
      const originalResize = terminal.resize.bind(terminal);
      terminal.resize = ((cols: number, rows: number) => {
        if (failStaging) {
          failStaging = false;
          if (failurePoint === "after partial application") originalResize(cols, 14);
          order.push(`staging-failed:${terminal.cols}x${terminal.rows}`);
          throw new Error(`staging failed ${failurePoint}`);
        }
        originalResize(cols, rows);
        order.push(`resize:${cols}x${rows}`);
      }) as Terminal["resize"];
      const originalWrite = terminal.write.bind(terminal);
      terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        if (typeof data === "string") {
          order.push(`write:${data.trim()}@${terminal.cols}x${terminal.rows}`);
        }
        originalWrite(data, callback);
      }) as Terminal["write"];

      try {
        await expect(
          replaySnapshotAtRecoveredGrid({
            terminal,
            snapshot,
            backendOpenDimensions: { cols: 90, rows: 14 },
            measureFinalGrid: () => {
              order.push("measure");
              return { cols: 80, rows: 12 };
            },
            resizeBackend: async () => {
              order.push("backend");
            },
          }),
        ).rejects.toThrow(`staging failed ${failurePoint}`);
      } finally {
        for (const output of outputBuffer.drain()) await write(terminal, output.data);
      }

      expect(terminal.cols).toBe(90);
      expect(terminal.rows).toBe(14);
      expect(order).toContain(
        failurePoint === "after partial application"
          ? "staging-failed:32x14"
          : "staging-failed:90x14",
      );
      expect(order).toContain("write:LIVE-AFTER-STAGING-FAILURE@90x14");
      expect(order).not.toContain("write:MUST-NOT-PARSE");
      expect(order).not.toContain("measure");
      expect(order).not.toContain("backend");
      if (failurePoint === "after partial application") {
        expect(order).toContain("resize:90x14");
      }
    },
  );

  it("replaces terminal output from an authoritative overflow resnapshot without duplication", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    const before = "BEFORE-OVERFLOW";
    const missed = "MISSED-BYTE-RANGE";
    const after = "AFTER-OVERFLOW";
    const liveAfter = `\r\n${after}`;
    const authoritativeHistory = `${before}\r\n${missed}${liveAfter}`;
    const acknowledgedBytes: number[] = [];
    let openCalls = 0;
    let snapshotCalls = 0;
    let delayedMissedOutputTimer: number | undefined;
    let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
        open: async () => {
          openCalls += 1;
          return legacySnapshot(`${before}\r\n`);
        },
        snapshot: async () => {
          snapshotCalls += 1;
          const emitTerminalEvent = terminalEventListener;
          expect(emitTerminalEvent).toBeTypeOf("function");
          if (!emitTerminalEvent) throw new Error("terminal event listener was not registered");
          emitTerminalEvent({
            type: "output",
            threadId: "thread",
            terminalId: "default",
            createdAt: new Date(1).toISOString(),
            generation: "generation-1",
            sequence: 3,
            data: liveAfter,
            byteLength: new TextEncoder().encode(liveAfter).byteLength,
          });
          delayedMissedOutputTimer = window.setTimeout(() => {
            emitTerminalEvent({
              type: "output",
              threadId: "thread",
              terminalId: "default",
              createdAt: new Date(1).toISOString(),
              generation: "generation-1",
              sequence: 2,
              data: missed,
              byteLength: new TextEncoder().encode(missed).byteLength,
            });
          }, 0);
          return {
            snapshot: legacySnapshot(`${before}\r\n${missed}`),
            generation: "generation-1",
            watermark: 2,
          };
        },
        write: async () => undefined,
        ackOutput: async (input: { bytes: number }) => {
          acknowledgedBytes.push(input.bytes);
        },
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(authoritativeHistory),
        close: async () => undefined,
        onEvent: (listener: (event: TerminalEvent) => void) => {
          terminalEventListener = listener;
          return () => {
            if (terminalEventListener === listener) terminalEventListener = undefined;
          };
        },
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;

    const entry = createRuntimeEntry({
      runtimeKey: "thread::default",
      threadId: "thread",
      terminalId: "default",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(
        () =>
          entry.opened &&
          entry.runtimeStatus === "ready" &&
          bufferText(entry.terminal).includes(before),
        "initial terminal history",
      );

      emitTerminalResnapshotRequired();
      await waitForCondition(
        () =>
          openCalls === 1 &&
          snapshotCalls === 1 &&
          entry.runtimeStatus === "ready" &&
          entry.pendingWriteBytes === 0 &&
          bufferText(entry.terminal).includes(missed),
        "authoritative terminal overflow resnapshot",
      );

      const text = bufferText(entry.terminal);
      expect(text.split(before)).toHaveLength(2);
      expect(text.split(missed)).toHaveLength(2);
      expect(text.split(after)).toHaveLength(2);
      expect(acknowledgedBytes).toContain(new TextEncoder().encode(liveAfter).byteLength);
      expect(acknowledgedBytes).not.toContain(new TextEncoder().encode(missed).byteLength);
    } finally {
      if (delayedMissedOutputTimer !== undefined) {
        window.clearTimeout(delayedMissedOutputTimer);
      }
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it.each([
    ["initial open", "initial"],
    ["delayed reconciliation", "reconciliation"],
  ] as const)(
    "keeps overflow recovery authoritative when a stale %s response resolves later",
    async (_label, delayedResponse) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
      document.body.append(host);
      hosts.push(host);

      const terminalId = `stale-${delayedResponse}`;
      const authoritativeHistory = `AUTHORITATIVE-${delayedResponse}`;
      const staleHistory = `STALE-${delayedResponse}`;
      const liveAfterRecovery = `LIVE-AFTER-${delayedResponse}`;
      const statusChanges: string[] = [];
      let openCalls = 0;
      let snapshotCalls = 0;
      let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
      let resolveDelayedOpen!: (snapshot: TerminalSessionSnapshot) => void;
      let delayedOpenResolved = false;
      const delayedOpen = new Promise<TerminalSessionSnapshot>((resolve) => {
        resolveDelayedOpen = resolve;
      });
      const settleDelayedOpen = (snapshot: TerminalSessionSnapshot) => {
        if (delayedOpenResolved) return;
        delayedOpenResolved = true;
        resolveDelayedOpen(snapshot);
      };
      const nativeApi = {
        terminal: {
          waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
          open: () => {
            openCalls += 1;
            if (delayedResponse === "initial" || openCalls > 1) return delayedOpen;
            return Promise.resolve({ ...legacySnapshot(""), terminalId });
          },
          snapshot: async () => {
            snapshotCalls += 1;
            return {
              snapshot: { ...legacySnapshot(authoritativeHistory), terminalId },
              generation: "generation-1",
              watermark: 1,
            };
          },
          write: async () => undefined,
          ackOutput: async () => undefined,
          resize: async () => undefined,
          clear: async () => undefined,
          restart: async () => ({ ...legacySnapshot(""), terminalId }),
          close: async () => undefined,
          onEvent: (listener: (event: TerminalEvent) => void) => {
            terminalEventListener = listener;
            return () => {
              if (terminalEventListener === listener) terminalEventListener = undefined;
            };
          },
        },
      } as unknown as NativeApi;
      const previousNativeApi = window.nativeApi;
      window.nativeApi = nativeApi;
      const entry = createRuntimeEntry({
        runtimeKey: `thread::${terminalId}`,
        threadId: "thread",
        terminalId,
        terminalLabel: "Terminal",
        cwd: "C:\\project",
        callbacks: {
          onSessionExited: () => undefined,
          onTerminalMetadataChange: () => undefined,
          onTerminalActivityChange: () => undefined,
          onTerminalRuntimeStatusChange: (_terminalId, status) => {
            statusChanges.push(status);
          },
        },
      });

      try {
        attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
        await waitForCondition(
          () => openCalls === (delayedResponse === "initial" ? 1 : 2),
          `${delayedResponse} open response pending`,
        );

        emitTerminalResnapshotRequired();
        await waitForCondition(
          () =>
            snapshotCalls === 1 &&
            !entry.needsAuthoritativeRecovery &&
            !entry.authoritativeRecoveryInFlight &&
            entry.runtimeStatus === "ready" &&
            entry.pendingHistoryReplayPromise === null &&
            bufferText(entry.terminal).includes(authoritativeHistory),
          `${delayedResponse} authoritative overflow recovery`,
        );
        const authoritativeRequestId = entry.snapshotReconcileRequestId;
        const authoritativeStatusCount = statusChanges.length;

        settleDelayedOpen({ ...legacySnapshot(staleHistory), terminalId });
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        await waitForCondition(
          () => entry.pendingHistoryReplayPromise === null,
          `${delayedResponse} stale response settlement`,
        );

        expect(entry.snapshotReconcileRequestId).toBe(authoritativeRequestId);
        expect(entry.runtimeStatus).toBe("ready");
        expect(statusChanges).toHaveLength(authoritativeStatusCount);
        expect(bufferText(entry.terminal)).toContain(authoritativeHistory);
        expect(bufferText(entry.terminal)).not.toContain(staleHistory);
        expect(terminalEventListener).toBeTypeOf("function");
        if (!terminalEventListener) throw new Error("terminal event listener was not registered");

        terminalEventListener({
          type: "output",
          threadId: "thread",
          terminalId,
          createdAt: new Date().toISOString(),
          generation: "generation-1",
          sequence: 1,
          data: "MUST-NOT-APPLY-DUPLICATE",
          byteLength: 24,
        });
        terminalEventListener({
          type: "output",
          threadId: "thread",
          terminalId,
          createdAt: new Date().toISOString(),
          generation: "generation-1",
          sequence: 2,
          data: liveAfterRecovery,
          byteLength: new TextEncoder().encode(liveAfterRecovery).byteLength,
        });
        await waitForCondition(
          () =>
            entry.pendingWriteBytes === 0 && bufferText(entry.terminal).includes(liveAfterRecovery),
          `${delayedResponse} post-recovery sequence`,
        );

        const finalText = bufferText(entry.terminal);
        expect(entry.outputEventVersion).toBe(1);
        expect(finalText).not.toContain("MUST-NOT-APPLY-DUPLICATE");
        expect(finalText.split(authoritativeHistory)).toHaveLength(2);
        expect(finalText.split(liveAfterRecovery)).toHaveLength(2);
      } finally {
        settleDelayedOpen({ ...legacySnapshot(""), terminalId });
        disposeRuntimeEntry(entry);
        restoreWindowNativeApi(previousNativeApi);
        document.getElementById("synara-terminal-parking")?.remove();
      }
    },
  );

  it.each(["superseded", "disposed", "no longer open"] as const)(
    "does not send a reconnect open after readiness resolves for a %s request",
    async (interruption) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
      document.body.append(host);
      hosts.push(host);

      const terminalId = `stale-readiness-${interruption.replaceAll(" ", "-")}`;
      const openInputs: Array<{ cols: number; rows: number }> = [];
      let readinessCalls = 0;
      let snapshotCalls = 0;
      let resolveReconnectReadiness!: (ready: { type: "ready"; generation: string }) => void;
      let reconnectReadinessResolved = false;
      const reconnectReadiness = new Promise<{ type: "ready"; generation: string }>((resolve) => {
        resolveReconnectReadiness = resolve;
      });
      const settleReconnectReadiness = () => {
        if (reconnectReadinessResolved) return;
        reconnectReadinessResolved = true;
        resolveReconnectReadiness({ type: "ready", generation: "generation-1" });
      };
      const nativeApi = {
        terminal: {
          waitUntilEventStreamReady: () => {
            readinessCalls += 1;
            return readinessCalls === 2
              ? reconnectReadiness
              : Promise.resolve({ type: "ready" as const, generation: "generation-1" });
          },
          open: async (input: { cols: number; rows: number }) => {
            openInputs.push({ cols: input.cols, rows: input.rows });
            return { ...legacySnapshot("INITIAL-SESSION"), terminalId };
          },
          snapshot: async () => {
            snapshotCalls += 1;
            return {
              snapshot: { ...legacySnapshot("AUTHORITATIVE-SESSION"), terminalId },
              generation: "generation-1",
              watermark: 0,
            };
          },
          write: async () => undefined,
          ackOutput: async () => undefined,
          resize: async () => undefined,
          clear: async () => undefined,
          restart: async () => ({ ...legacySnapshot(""), terminalId }),
          close: async () => undefined,
          onEvent: () => () => undefined,
        },
      } as unknown as NativeApi;
      const previousNativeApi = window.nativeApi;
      window.nativeApi = nativeApi;
      const entry = createRuntimeEntry({
        runtimeKey: `thread::${terminalId}`,
        threadId: "thread",
        terminalId,
        terminalLabel: "Terminal",
        cwd: "C:\\project",
        callbacks: {
          onSessionExited: () => undefined,
          onTerminalMetadataChange: () => undefined,
          onTerminalActivityChange: () => undefined,
        },
      });
      let disposed = false;

      try {
        attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
        await waitForCondition(
          () => openInputs.length === 1 && entry.runtimeStatus === "ready",
          `${interruption} initial open`,
        );

        emitWsTransportState("open");
        await waitForCondition(() => readinessCalls === 2, `${interruption} reconnect readiness`);
        const reconnectRequestId = entry.snapshotReconcileRequestId;

        if (interruption === "superseded") {
          emitTerminalResnapshotRequired();
          await waitForCondition(
            () => snapshotCalls === 1 && entry.snapshotReconcileRequestId !== reconnectRequestId,
            "authoritative recovery superseding reconnect",
          );
        } else if (interruption === "disposed") {
          disposeRuntimeEntry(entry);
          disposed = true;
        } else {
          entry.opened = false;
        }

        settleReconnectReadiness();
        await new Promise((resolve) => window.setTimeout(resolve, 25));

        expect(openInputs).toHaveLength(1);
        if (interruption === "superseded") {
          await waitForCondition(
            () =>
              !entry.needsAuthoritativeRecovery &&
              !entry.authoritativeRecoveryInFlight &&
              entry.runtimeStatus === "ready",
            "authoritative recovery completion",
          );
          expect(bufferText(entry.terminal)).toContain("AUTHORITATIVE-SESSION");
        }
      } finally {
        settleReconnectReadiness();
        if (!disposed) disposeRuntimeEntry(entry);
        restoreWindowNativeApi(previousNativeApi);
        document.getElementById("synara-terminal-parking")?.remove();
      }
    },
  );

  it("waits for stream registration before snapshotting output from the prior gap", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    const before = "BEFORE-REGISTRATION-GAP";
    const gap = "\r\nOUTPUT-IN-REGISTRATION-GAP";
    let readinessCalls = 0;
    let resolveRecoveryReadiness: (ready: { type: "ready"; generation: string }) => void = () =>
      undefined;
    let snapshotCalls = 0;
    let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
    const recoveryReadiness = new Promise<{ type: "ready"; generation: string }>((resolve) => {
      resolveRecoveryReadiness = resolve;
    });
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: () => {
          readinessCalls += 1;
          return readinessCalls === 1
            ? Promise.resolve({ type: "ready" as const, generation: "generation-1" })
            : recoveryReadiness;
        },
        open: async () => legacySnapshot(before),
        snapshot: async () => {
          snapshotCalls += 1;
          return {
            snapshot: legacySnapshot(`${before}${gap}`),
            generation: "generation-1",
            watermark: 1,
          };
        },
        write: async () => undefined,
        ackOutput: async () => undefined,
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: (listener: (event: TerminalEvent) => void) => {
          terminalEventListener = listener;
          return () => {
            if (terminalEventListener === listener) terminalEventListener = undefined;
          };
        },
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::registration-gap",
      threadId: "thread",
      terminalId: "registration-gap",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(
        () => entry.runtimeStatus === "ready" && bufferText(entry.terminal).includes(before),
        "registration-gap initial open",
      );

      emitTerminalResnapshotRequired();
      await waitForCondition(() => readinessCalls === 2, "recovery registration barrier");
      expect(snapshotCalls).toBe(0);
      expect(terminalEventListener).toBeTypeOf("function");
      if (!terminalEventListener) throw new Error("terminal event listener was not registered");
      terminalEventListener({
        type: "output",
        threadId: "thread",
        terminalId: "registration-gap",
        createdAt: new Date().toISOString(),
        generation: "generation-1",
        sequence: 1,
        data: gap,
        byteLength: new TextEncoder().encode(gap).byteLength,
      });
      resolveRecoveryReadiness({ type: "ready", generation: "generation-1" });

      await waitForCondition(
        () =>
          snapshotCalls === 1 &&
          !entry.needsAuthoritativeRecovery &&
          entry.runtimeStatus === "ready",
        "registration-gap authoritative recovery",
      );
      expect(bufferText(entry.terminal).split("OUTPUT-IN-REGISTRATION-GAP")).toHaveLength(2);
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("retries a transient quiet-terminal snapshot failure without wedging recovery", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let snapshotCalls = 0;
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: async () => ({
          type: "ready" as const,
          generation: "generation-1",
        }),
        open: async () => legacySnapshot("QUIET-BEFORE-RECOVERY"),
        snapshot: async () => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) throw new Error("transient snapshot failure");
          return {
            snapshot: legacySnapshot("QUIET-AFTER-RECOVERY"),
            generation: "generation-1",
            watermark: 0,
          };
        },
        write: async () => undefined,
        ackOutput: async () => undefined,
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: () => () => undefined,
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::quiet-retry",
      threadId: "thread",
      terminalId: "quiet-retry",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(() => entry.runtimeStatus === "ready", "quiet retry initial open");
      emitTerminalResnapshotRequired();
      await waitForCondition(
        () =>
          snapshotCalls === 2 &&
          !entry.needsAuthoritativeRecovery &&
          !entry.authoritativeRecoveryInFlight &&
          entry.authoritativeRecoveryRetryTimer === null &&
          entry.runtimeStatus === "ready",
        "quiet terminal retry recovery",
      );
      expect(bufferText(entry.terminal)).toContain("QUIET-AFTER-RECOVERY");
      expect(entry.authoritativeRecoveryAttempt).toBe(0);
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("cancels a queued exit callback when recovery confirms a renewed running session", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
    const onSessionExited = vi.fn();
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: async () => ({
          type: "ready" as const,
          generation: "generation-1",
        }),
        open: async () => legacySnapshot("BEFORE-RENEWAL"),
        snapshot: async () => ({
          snapshot: legacySnapshot("RENEWED-RUNNING-SESSION"),
          generation: "generation-1",
          watermark: 1,
        }),
        write: async () => undefined,
        ackOutput: async () => undefined,
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: (listener: (event: TerminalEvent) => void) => {
          terminalEventListener = listener;
          return () => {
            if (terminalEventListener === listener) terminalEventListener = undefined;
          };
        },
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::renewed-running",
      threadId: "thread",
      terminalId: "renewed-running",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(() => entry.opened && entry.runtimeStatus === "ready", "renewal open");
      terminalEventListener?.({
        type: "exited",
        threadId: "thread",
        terminalId: "renewed-running",
        createdAt: new Date().toISOString(),
        generation: "generation-1",
        sequence: 1,
        exitCode: 1,
        exitSignal: null,
      });
      expect(entry.hasHandledExit).toBe(true);

      emitTerminalResnapshotRequired();
      await waitForCondition(
        () =>
          !entry.needsAuthoritativeRecovery &&
          !entry.authoritativeRecoveryInFlight &&
          !entry.hasHandledExit &&
          bufferText(entry.terminal).includes("RENEWED-RUNNING-SESSION"),
        "renewed running recovery",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(onSessionExited).not.toHaveBeenCalled();
      expect(entry.runtimeStatus).toBe("ready");
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("unwinds interrupted recovery and resumes ACK delivery when open is interrupted", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let snapshotCalls = 0;
    let resolveRecoverySnapshot!: (value: {
      snapshot: TerminalSessionSnapshot;
      generation: string;
      watermark: number;
    }) => void;
    const recoverySnapshot = new Promise<{
      snapshot: TerminalSessionSnapshot;
      generation: string;
      watermark: number;
    }>((resolve) => {
      resolveRecoverySnapshot = resolve;
    });
    const acknowledgedBytes: number[] = [];
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: async () => ({
          type: "ready" as const,
          generation: "generation-1",
        }),
        open: async () => legacySnapshot(""),
        snapshot: () => {
          snapshotCalls += 1;
          return recoverySnapshot;
        },
        write: async () => undefined,
        ackOutput: async (input: { bytes: number }) => {
          acknowledgedBytes.push(input.bytes);
        },
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: () => () => undefined,
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::interrupted-recovery",
      threadId: "thread",
      terminalId: "interrupted-recovery",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(
        () => entry.opened && entry.runtimeStatus === "ready",
        "interrupted recovery open",
      );
      emitTerminalResnapshotRequired();
      await waitForCondition(
        () => snapshotCalls === 1 && entry.authoritativeRecoveryInFlight,
        "interrupted recovery snapshot",
      );

      entry.opened = false;
      resolveRecoverySnapshot({
        snapshot: legacySnapshot("IGNORED-AFTER-CLOSE"),
        generation: "generation-1",
        watermark: 0,
      });
      await waitForCondition(
        () =>
          !entry.authoritativeRecoveryInFlight &&
          !entry.needsAuthoritativeRecovery &&
          entry.authoritativeRecoveryRetryTimer === null &&
          !entry.terminalEventRecovery.isRecovering(),
        "interrupted recovery cleanup",
      );

      entry.terminalOutputAckQueue.enqueue(9);
      await waitForCondition(() => acknowledgedBytes.includes(9), "resumed ACK delivery");
      expect(entry.authoritativeRecoveryAttempt).toBe(0);
      expect(bufferText(entry.terminal)).not.toContain("IGNORED-AFTER-CLOSE");
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("preserves a buffered terminal error after authoritative recovery completes", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let snapshotCalls = 0;
    let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
    let resolveRecoverySnapshot!: (value: {
      snapshot: TerminalSessionSnapshot;
      generation: string;
      watermark: number;
    }) => void;
    const recoverySnapshot = new Promise<{
      snapshot: TerminalSessionSnapshot;
      generation: string;
      watermark: number;
    }>((resolve) => {
      resolveRecoverySnapshot = resolve;
    });
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
        open: async () => legacySnapshot("INITIAL"),
        snapshot: () => {
          snapshotCalls += 1;
          return recoverySnapshot;
        },
        write: async () => undefined,
        ackOutput: async () => undefined,
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: (listener: (event: TerminalEvent) => void) => {
          terminalEventListener = listener;
          return () => {
            if (terminalEventListener === listener) terminalEventListener = undefined;
          };
        },
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::buffered-recovery-error",
      threadId: "thread",
      terminalId: "buffered-recovery-error",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(
        () => entry.opened && entry.runtimeStatus === "ready",
        "buffered error initial open",
      );
      expect(terminalEventListener).toBeTypeOf("function");
      if (!terminalEventListener) throw new Error("terminal event listener was not registered");

      emitTerminalResnapshotRequired();
      await waitForCondition(
        () => snapshotCalls === 1 && entry.authoritativeRecoveryInFlight,
        "buffered error recovery snapshot",
      );
      terminalEventListener({
        type: "error",
        threadId: "thread",
        terminalId: "buffered-recovery-error",
        createdAt: new Date().toISOString(),
        generation: "generation-1",
        sequence: 1,
        message: "POST-SNAPSHOT-ERROR",
      });
      resolveRecoverySnapshot({
        snapshot: legacySnapshot("AUTHORITATIVE"),
        generation: "generation-1",
        watermark: 0,
      });

      await waitForCondition(
        () =>
          !entry.authoritativeRecoveryInFlight &&
          entry.runtimeStatus === "error" &&
          bufferText(entry.terminal).includes("POST-SNAPSHOT-ERROR"),
        "buffered recovery error",
      );
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("preserves a buffered terminal start over an older error recovery snapshot", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let snapshotCalls = 0;
    let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
    let resolveRecoverySnapshot!: (value: {
      snapshot: TerminalSessionSnapshot;
      generation: string;
      watermark: number;
    }) => void;
    const recoverySnapshot = new Promise<{
      snapshot: TerminalSessionSnapshot;
      generation: string;
      watermark: number;
    }>((resolve) => {
      resolveRecoverySnapshot = resolve;
    });
    const terminalId = "buffered-recovery-started";
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
        open: async () => ({ ...legacySnapshot("INITIAL"), terminalId }),
        snapshot: () => {
          snapshotCalls += 1;
          return recoverySnapshot;
        },
        write: async () => undefined,
        ackOutput: async () => undefined,
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => ({ ...legacySnapshot(""), terminalId }),
        close: async () => undefined,
        onEvent: (listener: (event: TerminalEvent) => void) => {
          terminalEventListener = listener;
          return () => {
            if (terminalEventListener === listener) terminalEventListener = undefined;
          };
        },
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: `thread::${terminalId}`,
      threadId: "thread",
      terminalId,
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(
        () => entry.opened && entry.runtimeStatus === "ready",
        "buffered start initial open",
      );
      expect(terminalEventListener).toBeTypeOf("function");
      if (!terminalEventListener) throw new Error("terminal event listener was not registered");

      emitTerminalResnapshotRequired();
      await waitForCondition(
        () => snapshotCalls === 1 && entry.authoritativeRecoveryInFlight,
        "buffered start recovery snapshot",
      );
      terminalEventListener({
        type: "started",
        threadId: "thread",
        terminalId,
        createdAt: new Date().toISOString(),
        generation: "generation-1",
        sequence: 1,
        snapshot: { ...legacySnapshot(""), terminalId },
      });
      resolveRecoverySnapshot({
        snapshot: {
          ...legacySnapshot("STALE-ERROR-SNAPSHOT"),
          terminalId,
          status: "error",
          pid: null,
        },
        generation: "generation-1",
        watermark: 0,
      });

      await waitForCondition(
        () => !entry.authoritativeRecoveryInFlight && entry.runtimeStatus === "ready",
        "buffered start remains authoritative",
      );
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("finalizes a dropped exited event from a non-starting recovery snapshot", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let openCalls = 0;
    let snapshotCalls = 0;
    const onSessionExited = vi.fn();
    const exitedSnapshot: TerminalSessionSnapshot = {
      ...legacySnapshot("FINAL-BEFORE-EXIT"),
      status: "exited",
      pid: null,
      exitCode: 23,
    };
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
        open: async () => {
          openCalls += 1;
          return legacySnapshot("");
        },
        snapshot: async () => {
          snapshotCalls += 1;
          return { snapshot: exitedSnapshot, generation: "generation-1", watermark: 1 };
        },
        write: async () => undefined,
        ackOutput: async () => undefined,
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: () => () => undefined,
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::dropped-exit",
      threadId: "thread",
      terminalId: "dropped-exit",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(() => entry.opened && entry.runtimeStatus === "ready", "exit open");
      emitTerminalResnapshotRequired();
      await waitForCondition(
        () => onSessionExited.mock.calls.length === 1,
        "dropped exit finalize",
      );

      expect(openCalls).toBe(1);
      expect(snapshotCalls).toBe(1);
      expect(bufferText(entry.terminal)).toContain("FINAL-BEFORE-EXIT");
      expect(bufferText(entry.terminal)).toContain("Process exited (code 23)");
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("uses the current reattach-only flag for delayed snapshot reconciliation", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    const terminalId = "delayed-reattach";
    const openInputs: Array<Parameters<NativeApi["terminal"]["open"]>[0]> = [];
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
        open: async (input: Parameters<NativeApi["terminal"]["open"]>[0]) => {
          openInputs.push(input);
          if (openInputs.length === 1) {
            return { ...legacySnapshot(""), terminalId };
          }
          return {
            ...legacySnapshot(""),
            terminalId,
            status: "exited" as const,
            pid: null,
            exitCode: 0,
          };
        },
        write: async () => undefined,
        ackOutput: async () => undefined,
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => ({ ...legacySnapshot(""), terminalId }),
        close: async () => undefined,
        onEvent: () => () => undefined,
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    let entry: ReturnType<typeof createRuntimeEntry>;
    entry = createRuntimeEntry({
      runtimeKey: `thread::${terminalId}`,
      threadId: "thread",
      terminalId,
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
        onTerminalRecoveryResolved: () => {
          queueMicrotask(() => {
            entry.reattachOnly = true;
          });
        },
      },
    });

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(() => openInputs.length === 2, "delayed reattach-only reconcile");

      expect(openInputs[0]?.reattachOnly).toBeUndefined();
      expect(openInputs[1]?.reattachOnly).toBe(true);
    } finally {
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it.each(["started", "restarted", "cleared"] as const)(
    "handles retained runtime output through a later %s event and resumes normal delivery",
    async (retryEventType) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
      document.body.append(host);
      hosts.push(host);

      let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
      const backendResizes: Array<{ cols: number; rows: number }> = [];
      const acknowledgedBytes: number[] = [];
      const initialSnapshot = dimensionedSnapshot(80, 24, "0".repeat(64), "");
      const nativeApi = {
        terminal: {
          waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
          open: async () => initialSnapshot,
          write: async () => undefined,
          ackOutput: async (input: { bytes: number }) => {
            acknowledgedBytes.push(input.bytes);
          },
          resize: async (dimensions: { cols: number; rows: number }) => {
            backendResizes.push(dimensions);
          },
          clear: async () => undefined,
          restart: async () => initialSnapshot,
          close: async () => undefined,
          onEvent: (listener: (event: TerminalEvent) => void) => {
            terminalEventListener = listener;
            return () => {
              if (terminalEventListener === listener) terminalEventListener = undefined;
            };
          },
        },
      } as unknown as NativeApi;
      const previousNativeApi = window.nativeApi;
      window.nativeApi = nativeApi;

      const entry = createRuntimeEntry({
        runtimeKey: "thread::default",
        threadId: "thread",
        terminalId: "default",
        terminalLabel: "Terminal",
        cwd: "C:\\project",
        callbacks: {
          onSessionExited: () => undefined,
          onTerminalMetadataChange: () => undefined,
          onTerminalActivityChange: () => undefined,
        },
      });
      const originalResize = entry.terminal.resize.bind(entry.terminal);
      const originalWrite = entry.terminal.write.bind(entry.terminal);

      try {
        attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
        await waitForCondition(
          () => entry.opened && entry.runtimeStatus === "ready",
          "initial terminal open",
        );
        expect(terminalEventListener).toBeTypeOf("function");
        const backendOpenDimensions = entry.backendOpenDimensions;
        expect(backendOpenDimensions).not.toBeNull();
        if (!backendOpenDimensions) throw new Error("missing backend-open dimensions");

        const snapshot = dimensionedSnapshot(
          32,
          8,
          retryEventType === "started"
            ? "3".repeat(64)
            : retryEventType === "restarted"
              ? "4".repeat(64)
              : "5".repeat(64),
          "RUNTIME-RECOVERED-HISTORY",
        );
        let rejectFallback = true;
        let historyWrites = 0;
        let authoritativeHistoryWrites = 0;
        const authoritativeHistory = [
          snapshot.history,
          "\r\nLIVE-BEFORE-UNSAFE",
          "\r\nLIVE-AFTER-UNSAFE",
        ].join("");
        const authoritativeSnapshot = legacySnapshot(authoritativeHistory);
        entry.fitAddon.proposeDimensions = () => undefined;
        entry.terminal.resize = ((cols: number, rows: number) => {
          if (
            rejectFallback &&
            cols === backendOpenDimensions.cols &&
            rows === backendOpenDimensions.rows
          ) {
            return;
          }
          originalResize(cols, rows);
        }) as Terminal["resize"];
        entry.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
          if (data === snapshot.history) {
            historyWrites += 1;
            originalWrite(data, () => {
              if (historyWrites === 1) {
                terminalEventListener?.({
                  type: "output",
                  threadId: "thread",
                  terminalId: "default",
                  createdAt: new Date(1).toISOString(),
                  generation: "generation-1",
                  sequence: 2,
                  data: "\r\nLIVE-BEFORE-UNSAFE",
                  byteLength: 20,
                });
              }
              callback?.();
            });
            return;
          }
          if (data === authoritativeHistory) {
            authoritativeHistoryWrites += 1;
          }
          originalWrite(data, callback);
        }) as Terminal["write"];

        terminalEventListener?.({
          type: "started",
          threadId: "thread",
          terminalId: "default",
          createdAt: new Date(2).toISOString(),
          generation: "generation-1",
          sequence: 1,
          snapshot,
        });
        await waitForCondition(
          () => historyWrites === 1 && entry.pendingHistoryReplayPromise === null,
          "unsafe replay rejection",
        );
        expect(entry.appliedHistoryRecordIdentity).toBeNull();
        expect(bufferText(entry.terminal)).not.toContain("LIVE-BEFORE-UNSAFE");

        terminalEventListener?.({
          type: "output",
          threadId: "thread",
          terminalId: "default",
          createdAt: new Date(3).toISOString(),
          generation: "generation-1",
          sequence: 3,
          data: "\r\nLIVE-AFTER-UNSAFE",
          byteLength: 19,
        });
        expect(bufferText(entry.terminal)).not.toContain("LIVE-AFTER-UNSAFE");
        expect(entry.runtimeStatus).toBe("error");

        rejectFallback = false;
        if (retryEventType === "cleared") {
          terminalEventListener?.({
            type: "cleared",
            threadId: "thread",
            terminalId: "default",
            createdAt: new Date(4).toISOString(),
            generation: "generation-1",
            sequence: 4,
          });
          await waitForCondition(
            () =>
              entry.runtimeStatus === "ready" &&
              entry.terminal.cols === backendOpenDimensions.cols &&
              entry.terminal.rows === backendOpenDimensions.rows,
            "retained output clear recovery",
          );
          terminalEventListener?.({
            type: "output",
            threadId: "thread",
            terminalId: "default",
            createdAt: new Date(5).toISOString(),
            generation: "generation-1",
            sequence: 5,
            data: "LIVE-NORMAL-AFTER-CLEAR",
            byteLength: 23,
          });
          await waitForCondition(
            () =>
              acknowledgedBytes.includes(23) &&
              entry.pendingWriteBytes === 0 &&
              bufferText(entry.terminal).includes("LIVE-NORMAL-AFTER-CLEAR"),
            "normal post-clear output parsing",
          );

          const text = bufferText(entry.terminal);
          expect(text).not.toContain("LIVE-BEFORE-UNSAFE");
          expect(text).not.toContain("LIVE-AFTER-UNSAFE");
          expect(text).toContain("LIVE-NORMAL-AFTER-CLEAR");
          expect(entry.appliedHistoryRecordIdentity).toBeNull();
          expect(historyWrites).toBe(1);
          expect(backendResizes).toEqual([]);
          expect(acknowledgedBytes).toContain(39);
          expect(acknowledgedBytes).toContain(23);
          return;
        }

        terminalEventListener?.({
          type: retryEventType,
          threadId: "thread",
          terminalId: "default",
          createdAt: new Date(4).toISOString(),
          generation: "generation-1",
          sequence: 4,
          snapshot: authoritativeSnapshot,
        });
        await waitForCondition(
          () =>
            entry.pendingHistoryReplayPromise === null &&
            entry.appliedHistoryRecordIdentity?.startsWith("legacy:") === true,
          "retained dimensionless authoritative retry",
        );
        await waitForCondition(() => entry.pendingWriteBytes === 0, "retained output parsing");

        terminalEventListener?.({
          type: "output",
          threadId: "thread",
          terminalId: "default",
          createdAt: new Date(5).toISOString(),
          generation: "generation-1",
          sequence: 5,
          data: "\r\nLIVE-NORMAL-AFTER-RETRY",
          byteLength: 25,
        });
        await waitForCondition(
          () =>
            bufferText(entry.terminal).includes("LIVE-NORMAL-AFTER-RETRY") &&
            acknowledgedBytes.includes(25),
          "normal post-retry output parsing",
        );

        const text = bufferText(entry.terminal);
        const beforeIndex = text.indexOf("LIVE-BEFORE-UNSAFE");
        const afterIndex = text.indexOf("LIVE-AFTER-UNSAFE");
        const normalIndex = text.indexOf("LIVE-NORMAL-AFTER-RETRY");
        expect(beforeIndex).toBeGreaterThanOrEqual(0);
        expect(afterIndex).toBeGreaterThan(beforeIndex);
        expect(normalIndex).toBeGreaterThan(afterIndex);
        expect(text.split("LIVE-BEFORE-UNSAFE")).toHaveLength(2);
        expect(text.split("LIVE-AFTER-UNSAFE")).toHaveLength(2);
        expect(historyWrites).toBe(1);
        expect(authoritativeHistoryWrites).toBe(1);
        expect(backendResizes).toEqual([]);
        expect(acknowledgedBytes).toContain(39);
        expect(acknowledgedBytes).toContain(25);
      } finally {
        entry.terminal.resize = originalResize as Terminal["resize"];
        entry.terminal.write = originalWrite as Terminal["write"];
        disposeRuntimeEntry(entry);
        restoreWindowNativeApi(previousNativeApi);
        document.getElementById("synara-terminal-parking")?.remove();
      }
    },
  );

  it.each(["no-op", "partial"] as const)(
    "rejects a silent %s recovered-grid staging resize before real xterm parses history",
    async (failureMode) => {
      const { terminal } = createTerminal(90, 14);
      const originalResize = terminal.resize.bind(terminal);
      const originalWrite = terminal.write.bind(terminal);
      const snapshot = dimensionedSnapshot(32, 8, "6".repeat(64), "MUST-NOT-PARSE");
      let failStaging = true;
      let historyWrites = 0;
      terminal.resize = ((cols: number, rows: number) => {
        if (failStaging && cols === snapshot.recoveredCols && rows === snapshot.recoveredRows) {
          if (failureMode === "partial") originalResize(cols, terminal.rows);
          return;
        }
        originalResize(cols, rows);
      }) as Terminal["resize"];
      terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        if (data === snapshot.history) historyWrites += 1;
        originalWrite(data, callback);
      }) as Terminal["write"];

      await expect(
        replaySnapshotAtRecoveredGrid({
          terminal,
          snapshot,
          backendOpenDimensions: { cols: 90, rows: 14 },
          measureFinalGrid: () => ({ cols: 90, rows: 14 }),
          resizeBackend: async () => undefined,
        }),
      ).rejects.toThrow("staging resize did not reach");
      expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 90, rows: 14 });
      expect(historyWrites).toBe(0);

      failStaging = false;
      await replaySnapshotAtRecoveredGrid({
        terminal,
        snapshot,
        backendOpenDimensions: { cols: 90, rows: 14 },
        measureFinalGrid: () => ({ cols: 90, rows: 14 }),
        resizeBackend: async () => undefined,
      });
      expect(historyWrites).toBe(1);
    },
  );

  it.each(["push-before-rpc", "rpc-before-push"] as const)(
    "deduplicates concurrent and sequential legacy delivery in %s order and replays changed history",
    async (deliveryOrder) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
      document.body.append(host);
      hosts.push(host);

      const firstSnapshot = legacySnapshot("LEGACY-HISTORY-A");
      const changedSnapshot = legacySnapshot("LEGACY-HISTORY-B");
      let resolveInitialOpen: ((snapshot: TerminalSessionSnapshot) => void) | undefined;
      const initialOpen = new Promise<TerminalSessionSnapshot>((resolve) => {
        resolveInitialOpen = resolve;
      });
      let openCalls = 0;
      let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
      const nativeApi = {
        terminal: {
          waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
          open: () => {
            openCalls += 1;
            return openCalls === 1 ? initialOpen : Promise.resolve(firstSnapshot);
          },
          write: async () => undefined,
          ackOutput: async () => undefined,
          resize: async () => undefined,
          clear: async () => undefined,
          restart: async () => firstSnapshot,
          close: async () => undefined,
          onEvent: (listener: (event: TerminalEvent) => void) => {
            terminalEventListener = listener;
            return () => {
              if (terminalEventListener === listener) terminalEventListener = undefined;
            };
          },
        },
      } as unknown as NativeApi;
      const previousNativeApi = window.nativeApi;
      window.nativeApi = nativeApi;
      const entry = createRuntimeEntry({
        runtimeKey: `thread::dedup-${deliveryOrder}`,
        threadId: "thread",
        terminalId: `dedup-${deliveryOrder}`,
        terminalLabel: "Terminal",
        cwd: "C:\\project",
        callbacks: {
          onSessionExited: () => undefined,
          onTerminalMetadataChange: () => undefined,
          onTerminalActivityChange: () => undefined,
        },
      });
      const originalWrite = entry.terminal.write.bind(entry.terminal);
      const writes: string[] = [];
      let nextSequence = 0;
      entry.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        if (typeof data === "string") writes.push(data);
        originalWrite(data, callback);
      }) as Terminal["write"];
      const push = (snapshot: TerminalSessionSnapshot) =>
        terminalEventListener?.({
          type: "started",
          threadId: "thread",
          terminalId: entry.terminalId,
          createdAt: new Date().toISOString(),
          generation: "generation-1",
          sequence: (nextSequence += 1),
          snapshot,
        });

      try {
        attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
        await waitForCondition(
          () => terminalEventListener !== undefined && entry.opened,
          "legacy runtime subscription",
        );

        if (deliveryOrder === "push-before-rpc") {
          push(firstSnapshot);
          resolveInitialOpen?.(firstSnapshot);
        } else {
          resolveInitialOpen?.(firstSnapshot);
          await waitForCondition(
            () => writes.filter((write) => write === firstSnapshot.history).length === 1,
            "initial RPC legacy replay",
          );
          push(firstSnapshot);
        }
        await waitForCondition(
          () =>
            entry.pendingHistoryReplayPromise === null &&
            writes.filter((write) => write === firstSnapshot.history).length === 1,
          "deduplicated legacy replay",
        );

        // Exercise sequential delivery after the concurrent/order-specific pair.
        push(firstSnapshot);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(writes.filter((write) => write === "\u001bc")).toHaveLength(1);
        expect(writes.filter((write) => write === firstSnapshot.history)).toHaveLength(1);

        push(changedSnapshot);
        await waitForCondition(
          () => writes.filter((write) => write === changedSnapshot.history).length === 1,
          "changed legacy replay",
        );
        expect(writes.filter((write) => write === "\u001bc")).toHaveLength(2);
        expect(writes.filter((write) => write === changedSnapshot.history)).toHaveLength(1);
      } finally {
        entry.terminal.write = originalWrite as Terminal["write"];
        disposeRuntimeEntry(entry);
        restoreWindowNativeApi(previousNativeApi);
        document.getElementById("synara-terminal-parking")?.remove();
      }
    },
  );

  it.each(["resolves", "rejects"] as const)(
    "settles a dispatched ordinary backend resize that %s before recovered-grid staging",
    async (settlementMode) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
      document.body.append(host);
      hosts.push(host);

      let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
      let ordinaryTarget: { cols: number; rows: number } | null = null;
      let resolveOrdinary: (() => void) | undefined;
      let rejectOrdinary: ((error: Error) => void) | undefined;
      const resizeInputs: Array<{ cols: number; rows: number }> = [];
      const order: string[] = [];
      const nativeApi = {
        terminal: {
          waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
          open: async () => legacySnapshot(""),
          write: async () => undefined,
          ackOutput: async () => undefined,
          resize: async (input: { cols: number; rows: number }) => {
            resizeInputs.push({ cols: input.cols, rows: input.rows });
            if (
              ordinaryTarget &&
              input.cols === ordinaryTarget.cols &&
              input.rows === ordinaryTarget.rows
            ) {
              order.push("ordinary-dispatched");
              await new Promise<void>((resolve, reject) => {
                resolveOrdinary = resolve;
                rejectOrdinary = reject;
              });
            }
          },
          clear: async () => undefined,
          restart: async () => legacySnapshot(""),
          close: async () => undefined,
          onEvent: (listener: (event: TerminalEvent) => void) => {
            terminalEventListener = listener;
            return () => {
              if (terminalEventListener === listener) terminalEventListener = undefined;
            };
          },
        },
      } as unknown as NativeApi;
      const previousNativeApi = window.nativeApi;
      window.nativeApi = nativeApi;
      const entry = createRuntimeEntry({
        runtimeKey: `thread::resize-${settlementMode}`,
        threadId: "thread",
        terminalId: `resize-${settlementMode}`,
        terminalLabel: "Terminal",
        cwd: "C:\\project",
        callbacks: {
          onSessionExited: () => undefined,
          onTerminalMetadataChange: () => undefined,
          onTerminalActivityChange: () => undefined,
        },
      });
      const originalFit = entry.fitAddon.fit.bind(entry.fitAddon);
      const originalWrite = entry.terminal.write.bind(entry.terminal);
      const recoverySnapshot = dimensionedSnapshot(
        32,
        8,
        settlementMode === "resolves" ? "7".repeat(64) : "8".repeat(64),
        `RECOVERY-AFTER-ORDINARY-${settlementMode}`,
      );
      entry.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        if (data === recoverySnapshot.history) order.push("history");
        originalWrite(data, callback);
      }) as Terminal["write"];

      try {
        attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
        await waitForCondition(
          () => entry.opened && entry.runtimeStatus === "ready",
          "ordinary-resize runtime open",
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        resizeInputs.length = 0;
        const initialBackend = entry.backendOpenDimensions;
        expect(initialBackend).not.toBeNull();
        if (!initialBackend) throw new Error("missing initial backend dimensions");
        ordinaryTarget = {
          cols: Math.min(initialBackend.cols + 7, 512),
          rows: Math.min(initialBackend.rows + 2, 256),
        };
        const expectedBackend = settlementMode === "resolves" ? ordinaryTarget : initialBackend;
        entry.fitAddon.fit = () => {
          if (!ordinaryTarget) return;
          entry.terminal.resize(ordinaryTarget.cols, ordinaryTarget.rows);
        };
        entry.fitAddon.proposeDimensions = () => expectedBackend;
        window.dispatchEvent(new Event("focus"));
        await waitForCondition(
          () => order.includes("ordinary-dispatched") && entry.backendResizeSettlement !== null,
          "ordinary backend resize dispatch",
        );

        terminalEventListener?.({
          type: "started",
          threadId: "thread",
          terminalId: entry.terminalId,
          createdAt: new Date().toISOString(),
          generation: "generation-1",
          sequence: 1,
          snapshot: recoverySnapshot,
        });
        await waitForCondition(
          () => entry.pendingHistoryReplayPromise !== null,
          "recovery waiting for ordinary resize",
        );
        expect(order).not.toContain("history");

        order.push(`ordinary-${settlementMode}`);
        if (settlementMode === "resolves") {
          resolveOrdinary?.();
        } else {
          rejectOrdinary?.(new Error("ordinary resize rejected"));
        }
        await waitForCondition(
          () => entry.appliedHistoryRecordIdentity === recoverySnapshot.historyRecordIdentity,
          "recovery after ordinary resize settlement",
        );

        expect(entry.backendOpenDimensions).toEqual(expectedBackend);
        expect({ cols: entry.terminal.cols, rows: entry.terminal.rows }).toEqual(expectedBackend);
        expect(entry.backendResizeSettlement).toBeNull();
        expect(resizeInputs).toEqual([ordinaryTarget]);
        expect(order.indexOf(`ordinary-${settlementMode}`)).toBeLessThan(order.indexOf("history"));
      } finally {
        entry.fitAddon.fit = originalFit;
        entry.terminal.write = originalWrite as Terminal["write"];
        disposeRuntimeEntry(entry);
        restoreWindowNativeApi(previousNativeApi);
        document.getElementById("synara-terminal-parking")?.remove();
      }
    },
  );

  it("converges before draining output emitted during the final recovery backend resize", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
    let deferResize = false;
    let resolveResize: (() => void) | undefined;
    const resizeInputs: Array<{ cols: number; rows: number }> = [];
    const acknowledgedBytes: number[] = [];
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
        open: async () => legacySnapshot(""),
        write: async () => undefined,
        ackOutput: async (input: { bytes: number }) => {
          acknowledgedBytes.push(input.bytes);
        },
        resize: async (input: { cols: number; rows: number }) => {
          if (!deferResize) return;
          resizeInputs.push({ cols: input.cols, rows: input.rows });
          await new Promise<void>((resolve) => {
            resolveResize = resolve;
          });
        },
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: (listener: (event: TerminalEvent) => void) => {
          terminalEventListener = listener;
          return () => {
            if (terminalEventListener === listener) terminalEventListener = undefined;
          };
        },
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::final-resize-output",
      threadId: "thread",
      terminalId: "final-resize-output",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });
    const originalWrite = entry.terminal.write.bind(entry.terminal);
    const retainedOutputs = [
      "\r\nLIVE-DURING-FINAL-BEGIN|",
      "x".repeat(TERMINAL_WRITE_BATCH_SIZE_LIMIT),
      "|🙂|LIVE-DURING-FINAL-END",
    ];
    const expectedRetainedOutput = retainedOutputs.join("");
    const retainedWrites: string[] = [];
    const encoder = new TextEncoder();
    let captureRetainedWrites = false;
    let firstRetainedWriteParsed = false;
    let releaseFirstRetainedWriteCallback: (() => void) | undefined;
    entry.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      if (captureRetainedWrites && typeof data === "string") {
        const writeNumber = retainedWrites.push(data);
        originalWrite(data, () => {
          if (writeNumber === 1) {
            firstRetainedWriteParsed = true;
            releaseFirstRetainedWriteCallback = callback;
            return;
          }
          callback?.();
        });
        return;
      }
      originalWrite(data, callback);
    }) as Terminal["write"];
    const snapshot = dimensionedSnapshot(32, 8, "9".repeat(64), "RECOVERED-BEFORE-LIVE");

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(
        () => entry.opened && entry.runtimeStatus === "ready",
        "final-resize runtime open",
      );
      const initialBackend = entry.backendOpenDimensions;
      expect(initialBackend).not.toBeNull();
      if (!initialBackend) throw new Error("missing initial backend dimensions");
      const finalDimensions = {
        cols: Math.min(initialBackend.cols + 5, 512),
        rows: Math.min(initialBackend.rows + 2, 256),
      };
      entry.fitAddon.proposeDimensions = () => finalDimensions;
      deferResize = true;

      terminalEventListener?.({
        type: "started",
        threadId: "thread",
        terminalId: entry.terminalId,
        createdAt: new Date().toISOString(),
        generation: "generation-1",
        sequence: 1,
        snapshot,
      });
      await waitForCondition(() => resizeInputs.length === 1, "final recovery backend resize");
      captureRetainedWrites = true;
      for (const [index, data] of retainedOutputs.entries()) {
        terminalEventListener?.({
          type: "output",
          threadId: "thread",
          terminalId: entry.terminalId,
          createdAt: new Date().toISOString(),
          generation: "generation-1",
          sequence: index + 2,
          data,
          byteLength: encoder.encode(data).byteLength,
        });
      }
      resolveResize?.();

      await waitForCondition(
        () => firstRetainedWriteParsed,
        "xterm parser held after first retained write",
      );
      expect(entry.pendingHistoryReplayPromise).not.toBeNull();
      expect(retainedWrites).toHaveLength(1);
      releaseFirstRetainedWriteCallback?.();

      await waitForCondition(
        () =>
          entry.pendingHistoryReplayPromise === null &&
          acknowledgedBytes.reduce((total, bytes) => total + bytes, 0) ===
            encoder.encode(expectedRetainedOutput).byteLength,
        "batched live output after final resize",
        10_000,
      );
      const text = bufferText(entry.terminal);
      expect(entry.backendOpenDimensions).toEqual(finalDimensions);
      expect({ cols: entry.terminal.cols, rows: entry.terminal.rows }).toEqual(finalDimensions);
      expect(entry.appliedHistoryRecordIdentity).toBeNull();
      expect(retainedWrites.length).toBeGreaterThan(1);
      expect(
        retainedWrites.every(
          (write) => encoder.encode(write).byteLength <= TERMINAL_WRITE_BATCH_SIZE_LIMIT,
        ),
      ).toBe(true);
      expect(retainedWrites.join("")).toBe(expectedRetainedOutput);
      expect(text.split("LIVE-DURING-FINAL-END")).toHaveLength(2);
      expect(resizeInputs).toEqual([finalDimensions]);
      expect(acknowledgedBytes).toEqual(
        retainedWrites.map((write) => encoder.encode(write).byteLength),
      );
    } finally {
      entry.terminal.write = originalWrite as Terminal["write"];
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it("applies a clear received at the staged grid before releasing post-clear output", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
    document.body.append(host);
    hosts.push(host);

    let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
    const acknowledgedBytes: number[] = [];
    const nativeApi = {
      terminal: {
        waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
        open: async () => legacySnapshot(""),
        write: async () => undefined,
        ackOutput: async (input: { bytes: number }) => {
          acknowledgedBytes.push(input.bytes);
        },
        resize: async () => undefined,
        clear: async () => undefined,
        restart: async () => legacySnapshot(""),
        close: async () => undefined,
        onEvent: (listener: (event: TerminalEvent) => void) => {
          terminalEventListener = listener;
          return () => {
            if (terminalEventListener === listener) terminalEventListener = undefined;
          };
        },
      },
    } as unknown as NativeApi;
    const previousNativeApi = window.nativeApi;
    window.nativeApi = nativeApi;
    const entry = createRuntimeEntry({
      runtimeKey: "thread::clear-during-replay",
      threadId: "thread",
      terminalId: "clear-during-replay",
      terminalLabel: "Terminal",
      cwd: "C:\\project",
      callbacks: {
        onSessionExited: () => undefined,
        onTerminalMetadataChange: () => undefined,
        onTerminalActivityChange: () => undefined,
      },
    });
    const originalWrite = entry.terminal.write.bind(entry.terminal);
    const snapshot = dimensionedSnapshot(32, 8, "a".repeat(64), "CLEARED-HISTORY");

    try {
      attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
      await waitForCondition(
        () => entry.opened && entry.runtimeStatus === "ready",
        "clear-during-replay runtime open",
      );
      const backendOpenDimensions = entry.backendOpenDimensions;
      expect(backendOpenDimensions).not.toBeNull();
      if (!backendOpenDimensions) throw new Error("missing backend dimensions");
      entry.fitAddon.proposeDimensions = () => backendOpenDimensions;
      entry.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        if (data !== snapshot.history) {
          originalWrite(data, callback);
          return;
        }
        originalWrite(data, () => {
          terminalEventListener?.({
            type: "output",
            threadId: "thread",
            terminalId: entry.terminalId,
            createdAt: new Date().toISOString(),
            generation: "generation-1",
            sequence: 2,
            data: "PRE-CLEAR",
            byteLength: 9,
          });
          terminalEventListener?.({
            type: "cleared",
            threadId: "thread",
            terminalId: entry.terminalId,
            createdAt: new Date().toISOString(),
            generation: "generation-1",
            sequence: 3,
          });
          terminalEventListener?.({
            type: "output",
            threadId: "thread",
            terminalId: entry.terminalId,
            createdAt: new Date().toISOString(),
            generation: "generation-1",
            sequence: 4,
            data: "POST-CLEAR",
            byteLength: 10,
          });
          callback?.();
        });
      }) as Terminal["write"];

      terminalEventListener?.({
        type: "started",
        threadId: "thread",
        terminalId: entry.terminalId,
        createdAt: new Date().toISOString(),
        generation: "generation-1",
        sequence: 1,
        snapshot,
      });
      await waitForCondition(
        () =>
          entry.pendingHistoryReplayPromise === null &&
          entry.pendingWriteBytes === 0 &&
          acknowledgedBytes.includes(10),
        "clear during recovered-grid replay",
      );

      const text = bufferText(entry.terminal);
      expect(text).not.toContain("CLEARED-HISTORY");
      expect(text).not.toContain("PRE-CLEAR");
      expect(text.split("POST-CLEAR")).toHaveLength(2);
      expect({ cols: entry.terminal.cols, rows: entry.terminal.rows }).toEqual(
        backendOpenDimensions,
      );
      expect(entry.appliedHistoryRecordIdentity).toBeNull();
      expect(acknowledgedBytes).toEqual([9, 10]);
    } finally {
      entry.terminal.write = originalWrite as Terminal["write"];
      disposeRuntimeEntry(entry);
      restoreWindowNativeApi(previousNativeApi);
      document.getElementById("synara-terminal-parking")?.remove();
    }
  });

  it.each(["clear", "dispose"] as const)(
    "bounds retained-output ACKs when an unsafe replay is released by %s",
    async (releaseMode) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:320px;display:block;";
      document.body.append(host);
      hosts.push(host);

      let terminalEventListener: ((event: TerminalEvent) => void) | undefined;
      const acknowledgedBytes: number[] = [];
      const nativeApi = {
        terminal: {
          waitUntilEventStreamReady: waitUntilTerminalEventStreamReady,
          open: async () => legacySnapshot(""),
          write: async () => undefined,
          ackOutput: async (input: { bytes: number }) => {
            acknowledgedBytes.push(input.bytes);
          },
          resize: async () => undefined,
          clear: async () => undefined,
          restart: async () => legacySnapshot(""),
          close: async () => undefined,
          onEvent: (listener: (event: TerminalEvent) => void) => {
            terminalEventListener = listener;
            return () => {
              if (terminalEventListener === listener) terminalEventListener = undefined;
            };
          },
        },
      } as unknown as NativeApi;
      const previousNativeApi = window.nativeApi;
      window.nativeApi = nativeApi;
      const entry = createRuntimeEntry({
        runtimeKey: `thread::ack-${releaseMode}`,
        threadId: "thread",
        terminalId: `ack-${releaseMode}`,
        terminalLabel: "Terminal",
        cwd: "C:\\project",
        callbacks: {
          onSessionExited: () => undefined,
          onTerminalMetadataChange: () => undefined,
          onTerminalActivityChange: () => undefined,
        },
      });
      const originalResize = entry.terminal.resize.bind(entry.terminal);
      let rejectFallback = true;
      let disposed = false;

      try {
        attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
        await waitForCondition(
          () => entry.opened && entry.runtimeStatus === "ready",
          "chunked-ack runtime open",
        );
        const backendOpenDimensions = entry.backendOpenDimensions;
        expect(backendOpenDimensions).not.toBeNull();
        if (!backendOpenDimensions) throw new Error("missing backend dimensions");
        entry.fitAddon.proposeDimensions = () => undefined;
        entry.terminal.resize = ((cols: number, rows: number) => {
          if (
            rejectFallback &&
            cols === backendOpenDimensions.cols &&
            rows === backendOpenDimensions.rows
          ) {
            return;
          }
          originalResize(cols, rows);
        }) as Terminal["resize"];

        terminalEventListener?.({
          type: "started",
          threadId: "thread",
          terminalId: entry.terminalId,
          createdAt: new Date().toISOString(),
          generation: "generation-1",
          sequence: 1,
          snapshot: dimensionedSnapshot(32, 8, "b".repeat(64), "UNSAFE-HISTORY"),
        });
        await waitForCondition(
          () => entry.runtimeStatus === "error" && entry.pendingHistoryReplayPromise === null,
          "unsafe replay retention",
        );
        const retainedByteTotal = 8_388_608 * 2 + 17;
        terminalEventListener?.({
          type: "output",
          threadId: "thread",
          terminalId: entry.terminalId,
          createdAt: new Date().toISOString(),
          generation: "generation-1",
          sequence: 2,
          data: "HELD-LARGE-OUTPUT",
          byteLength: retainedByteTotal,
        });

        rejectFallback = false;
        if (releaseMode === "clear") {
          terminalEventListener?.({
            type: "cleared",
            threadId: "thread",
            terminalId: entry.terminalId,
            createdAt: new Date().toISOString(),
            generation: "generation-1",
            sequence: 3,
          });
          await waitForCondition(() => entry.runtimeStatus === "ready", "unsafe replay clear");
        } else {
          disposeRuntimeEntry(entry);
          disposed = true;
        }

        const expectedAcknowledgements =
          releaseMode === "clear" ? [8_388_608, 8_388_608, 17] : [8_388_608];
        await waitForCondition(
          () => acknowledgedBytes.length === expectedAcknowledgements.length,
          "serialized retained output ACKs",
        );
        expect(acknowledgedBytes).toEqual(expectedAcknowledgements);
        expect(acknowledgedBytes.every((bytes) => bytes <= 8_388_608)).toBe(true);
        expect(acknowledgedBytes.reduce((total, bytes) => total + bytes, 0)).toBe(
          releaseMode === "clear" ? retainedByteTotal : 8_388_608,
        );
      } finally {
        entry.terminal.resize = originalResize as Terminal["resize"];
        if (!disposed) disposeRuntimeEntry(entry);
        restoreWindowNativeApi(previousNativeApi);
        document.getElementById("synara-terminal-parking")?.remove();
      }
    },
  );
});
