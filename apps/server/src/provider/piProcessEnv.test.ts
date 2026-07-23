import { readEffectiveWindowsEnvironmentValue } from "@synara/shared/windowsProcess";
import { describe, expect, it } from "vitest";

import { buildPiProcessEnv } from "./piProcessEnv.ts";

describe("buildPiProcessEnv", () => {
  it("suppresses version checks without mutating the source environment", () => {
    const source = {
      PATH: "/usr/bin",
      PI_SKIP_VERSION_CHECK: "0",
    };
    const env = buildPiProcessEnv({ baseEnv: source, platform: "linux" });

    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(source.PI_SKIP_VERSION_CHECK).toBe("0");
  });

  it("normalizes mixed-case Windows aliases to the canonical override", () => {
    const env = buildPiProcessEnv({
      baseEnv: { Pi_Skip_Version_Check: "0" },
      platform: "win32",
    });

    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(env.Pi_Skip_Version_Check).toBeUndefined();
  });

  it("applies Windows authority filtering before normalizing aliases", () => {
    const env = buildPiProcessEnv({
      baseEnv: {
        Path: "C:\\tools",
        sYnArA_AuTh_ToKeN: "control-plane-secret",
      },
      platform: "win32",
    });

    expect(readEffectiveWindowsEnvironmentValue(env, "PATH")).toBe("C:\\tools");
    expect(readEffectiveWindowsEnvironmentValue(env, "SYNARA_AUTH_TOKEN")).toBeUndefined();
  });
});
