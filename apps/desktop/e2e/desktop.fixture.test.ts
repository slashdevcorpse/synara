// FILE: desktop.fixture.test.ts
// Purpose: Verifies the packaged desktop fixture's fake-Codex-only PATH boundary.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { assertFakeCodexIsOnlyPathCandidate, isolatedExecutablePath } from "./desktop.fixture";

const requireFromTest = createRequire(__filename);
const { appendRedactedJsonLine, redactDiagnosticText } = requireFromTest(
  "./fixtures/diagnostic-redaction.cjs",
) as {
  readonly appendRedactedJsonLine: (filePath: string, value: unknown) => void;
  readonly redactDiagnosticText: (value: unknown) => string;
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
});

describe("desktop fixture diagnostic redaction", () => {
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
  });
});
