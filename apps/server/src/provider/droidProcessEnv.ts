import { normalizeWindowsChildEnvironment } from "@synara/shared/windowsProcess";

import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

export const FACTORY_DROID_AUTO_UPDATE_ENABLED_ENV = "FACTORY_DROID_AUTO_UPDATE_ENABLED";

export function buildDroidRuntimeProcessEnv(input?: {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  return buildProviderChildEnvironment({
    provider: "droid",
    baseEnv: input?.baseEnv ?? process.env,
    overrides: { [FACTORY_DROID_AUTO_UPDATE_ENABLED_ENV]: "false" },
    ...(input?.platform ? { platform: input.platform } : {}),
  });
}

export function buildDroidMaintenanceProcessEnv(input?: {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = input?.platform ?? process.platform;
  const providerEnv = buildProviderChildEnvironment({
    provider: "droid",
    baseEnv: input?.baseEnv ?? process.env,
    platform,
  });
  const maintenanceEnv = Object.fromEntries(
    Object.entries(providerEnv).filter(([key]) =>
      platform === "win32"
        ? key.toUpperCase() !== FACTORY_DROID_AUTO_UPDATE_ENABLED_ENV
        : key !== FACTORY_DROID_AUTO_UPDATE_ENABLED_ENV,
    ),
  );
  return platform === "win32" ? normalizeWindowsChildEnvironment(maintenanceEnv) : maintenanceEnv;
}
