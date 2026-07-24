import { Effect, Layer } from "effect";

import { AgentGatewayCredentialsWithSecretsLive } from "../agentGateway/Layers/AgentGatewayCredentials";
import { ServerConfig } from "../config";
import {
  makeProviderServerPasswordResolver,
  ProviderCredentials,
  ProviderCredentialsLive,
} from "../providerCredentials";
import { ServerSettingsLive } from "../serverSettings";
import { makeClaudeAdapterLive } from "./Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./Layers/CodexAdapter";
import { makeCommandCodeAdapterLive } from "./Layers/CommandCodeAdapter";
import { makeCursorAdapterLive } from "./Layers/CursorAdapter";
import { makeEventNdjsonLogger } from "./Layers/EventNdjsonLogger";
import { makeAntigravityAdapterLive } from "./Layers/AntigravityAdapter";
import { makeDroidAdapterLive } from "./Layers/DroidAdapter";
import { makeGrokAdapterLive } from "./Layers/GrokAdapter";
import { makeKiloAdapterLive, makeOpenCodeAdapterLive } from "./Layers/OpenCodeAdapter";
import { makePiAdapterLive } from "./Layers/PiAdapter";
import { makeProviderAdapterRegistryLive } from "./Layers/ProviderAdapterRegistry";
import { makeProviderDiscoveryServiceLive } from "./Layers/ProviderDiscoveryService";
import { makeDurableProviderServiceLive } from "./Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents";
import type { ProviderMaintenanceGate } from "./providerMaintenanceGate";
import type { ProviderMaintenanceOwnedResourceCoordinator } from "./providerMaintenanceOwnedResources";

export function makeProviderAdapterMaintenanceOptions(
  maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator,
) {
  const shared = maintenanceOwnedResources ? { maintenanceOwnedResources } : {};
  return {
    claude: shared,
    commandCode: shared,
    openCode: shared,
    kilo: shared,
    antigravity: shared,
    grok: shared,
    cursor: shared,
    pi: shared,
  } as const;
}

export function makeServerProviderLayer(
  options: {
    readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
    readonly maintenanceGate?: ProviderMaintenanceGate;
    readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
  } = {},
) {
  return Effect.gen(function* () {
    const credentials = yield* ProviderCredentials;
    const resolveProviderServerPassword = makeProviderServerPasswordResolver(credentials);
    const { logProviderEvents, providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "native",
        })
      : undefined;
    const canonicalEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "canonical",
        })
      : undefined;
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    // Gives gateway-capable sessions their thread-scoped synara_* credentials.
    // OpenCode/Kilo isolate managed servers before installing MCP; Pi projects
    // the same MCP catalog/dispatcher through its native custom-tool API.
    const agentGatewayCredentialsLayer =
      options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
    const adapterMaintenanceOptions = makeProviderAdapterMaintenanceOptions(
      options.maintenanceOwnedResources,
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const commandCodeAdapterLayer = makeCommandCodeAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      ...adapterMaintenanceOptions.commandCode,
    }).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const gatewayCodexAdapterLayer = codexAdapterLayer.pipe(
      Layer.provide(agentGatewayCredentialsLayer),
      // Codex discovery reads the current server-authoritative binary/home
      // profile. Use the shared live layer so every production composition,
      // including the standalone provider graph, receives the same settings
      // instance as the rest of the server.
      Layer.provide(ServerSettingsLive),
    );
    const claudeAdapterLayer = makeClaudeAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      ...adapterMaintenanceOptions.claude,
    }).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const openCodeAdapterLayer = makeOpenCodeAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      ...adapterMaintenanceOptions.openCode,
      resolveServerPassword: resolveProviderServerPassword,
    }).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const kiloAdapterLayer = makeKiloAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      ...adapterMaintenanceOptions.kilo,
      resolveServerPassword: resolveProviderServerPassword,
    }).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const antigravityAdapterLayer = makeAntigravityAdapterLive(
      adapterMaintenanceOptions.antigravity,
    );
    const grokAdapterLayer = makeGrokAdapterLive(
      {},
      { ...(nativeEventLogger ? { nativeEventLogger } : {}), ...adapterMaintenanceOptions.grok },
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const droidAdapterLayer = makeDroidAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const cursorAdapterLayer = makeCursorAdapterLive(
      {},
      { ...(nativeEventLogger ? { nativeEventLogger } : {}), ...adapterMaintenanceOptions.cursor },
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const piAdapterLayer = makePiAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      ...adapterMaintenanceOptions.pi,
    }).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const adapterRegistryLayer = makeProviderAdapterRegistryLive({
      ...(options?.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
    }).pipe(
      Layer.provide(gatewayCodexAdapterLayer),
      Layer.provide(commandCodeAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provide(cursorAdapterLayer),
      Layer.provide(antigravityAdapterLayer),
      Layer.provide(grokAdapterLayer),
      Layer.provide(droidAdapterLayer),
      Layer.provide(kiloAdapterLayer),
      Layer.provide(openCodeAdapterLayer),
      Layer.provide(piAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerServiceLayer = makeDurableProviderServiceLive(
      canonicalEventLogger || options?.maintenanceGate
        ? {
            ...(canonicalEventLogger ? { canonicalEventLogger } : {}),
            ...(options?.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
          }
        : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(ProviderRuntimeEventRepositoryLive),
    );
    const providerDiscoveryLayer = makeProviderDiscoveryServiceLive({
      ...(options?.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
    }).pipe(
      Layer.provide(adapterRegistryLayer),
      // Skill toggles live in server settings; the shared ServerSettingsLive
      // layer is memoized so this reuses the instance built at the top level.
      Layer.provide(ServerSettingsLive),
    );
    return Layer.mergeAll(
      providerServiceLayer,
      providerDiscoveryLayer,
      adapterRegistryLayer,
      providerSessionDirectoryLayer,
    );
  }).pipe(Effect.provide(ProviderCredentialsLive.pipe(Layer.orDie)), Layer.unwrap);
}
