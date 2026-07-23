import { readEffectiveWindowsEnvironmentValue } from "@synara/shared/windowsProcess";
import { describe, expect, it } from "vitest";

import { buildDroidMaintenanceProcessEnv, buildDroidRuntimeProcessEnv } from "./droidProcessEnv.ts";

describe("Droid process environments", () => {
  it("disables automatic updates only in the runtime child environment", () => {
    const source = {
      FACTORY_API_KEY: "factory-secret",
      Factory_Droid_Auto_Update_Enabled: "true",
    };
    const env = buildDroidRuntimeProcessEnv({
      baseEnv: source,
      platform: "win32",
    });

    expect(readEffectiveWindowsEnvironmentValue(env, "FACTORY_API_KEY")).toBe("factory-secret");
    expect(readEffectiveWindowsEnvironmentValue(env, "FACTORY_DROID_AUTO_UPDATE_ENABLED")).toBe(
      "false",
    );
    expect(source.Factory_Droid_Auto_Update_Enabled).toBe("true");
  });

  it("removes every effective Windows suppression alias from maintenance children", () => {
    const env = buildDroidMaintenanceProcessEnv({
      baseEnv: {
        FACTORY_API_KEY: "factory-secret",
        FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
        Factory_Droid_Auto_Update_Enabled: "false",
      },
      platform: "win32",
    });

    expect(readEffectiveWindowsEnvironmentValue(env, "FACTORY_API_KEY")).toBe("factory-secret");
    expect(
      readEffectiveWindowsEnvironmentValue(env, "FACTORY_DROID_AUTO_UPDATE_ENABLED"),
    ).toBeUndefined();
  });
});
