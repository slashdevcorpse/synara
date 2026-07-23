// FILE: providerChildEnvironment.ts
// Purpose: Builds provider child environments without Synara control-plane authority.
// Layer: Server provider process security

import { normalizeWindowsChildEnvironment } from "@synara/shared/windowsProcess";

export type ProviderChildKind =
  | "acp"
  | "antigravity"
  | "claude"
  | "codex"
  | "commandCode"
  | "cursor"
  | "droid"
  | "grok"
  | "kilo"
  | "opencode"
  | "pi";

const PROVIDER_CREDENTIAL_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KIMI_MODEL_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "PORTKEY_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "FACTORY_API_KEY",
  "CURSOR_API_KEY",
]);

const PROVIDER_CREDENTIAL_GRANTS: Record<ProviderChildKind, "all" | ReadonlySet<string>> = {
  antigravity: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]),
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]),
  cursor: new Set(["CURSOR_API_KEY"]),
  droid: new Set(["FACTORY_API_KEY"]),
  grok: new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]),
  // These profiles deliberately support arbitrary upstream model providers.
  acp: "all",
  codex: "all",
  commandCode: "all",
  kilo: "all",
  opencode: "all",
  pi: "all",
};

const INHERITED_NATIVE_CAPABILITY_KEYS = new Set([
  "BUN_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS",
]);

export function buildProviderChildEnvironment(input: {
  readonly provider: ProviderChildKind;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly inheritedSynaraKeys?: ReadonlyArray<string>;
  readonly inheritedNativeCapabilityKeys?: ReadonlyArray<string>;
  readonly overrides?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const mergedEnv = {
    ...(input.baseEnv ?? process.env),
    ...input.overrides,
  };
  const baseEnv = platform === "win32" ? normalizeWindowsChildEnvironment(mergedEnv) : mergedEnv;
  const policyKey = (key: string): string => (platform === "win32" ? key.toUpperCase() : key);
  const allowedSynaraKeys = new Set((input.inheritedSynaraKeys ?? []).map(policyKey));
  const allowedNativeCapabilities = new Set(
    (input.inheritedNativeCapabilityKeys ?? []).map(policyKey),
  );
  const credentialGrants = PROVIDER_CREDENTIAL_GRANTS[input.provider];
  const testHarnessEnabled = Object.entries(baseEnv).some(
    ([key, value]) => policyKey(key) === "VITEST" && Boolean(value),
  );
  const childEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    const normalizedKey = policyKey(key);
    if (
      normalizedKey.startsWith("SYNARA_") &&
      !allowedSynaraKeys.has(normalizedKey) &&
      !(
        testHarnessEnabled &&
        (normalizedKey.startsWith("SYNARA_FAKE_") || normalizedKey.startsWith("SYNARA_ACP_"))
      )
    ) {
      continue;
    }
    if (
      INHERITED_NATIVE_CAPABILITY_KEYS.has(normalizedKey) &&
      !allowedNativeCapabilities.has(normalizedKey)
    ) {
      continue;
    }
    if (
      PROVIDER_CREDENTIAL_KEYS.has(normalizedKey) &&
      credentialGrants !== "all" &&
      !credentialGrants.has(normalizedKey)
    ) {
      continue;
    }
    childEnv[key] = value;
  }

  return childEnv;
}
