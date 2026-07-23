import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { ThreadId, type ServerVoiceTranscriptionInput } from "@synara/contracts";
import type { OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import {
  requestDesktopVoiceTranscription,
  transcribeVoiceViaDesktopBridge,
} from "./voiceTranscription";

const audioBuffer = Buffer.from("RIFF0000WAVE", "ascii");
const request: ServerVoiceTranscriptionInput = {
  provider: "codex",
  cwd: "C:\\projects\\synara",
  threadId: ThreadId.makeUnsafe("thread-1"),
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 250,
  audioBase64: audioBuffer.toString("base64"),
};
const backend = {
  baseUrl: "http://127.0.0.1:43123",
  authToken: "desktop-startup-token",
};
const successResponse: OutboundHttpResponse = {
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({ text: "hello" })),
  url: "http://127.0.0.1:43123/api/voice/transcribe",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop voice managed backend bridge", () => {
  it("uses the exact bounded loopback upload route and private startup token", async () => {
    const send = vi.fn().mockResolvedValue(successResponse);

    await requestDesktopVoiceTranscription({
      audioBuffer,
      request,
      backend,
      dependencies: { request: send },
    });

    const outbound = send.mock.calls[0]?.[0];
    const url = new URL(String(outbound.url));
    expect(url.origin).toBe(backend.baseUrl);
    expect(url.pathname).toBe("/api/voice/transcribe");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: "codex",
      cwd: "C:\\projects\\synara",
      mimeType: "audio/wav",
      sampleRateHz: "24000",
      durationMs: "250",
      threadId: "thread-1",
      token: "desktop-startup-token",
    });
    expect(outbound.timeoutMs).toBe(45_000);
    expect(outbound.audioBuffer).toEqual(audioBuffer);
  });

  it("rejects non-loopback backends before forwarding audio or credentials", async () => {
    const send = vi.fn();

    await expect(
      requestDesktopVoiceTranscription({
        audioBuffer,
        request,
        backend: {
          baseUrl: "https://attacker.example",
          authToken: "desktop-startup-token",
        },
        dependencies: { request: send },
      }),
    ).rejects.toThrow("private loopback backend");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the Electron main event loop responsive while transcription is pending", async () => {
    let heartbeatFired = false;
    const transcription = transcribeVoiceViaDesktopBridge(request, backend, {
      request: vi.fn(
        () =>
          new Promise<OutboundHttpResponse>((resolve) => {
            setTimeout(() => resolve(successResponse), 20);
          }),
      ),
    });
    setTimeout(() => {
      heartbeatFired = true;
    }, 0);

    await expect(transcription).resolves.toEqual({ text: "hello" });
    expect(heartbeatFired).toBe(true);
  });

  it("aborts a stalled managed-backend request at the configured deadline", async () => {
    const server = createServer(() => {
      // Deliberately leave the response pending so the shared transport owns the deadline.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server address.");
    }

    try {
      const failure = await requestDesktopVoiceTranscription({
        audioBuffer,
        request,
        backend: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          authToken: "desktop-startup-token",
        },
        dependencies: { timeoutMs: 20 },
      }).catch((cause: unknown) => cause);

      expect(failure).toMatchObject({
        code: "timeout",
        message: "Managed voice request exceeded its 20ms deadline.",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("contains no independent Codex, cmd.exe, or root-kill process harness", () => {
    const source = readFileSync(new URL("./voiceTranscription.ts", import.meta.url), "utf8");

    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("resolveCodexCliExecutable");
    expect(source).not.toContain("prepareResolvedWindowsSafeProcess");
    expect(source).not.toContain("cmd.exe");
    expect(source).not.toContain('"app-server"');
    expect(source).not.toContain("child.kill");
    expect(source).toContain("VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH");
  });
});
