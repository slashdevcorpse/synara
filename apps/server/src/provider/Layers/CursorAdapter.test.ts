// FILE: CursorAdapter.test.ts
// Purpose: Verifies Cursor-specific model discovery process preparation.
// Layer: Provider adapter tests
// Depends on: CursorAdapter model-list process helper.

import { describe, expect, it } from "vitest";

import { makeCursorModelListChildProcess } from "./CursorAdapter.ts";

describe("CursorAdapter model discovery", () => {
  it("forwards prepared Windows model-list spawn options", () => {
    const env = { SYNARA_TEST: "cursor-model-list" };
    const command = makeCursorModelListChildProcess(
      {
        command: "C:\\tools\\synara-windows-job-launcher.exe",
        args: ["--", "C:\\tools\\cursor-agent.exe", "models"],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
      env,
    );

    expect(command.options).toMatchObject({
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });
});
