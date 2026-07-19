import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDesktopStageFilesUnchanged,
  canonicalizeDesktopStagePath,
} from "./desktop-stage-install.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop stage install", () => {
  it("uses the host canonical path resolver without changing global temp configuration", () => {
    const seen: string[] = [];
    expect(
      canonicalizeDesktopStagePath("C:\\Users\\BUILDE~1\\Temp\\stage", (stagePath) => {
        seen.push(stagePath);
        return "C:\\Users\\Builder\\Temp\\stage";
      }),
    ).toBe("C:\\Users\\Builder\\Temp\\stage");
    expect(seen).toEqual(["C:\\Users\\BUILDE~1\\Temp\\stage"]);
  });

  it("accepts byte-identical staged release metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-stage-files-"));
    temporaryRoots.push(root);
    const repository = join(root, "repository");
    const stage = join(root, "stage");
    mkdirSync(repository, { recursive: true });
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(repository, "package.json"), '{"name":"same"}\n');
    writeFileSync(join(stage, "package.json"), '{"name":"same"}\n');

    expect(() =>
      assertDesktopStageFilesUnchanged(repository, stage, ["package.json"]),
    ).not.toThrow();
  });

  it("rejects any staged release metadata byte change", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-stage-files-"));
    temporaryRoots.push(root);
    const repository = join(root, "repository");
    const stage = join(root, "stage");
    mkdirSync(repository, { recursive: true });
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(repository, "package.json"), '{"name":"same"}\n');
    writeFileSync(join(stage, "package.json"), '{"name":"changed"}\n');

    expect(() => assertDesktopStageFilesUnchanged(repository, stage, ["package.json"])).toThrow(
      "changed package.json",
    );
  });
});
