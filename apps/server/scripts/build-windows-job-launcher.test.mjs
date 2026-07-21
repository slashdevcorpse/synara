import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  publishWindowsJobLauncherArtifact,
  supportedWindowsJobLauncherArchitectures,
} from "./build-windows-job-launcher.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeArtifactPaths() {
  const directory = mkdtempSync(join(tmpdir(), "synara-launcher-publish-test-"));
  temporaryDirectories.push(directory);
  return {
    built: join(directory, "built.exe"),
    destination: join(directory, "published.exe"),
  };
}

describe("Windows Job launcher artifact publishing", () => {
  it("uses the centrally configured architecture set", () => {
    expect(supportedWindowsJobLauncherArchitectures).toEqual(["x64", "arm64"]);
  });

  it("atomically replaces the previously published launcher", () => {
    const paths = makeArtifactPaths();
    writeFileSync(paths.built, "new-launcher");
    writeFileSync(paths.destination, "old-launcher");

    publishWindowsJobLauncherArtifact(paths.built, paths.destination);

    expect(readFileSync(paths.destination, "utf8")).toBe("new-launcher");
    expect(existsSync(`${paths.destination}.pending-${process.pid}`)).toBe(false);
  });

  it("preserves the previous launcher and cleans pending output when replacement fails", () => {
    const paths = makeArtifactPaths();
    writeFileSync(paths.built, "new-launcher");
    writeFileSync(paths.destination, "old-launcher");

    expect(() =>
      publishWindowsJobLauncherArtifact(paths.built, paths.destination, {
        renameFile: () => {
          throw new Error("simulated locked destination");
        },
      }),
    ).toThrow("simulated locked destination");

    expect(readFileSync(paths.destination, "utf8")).toBe("old-launcher");
    expect(existsSync(`${paths.destination}.pending-${process.pid}`)).toBe(false);
  });
});
