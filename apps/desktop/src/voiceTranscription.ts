// FILE: voiceTranscription.ts
// Purpose: Owns the desktop-specific voice transcription flow for Electron builds.
// Layer: Desktop IPC + managed backend bridge
// Depends on: The managed local backend, bounded loopback transport, and the shared voice contract.

import * as Http from "node:http";

import { ipcMain } from "electron";
import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";
import { VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";
import {
  decodeOutboundJson,
  decodeOutboundText,
  type OutboundHttpResponse,
} from "@synara/shared/outboundHttp";
import { SERVER_TRANSCRIBE_VOICE_CHANNEL } from "./ipcChannels";

const MAX_VOICE_DURATION_MS = 120_000;
const DESKTOP_VOICE_BACKEND_TIMEOUT_MS = 45_000;
const DESKTOP_VOICE_BACKEND_MAX_RESPONSE_BYTES = 1024 * 1024;

// --- Input validation ------------------------------------------------------

function normalizeVoiceBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyVoiceBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isLikelyWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function decodeDesktopVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_VOICE_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  const normalizedBase64 = normalizeVoiceBase64(input.audioBase64);
  if (!normalizedBase64 || !isLikelyVoiceBase64(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  if (!isLikelyWavBuffer(audioBuffer)) {
    throw new Error("The recorded audio is not a valid WAV file.");
  }

  return audioBuffer;
}

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

// --- Managed backend bridge -----------------------------------------------

export interface DesktopVoiceBackendConnection {
  readonly baseUrl: string;
  readonly authToken: string;
}

interface DesktopVoiceBackendHttpRequest {
  readonly url: URL;
  readonly audioBuffer: Buffer;
  readonly timeoutMs: number;
}

type RequestDesktopVoiceBackend = (
  input: DesktopVoiceBackendHttpRequest,
) => Promise<OutboundHttpResponse>;

interface DesktopVoiceBackendRequestDependencies {
  readonly request?: RequestDesktopVoiceBackend | undefined;
  readonly timeoutMs?: number | undefined;
}

type DesktopVoiceBackendRequestErrorCode = "request" | "response-too-large" | "timeout";

class DesktopVoiceBackendRequestError extends Error {
  constructor(
    readonly code: DesktopVoiceBackendRequestErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DesktopVoiceBackendRequestError";
  }
}

function responseHeaders(headers: Http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

function requestManagedDesktopVoiceBackend(
  input: DesktopVoiceBackendHttpRequest,
): Promise<OutboundHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: Http.ClientRequest | null = null;
    let response: Http.IncomingMessage | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (deadline) {
        clearTimeout(deadline);
        deadline = null;
      }
    };
    const rejectOnce = (error: DesktopVoiceBackendRequestError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      reject(error);
    };
    const resolveOnce = (value: OutboundHttpResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    deadline = setTimeout(() => {
      rejectOnce(
        new DesktopVoiceBackendRequestError(
          "timeout",
          `Managed voice request exceeded its ${input.timeoutMs}ms deadline.`,
        ),
      );
    }, input.timeoutMs);
    deadline.unref();

    try {
      request = Http.request(
        input.url,
        {
          method: "POST",
          agent: false,
          headers: {
            "Content-Length": String(input.audioBuffer.byteLength),
            "Content-Type": "application/octet-stream",
          },
        },
        (incoming) => {
          response = incoming;
          const declaredLength = Number(incoming.headers["content-length"] ?? "0");
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > DESKTOP_VOICE_BACKEND_MAX_RESPONSE_BYTES
          ) {
            rejectOnce(
              new DesktopVoiceBackendRequestError(
                "response-too-large",
                "Managed voice response exceeded the 1 MB limit.",
              ),
            );
            return;
          }

          const chunks: Buffer[] = [];
          let responseBytes = 0;
          incoming.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (bytes.byteLength > DESKTOP_VOICE_BACKEND_MAX_RESPONSE_BYTES - responseBytes) {
              rejectOnce(
                new DesktopVoiceBackendRequestError(
                  "response-too-large",
                  "Managed voice response exceeded the 1 MB limit.",
                ),
              );
              return;
            }
            responseBytes += bytes.byteLength;
            chunks.push(bytes);
          });
          incoming.once("aborted", () => {
            rejectOnce(
              new DesktopVoiceBackendRequestError(
                "request",
                "Managed voice response ended before completion.",
              ),
            );
          });
          incoming.once("error", (cause) => {
            rejectOnce(
              new DesktopVoiceBackendRequestError(
                "request",
                "Managed voice response could not be read.",
                cause,
              ),
            );
          });
          incoming.once("end", () => {
            resolveOnce({
              status: incoming.statusCode ?? 0,
              headers: responseHeaders(incoming.headers),
              body: Buffer.concat(chunks, responseBytes),
              url: input.url.toString(),
            });
          });
        },
      );
      request.once("error", (cause) => {
        rejectOnce(
          new DesktopVoiceBackendRequestError(
            "request",
            "Could not reach Synara's managed voice backend.",
            cause,
          ),
        );
      });
      request.end(input.audioBuffer);
    } catch (cause) {
      rejectOnce(
        new DesktopVoiceBackendRequestError(
          "request",
          "Could not start Synara's managed voice request.",
          cause,
        ),
      );
    }
  });
}

function resolveDesktopVoiceBackendUrl(input: {
  readonly backend: DesktopVoiceBackendConnection;
  readonly request: ServerVoiceTranscriptionInput;
}): URL {
  const baseUrl = readNonEmptyString(input.backend.baseUrl);
  const authToken = readNonEmptyString(input.backend.authToken);
  if (!baseUrl || !authToken) {
    throw new Error("The managed Synara backend is not ready for voice transcription.");
  }

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("The managed Synara backend URL is invalid.");
  }
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "::1"].includes(base.hostname) ||
    base.username.length > 0 ||
    base.password.length > 0
  ) {
    throw new Error("Voice transcription requires Synara's private loopback backend.");
  }

  const url = new URL(VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH, `${base.origin}/`);
  url.searchParams.set("provider", input.request.provider);
  url.searchParams.set("cwd", input.request.cwd?.trim() || process.cwd());
  url.searchParams.set("mimeType", input.request.mimeType);
  url.searchParams.set("sampleRateHz", String(input.request.sampleRateHz));
  url.searchParams.set("durationMs", String(input.request.durationMs));
  if (input.request.threadId) {
    url.searchParams.set("threadId", input.request.threadId);
  }
  url.searchParams.set("token", authToken);
  return url;
}

export async function requestDesktopVoiceTranscription(input: {
  readonly audioBuffer: Buffer;
  readonly request: ServerVoiceTranscriptionInput;
  readonly backend: DesktopVoiceBackendConnection;
  readonly dependencies?: DesktopVoiceBackendRequestDependencies | undefined;
}): Promise<OutboundHttpResponse> {
  if (
    input.audioBuffer.byteLength <= 0 ||
    input.audioBuffer.byteLength > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES
  ) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  const url = resolveDesktopVoiceBackendUrl({
    backend: input.backend,
    request: input.request,
  });
  const timeoutMs =
    typeof input.dependencies?.timeoutMs === "number" &&
    Number.isFinite(input.dependencies.timeoutMs) &&
    input.dependencies.timeoutMs > 0
      ? input.dependencies.timeoutMs
      : DESKTOP_VOICE_BACKEND_TIMEOUT_MS;
  return (input.dependencies?.request ?? requestManagedDesktopVoiceBackend)({
    url,
    audioBuffer: input.audioBuffer,
    timeoutMs,
  });
}

function readVoiceResponseErrorMessage(statusCode: number, body: string): string {
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const providerMessage =
      readNonEmptyString(payload.error?.message) ?? readNonEmptyString(payload.message);
    if (providerMessage) {
      return providerMessage;
    }
  } catch {
    // Fall back to a status-based message when the upstream body is not JSON.
  }

  if (statusCode === 401) {
    return "Synara's managed backend rejected the voice request. Restart Synara and try again.";
  }
  if (statusCode === 403) {
    return "Synara's managed backend refused the voice request.";
  }

  return `Transcription failed with status ${statusCode}.`;
}

// --- IPC entrypoint --------------------------------------------------------

export async function transcribeVoiceViaDesktopBridge(
  input: ServerVoiceTranscriptionInput,
  backend: DesktopVoiceBackendConnection,
  dependencies?: DesktopVoiceBackendRequestDependencies,
): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeDesktopVoiceAudio(input);
  const response = await requestDesktopVoiceTranscription({
    audioBuffer,
    request: input,
    backend,
    ...(dependencies ? { dependencies } : {}),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(readVoiceResponseErrorMessage(response.status, decodeOutboundText(response)));
  }

  const payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
    text?: unknown;
    transcript?: unknown;
  };
  const text = readNonEmptyString(payload.text) ?? readNonEmptyString(payload.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

export function registerDesktopVoiceTranscriptionHandler(
  resolveBackend: () => DesktopVoiceBackendConnection,
): void {
  ipcMain.removeHandler(SERVER_TRANSCRIBE_VOICE_CHANNEL);
  ipcMain.handle(
    SERVER_TRANSCRIBE_VOICE_CHANNEL,
    async (_event, input: ServerVoiceTranscriptionInput) =>
      transcribeVoiceViaDesktopBridge(input, resolveBackend()),
  );
}
