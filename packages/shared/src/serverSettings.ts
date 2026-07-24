import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderStartOptions,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { deepMerge, type DeepPartial } from "./Struct";

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.provider !== undefined || patch.model !== undefined));
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const next = deepMerge(current, patch as DeepPartial<ServerSettings>);
  if (!selectionPatch) {
    return next;
  }

  const provider = selectionPatch.provider ?? current.textGenerationModelSelection.provider;
  const model =
    selectionPatch.model ??
    (selectionPatch.provider &&
    selectionPatch.provider !== "pi" &&
    selectionPatch.provider !== current.textGenerationModelSelection.provider
      ? DEFAULT_MODEL_BY_PROVIDER[selectionPatch.provider]
      : current.textGenerationModelSelection.model);
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : (selectionPatch.options ?? current.textGenerationModelSelection.options);

  return {
    ...next,
    textGenerationModelSelection: {
      provider,
      model,
      ...(options !== undefined ? { options } : {}),
    } as ModelSelection,
  };
}

/** Server-owned launch options derived from the persisted non-secret settings snapshot. */
export function providerStartOptionsFromServerSettings(
  settings: ServerSettings,
): ProviderStartOptions {
  const { providers } = settings;
  const nonEmpty = (value: string): string | undefined => value.trim() || undefined;
  const codexBinaryPath = nonEmpty(providers.codex.binaryPath);
  const commandCodeBinaryPath = nonEmpty(providers.commandCode.binaryPath);
  const claudeBinaryPath = nonEmpty(providers.claudeAgent.binaryPath);
  const cursorBinaryPath = nonEmpty(providers.cursor.binaryPath);
  const antigravityBinaryPath = nonEmpty(providers.antigravity.binaryPath);
  const grokBinaryPath = nonEmpty(providers.grok.binaryPath);
  const droidBinaryPath = nonEmpty(providers.droid.binaryPath);
  const kiloBinaryPath = nonEmpty(providers.kilo.binaryPath);
  const openCodeBinaryPath = nonEmpty(providers.opencode.binaryPath);
  const piBinaryPath = nonEmpty(providers.pi.binaryPath);

  return {
    codex: {
      ...(codexBinaryPath ? { binaryPath: codexBinaryPath } : {}),
      ...(providers.codex.homePath ? { homePath: providers.codex.homePath } : {}),
    },
    commandCode: {
      ...(commandCodeBinaryPath ? { binaryPath: commandCodeBinaryPath } : {}),
    },
    claudeAgent: {
      ...(claudeBinaryPath ? { binaryPath: claudeBinaryPath } : {}),
    },
    cursor: {
      ...(cursorBinaryPath ? { binaryPath: cursorBinaryPath } : {}),
      ...(providers.cursor.apiEndpoint ? { apiEndpoint: providers.cursor.apiEndpoint } : {}),
    },
    antigravity: {
      ...(antigravityBinaryPath ? { binaryPath: antigravityBinaryPath } : {}),
    },
    grok: {
      ...(grokBinaryPath ? { binaryPath: grokBinaryPath } : {}),
    },
    droid: {
      ...(droidBinaryPath ? { binaryPath: droidBinaryPath } : {}),
    },
    kilo: {
      ...(kiloBinaryPath ? { binaryPath: kiloBinaryPath } : {}),
      ...(providers.kilo.serverUrl ? { serverUrl: providers.kilo.serverUrl } : {}),
    },
    opencode: {
      ...(openCodeBinaryPath ? { binaryPath: openCodeBinaryPath } : {}),
      ...(providers.opencode.serverUrl ? { serverUrl: providers.opencode.serverUrl } : {}),
      experimentalWebSockets: providers.opencode.experimentalWebSockets,
    },
    pi: {
      ...(piBinaryPath ? { binaryPath: piBinaryPath } : {}),
      ...(providers.pi.agentDir ? { agentDir: providers.pi.agentDir } : {}),
    },
  };
}
