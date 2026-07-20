// FILE: confirmedCustomBinaryPathStore.test.ts
// Purpose: Covers validation and persistence of confirmed custom provider binary paths.
// Layer: Web UI state utility tests
// Depends on: confirmedCustomBinaryPathStore localStorage helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadConfirmedCustomBinaryPaths,
  saveConfirmedCustomBinaryPaths,
} from "./confirmedCustomBinaryPathStore";

const STORAGE_KEY = "synara:confirmed-custom-binary-paths:v1";

describe("confirmedCustomBinaryPathStore", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and trims a confirmed Command Code binary path", () => {
    values.set(
      STORAGE_KEY,
      JSON.stringify({
        commandCode: " C:/tools/commandcode.exe ",
        unknownProvider: "C:/tools/unknown.exe",
      }),
    );

    expect(loadConfirmedCustomBinaryPaths()).toEqual({
      commandCode: "C:/tools/commandcode.exe",
    });
  });

  it("persists a confirmed Command Code binary path", () => {
    saveConfirmedCustomBinaryPaths({ commandCode: "C:/tools/commandcode.exe" });

    expect(JSON.parse(values.get(STORAGE_KEY) ?? "{}")).toEqual({
      commandCode: "C:/tools/commandcode.exe",
    });
  });
});
