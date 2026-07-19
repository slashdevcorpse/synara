import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import {
  canaryCloneArgs,
  canaryStartArgs,
  parseCanaryArgs,
  resolveCanaryPaths,
  resolveCanaryRef,
} from "./canary";

describe("canary tooling", () => {
  it("keeps managed source and Canary data separate from Stable", () => {
    const homeDirectory = Path.resolve(Path.sep, "Users", "tester");

    expect(resolveCanaryPaths({}, homeDirectory)).toEqual({
      home: Path.join(homeDirectory, ".synara-canary"),
      source: Path.join(homeDirectory, ".cache", "synara-canary", "source"),
      state: Path.join(homeDirectory, ".synara-canary", "canary-state.json"),
      pid: Path.join(homeDirectory, ".synara-canary", "canary.pid"),
      log: Path.join(homeDirectory, ".synara-canary", "canary.log"),
    });
  });

  it("supports explicit path overrides", () => {
    const home = Path.resolve(Path.sep, "tmp", "canary-data");
    const source = Path.resolve(Path.sep, "tmp", "canary-source");

    expect(
      resolveCanaryPaths(
        {
          SYNARA_CANARY_HOME: home,
          SYNARA_CANARY_SOURCE: source,
        },
        Path.resolve(Path.sep, "Users", "tester"),
      ),
    ).toEqual({
      home,
      source,
      state: Path.join(home, "canary-state.json"),
      pid: Path.join(home, "canary.pid"),
      log: Path.join(home, "canary.log"),
    });
  });

  it("tracks main by default and accepts a stacked PR ref", () => {
    expect(parseCanaryArgs(["update"])).toEqual({ command: "update", ref: null });
    expect(parseCanaryArgs(["setup", "--ref", "codex/synara-canary"])).toEqual({
      command: "setup",
      ref: "codex/synara-canary",
    });
  });

  it("checks out the managed source during clone so the cleanliness guard starts clean", () => {
    expect(canaryCloneArgs("git@example.com:synara.git", "/tmp/canary-source")).toEqual([
      "clone",
      "--",
      "git@example.com:synara.git",
      "/tmp/canary-source",
    ]);
  });

  it("starts the desktop launcher directly so the persisted PID stays alive", () => {
    expect(canaryStartArgs()).toEqual(["apps/desktop/scripts/start-electron.mjs"]);
  });

  it("keeps updating the selected stacked ref until explicitly moved to main", () => {
    expect(resolveCanaryRef(parseCanaryArgs(["setup"]), null)).toBe("main");
    expect(resolveCanaryRef(parseCanaryArgs(["update"]), "codex/synara-canary")).toBe(
      "codex/synara-canary",
    );
    expect(resolveCanaryRef(parseCanaryArgs(["update", "--ref", "main"]), "old-ref")).toBe("main");
  });

  it("rejects unsupported commands and incomplete refs", () => {
    expect(() => parseCanaryArgs(["reset"])).toThrow(/Unknown Canary command/u);
    expect(() => parseCanaryArgs(["update", "--ref"])).toThrow(/Missing value/u);
  });
});
