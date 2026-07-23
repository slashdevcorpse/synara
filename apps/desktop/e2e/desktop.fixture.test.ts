// FILE: desktop.fixture.test.ts
// Purpose: Verifies the packaged desktop fixture's fake-Codex-only PATH boundary.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { createRequire } from "node:module";
import { parseCanonicalWindowsNpmNodeShim } from "@synara/shared/windowsNpmShim";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFakeCodexIsOnlyPathCandidate,
  isolatedExecutablePath,
  isolatedElectronEnv,
  parseDiagnosticJsonLines,
  windowsFakeCodexLauncherContents,
} from "./desktop.fixture";
import desktopPlaywrightConfig from "./playwright.config";
import {
  clearFailureDiagnosticsAttempt,
  clearFailureDiagnosticsRoot,
  createDesktopE2eFailureSummary,
  desktopFailureDiagnosticsRoot,
  writeDesktopE2eFailureSummary,
  type DesktopE2eFailureSummary,
} from "./support/failureDiagnostics";

const requireFromTest = createRequire(__filename);
const { appendRedactedJsonLine, redactDiagnosticText } = requireFromTest(
  "./fixtures/diagnostic-redaction.cjs",
) as {
  readonly appendRedactedJsonLine: (filePath: string, value: unknown) => void;
  readonly redactDiagnosticText: (value: unknown) => string;
};
const { isLoopbackHost, normalizeHost } = requireFromTest("./fixtures/loopback.cjs") as {
  readonly isLoopbackHost: (host: unknown) => boolean;
  readonly normalizeHost: (host: unknown) => string;
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      FS.promises.rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("desktop fixture executable PATH isolation", () => {
  it("models the Windows fake Codex launcher as a canonical npm Node shim", () => {
    expect(parseCanonicalWindowsNpmNodeShim(windowsFakeCodexLauncherContents())).toBe(
      "node_modules/@synara/desktop-e2e/fake-codex-runtime.mjs",
    );
  });

  it("removes a quoted directory that exposes a non-fixture Codex executable", async () => {
    const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-e2e-path-"));
    temporaryRoots.push(root);
    const fakeDirectory = Path.join(root, "fake codex");
    const inheritedDirectory = Path.join(root, "real codex");
    const safeDirectory = Path.join(root, "safe tools");
    await Promise.all(
      [fakeDirectory, inheritedDirectory, safeDirectory].map((directory) =>
        FS.promises.mkdir(directory, { recursive: true }),
      ),
    );
    const executableName = process.platform === "win32" ? "codex.cmd" : "codex";
    const fakeCodexPath = Path.join(fakeDirectory, executableName);
    await Promise.all([
      FS.promises.writeFile(fakeCodexPath, "fixture", "utf8"),
      FS.promises.writeFile(Path.join(inheritedDirectory, executableName), "real", "utf8"),
    ]);

    const isolatedPath = isolatedExecutablePath(
      fakeDirectory,
      [`"${inheritedDirectory}"`, `"${safeDirectory}"`].join(Path.delimiter),
    );

    expect(isolatedPath.split(Path.delimiter)).toEqual([fakeDirectory, safeDirectory]);
    expect(assertFakeCodexIsOnlyPathCandidate(isolatedPath, fakeCodexPath)).toEqual([
      fakeCodexPath,
    ]);
  });

  it("does not use Vitest or inherited fake-provider variables as a production child switch", async () => {
    const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-e2e-env-"));
    temporaryRoots.push(root);
    const fakeDirectory = Path.join(root, "fake-codex");
    await FS.promises.mkdir(fakeDirectory, { recursive: true });
    const fakeCodexPath = Path.join(
      fakeDirectory,
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    await FS.promises.writeFile(fakeCodexPath, "fixture", {
      encoding: "utf8",
      mode: 0o755,
    });
    const previousVitest = process.env.VITEST;
    const previousFakeValue = process.env.SYNARA_FAKE_CODEX_PROTOCOL_LOG_PATH;
    process.env.VITEST = "1";
    process.env.SYNARA_FAKE_CODEX_PROTOCOL_LOG_PATH = "inherited-test-secret";
    try {
      const env = isolatedElectronEnv({
        desktopMainPath: Path.join(root, "main.js"),
        fakeCodexPath,
        homeDir: Path.join(root, "home"),
        invocationLogPath: Path.join(root, "invocations.jsonl"),
        networkGuardPath: Path.join(root, "network-guard.cjs"),
        networkLogPath: Path.join(root, "network.jsonl"),
        profileDir: Path.join(root, "profile"),
        protocolLogPath: Path.join(root, "protocol.jsonl"),
        runtimeDir: Path.join(root, "runtime"),
        workspaceDir: Path.join(root, "workspace"),
      });

      expect(env.VITEST).toBeUndefined();
      expect(Object.keys(env).some((key) => key.startsWith("SYNARA_FAKE_"))).toBe(false);
    } finally {
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousFakeValue === undefined) delete process.env.SYNARA_FAKE_CODEX_PROTOCOL_LOG_PATH;
      else process.env.SYNARA_FAKE_CODEX_PROTOCOL_LOG_PATH = previousFakeValue;
    }
  });
});

describe("desktop fixture diagnostic redaction", () => {
  it("marks every malformed or non-object JSON line and continues parsing later records", () => {
    expect(parseDiagnosticJsonLines('{"first":1}\nmalformed\n{"last":2}\n{"partial":')).toEqual([
      { first: 1 },
      { fixtureMalformedJsonLine: true, lineNumber: 2 },
      { last: 2 },
      { fixtureMalformedJsonLine: true, lineNumber: 4 },
    ]);
    expect(parseDiagnosticJsonLines('{"first":1}\nnull\n42\n')).toEqual([
      { first: 1 },
      { fixtureMalformedJsonLine: true, lineNumber: 2 },
      { fixtureMalformedJsonLine: true, lineNumber: 3 },
    ]);
  });

  it("clears stale diagnostics for the same test attempt before launch setup", async () => {
    const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-e2e-stale-"));
    temporaryRoots.push(root);
    const failureRoot = desktopFailureDiagnosticsRoot(root);
    const attemptDirectory = Path.join(failureRoot, "journey-worker-0-retry-0");
    const stalePath = Path.join(attemptDirectory, "protocol-summary.jsonl");
    await FS.promises.mkdir(attemptDirectory, { recursive: true });
    await FS.promises.writeFile(stalePath, "stale diagnostic", "utf8");

    await clearFailureDiagnosticsAttempt(root, attemptDirectory);

    await expect(FS.promises.stat(attemptDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears every stale run artifact while preserving adjacent desktop files", async () => {
    const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-e2e-run-start-"));
    temporaryRoots.push(root);
    const failureRoot = desktopFailureDiagnosticsRoot(root);
    const adjacentSentinel = Path.join(root, "apps/desktop/keep.txt");
    await Promise.all([
      FS.promises.mkdir(Path.join(failureRoot, "old-test-worker-0-retry-0"), {
        recursive: true,
      }),
      FS.promises.mkdir(Path.join(failureRoot, "renamed-test-worker-0-retry-1"), {
        recursive: true,
      }),
      FS.promises.mkdir(Path.dirname(adjacentSentinel), { recursive: true }),
    ]);
    await Promise.all([
      FS.promises.writeFile(
        Path.join(failureRoot, "old-test-worker-0-retry-0/failure-summary.json"),
        "{}",
      ),
      FS.promises.writeFile(
        Path.join(failureRoot, "renamed-test-worker-0-retry-1/failure-summary.json"),
        "{}",
      ),
      FS.promises.writeFile(adjacentSentinel, "keep", "utf8"),
    ]);

    await clearFailureDiagnosticsRoot(root, failureRoot);

    await expect(FS.promises.stat(failureRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(FS.promises.readFile(adjacentSentinel, "utf8")).resolves.toBe("keep");
  });

  it("never persists URL credentials or bearer query values", async () => {
    const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-e2e-redaction-"));
    temporaryRoots.push(root);
    const logPath = Path.join(root, "network.jsonl");
    const secret = "fixture-bearer-secret";

    appendRedactedJsonLine(logPath, {
      event: "request-completed",
      url: `ws://user:password@127.0.0.1:58090/ws?token=${secret}&revision=3`,
      nested: {
        url: `http://127.0.0.1:58090/favicon?cwd=private&access_token=${secret}`,
      },
      args: [`--endpoint=https://127.0.0.1:58090/status?auth_token=${secret}`],
    });
    const rendererDiagnostic = redactDiagnosticText(
      `[renderer:error] WebSocket connection to 'ws://127.0.0.1:58090/ws?token=${secret}' failed`,
    );
    const persisted = await FS.promises.readFile(logPath, "utf8");

    expect(`${persisted}\n${rendererDiagnostic}`).not.toContain(secret);
    expect(JSON.parse(persisted)).toEqual({
      event: "request-completed",
      url: "ws://127.0.0.1:58090/ws",
      nested: { url: "http://127.0.0.1:58090/favicon" },
      args: ["--endpoint=https://127.0.0.1:58090/status"],
    });
    expect(rendererDiagnostic).toBe(
      "[renderer:error] WebSocket connection to 'ws://127.0.0.1:58090/ws' failed",
    );
    const oauthDiagnostic = redactDiagnosticText(
      `oauth?client_secret=${secret}&code=${secret}&state=${secret}&refresh_token=${secret}&id_token=${secret}&csrf_token=${secret}&api_token=${secret}&session=${secret}`,
    );
    expect(oauthDiagnostic).not.toContain(secret);
  });

  it("publishes exactly one closed-schema JSON summary with no free-form content", async () => {
    const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-e2e-publish-"));
    temporaryRoots.push(root);
    const summary = createDesktopE2eFailureSummary({
      status: "failed",
      expectedStatus: "passed",
      forced: false,
      validationErrorCount: 2,
    });

    const destinationPath = await writeDesktopE2eFailureSummary(root, "journey-1", summary);
    const failureRoot = desktopFailureDiagnosticsRoot(root);
    const published = JSON.parse(await FS.promises.readFile(destinationPath, "utf8"));

    expect(destinationPath).toBe(Path.join(failureRoot, "journey-1", "failure-summary.json"));
    expect(published).toEqual(summary);
    expect(await FS.promises.readdir(failureRoot)).toEqual(["journey-1"]);
    expect(await FS.promises.readdir(Path.dirname(destinationPath))).toEqual([
      "failure-summary.json",
    ]);
  });

  it("rejects free-form summary fields, invalid counts, and escaped attempt paths", async () => {
    const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-e2e-reject-"));
    temporaryRoots.push(root);
    const summary = createDesktopE2eFailureSummary({
      status: "failed",
      expectedStatus: "passed",
      forced: false,
      validationErrorCount: 1,
    });
    const withContent = {
      ...summary,
      detail: "private user content without a recognized label",
      relativePath: "workspace/private/secret.txt",
    } as DesktopE2eFailureSummary;

    await expect(writeDesktopE2eFailureSummary(root, "journey-1", withContent)).rejects.toThrow(
      "closed schema fields",
    );
    const coercibleStatus = {
      ...summary,
      status: {
        detail: "private user content",
        toString: () => "failed",
      },
    } as unknown as DesktopE2eFailureSummary;
    await expect(writeDesktopE2eFailureSummary(root, "journey-1", coercibleStatus)).rejects.toThrow(
      "invalid closed-schema value",
    );
    await expect(FS.promises.stat(desktopFailureDiagnosticsRoot(root))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      writeDesktopE2eFailureSummary(root, "journey-1", {
        ...summary,
        validationErrorCount: Number.NaN,
      }),
    ).rejects.toThrow("invalid closed-schema value");
    await expect(writeDesktopE2eFailureSummary(root, "../escaped", summary)).rejects.toThrow(
      "Invalid desktop E2E failure diagnostics attempt",
    );

    const hiddenToJson = { ...summary };
    Object.defineProperty(hiddenToJson, "toJSON", {
      value: () => ({ detail: "private user content" }),
    });
    const canonicalPath = await writeDesktopE2eFailureSummary(root, "journey-2", hiddenToJson);
    const canonicalText = await FS.promises.readFile(canonicalPath, "utf8");
    expect(canonicalText).not.toContain("private user content");
    expect(JSON.parse(canonicalText)).toEqual(summary);

    let statusReads = 0;
    const changingGetter = { ...summary } as Record<string, unknown>;
    Object.defineProperty(changingGetter, "status", {
      enumerable: true,
      get: () => {
        statusReads += 1;
        return statusReads === 1 ? "failed" : { detail: "private user content" };
      },
    });
    const getterPath = await writeDesktopE2eFailureSummary(
      root,
      "journey-3",
      changingGetter as unknown as DesktopE2eFailureSummary,
    );
    const getterText = await FS.promises.readFile(getterPath, "utf8");
    expect(statusReads).toBe(1);
    expect(getterText).not.toContain("private user content");
    expect(JSON.parse(getterText)).toEqual(summary);
  });
});

describe("desktop fixture loopback policy", () => {
  it("uses one normalization and loopback decision for Node and Chromium guards", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    for (const host of [
      undefined,
      "localhost.",
      "127.0.0.1",
      "127.42.0.9",
      "::1",
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "0:0::1",
      "::0:1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:127.42.0.9",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["example.test", "128.0.0.1", "::ffff:128.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("desktop Playwright diagnostic policy", () => {
  it("disables retained output, traces, screenshots, videos, and HTML reports", () => {
    expect(desktopPlaywrightConfig.preserveOutput).toBe("never");
    expect(desktopPlaywrightConfig.reporter).toEqual([["line"]]);
    expect(desktopPlaywrightConfig.use).toMatchObject({
      trace: "off",
      screenshot: "off",
      video: "off",
    });
    expect(JSON.stringify(desktopPlaywrightConfig)).not.toContain("playwright-report");
  });
});
