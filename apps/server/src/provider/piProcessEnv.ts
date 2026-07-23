import { normalizeWindowsChildEnvironment } from "@synara/shared/windowsProcess";

import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

export function buildPiProcessEnv(input?: {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = input?.platform ?? process.platform;
  const childEnv = buildProviderChildEnvironment({
    provider: "pi",
    baseEnv: input?.baseEnv ?? process.env,
    overrides: { PI_SKIP_VERSION_CHECK: "1" },
    platform,
  });
  return platform === "win32" ? normalizeWindowsChildEnvironment(childEnv) : childEnv;
}
