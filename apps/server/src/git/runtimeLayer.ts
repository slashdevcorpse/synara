import { Effect, Layer } from "effect";

import { GitCoreLive } from "./Layers/GitCore";
import { GitHubCliLive } from "./Layers/GitHubCli";
import { GitManagerLive } from "./Layers/GitManager";
import { GitStatusBroadcasterLive } from "./Layers/GitStatusBroadcaster";
import { CodexTextGenerationServiceLive } from "./Layers/CodexTextGeneration";
import { CursorTextGenerationServiceLive } from "./Layers/CursorTextGeneration";
import {
  makeKiloTextGenerationServiceLive,
  makeOpenCodeTextGenerationServiceLive,
} from "./Layers/OpenCodeTextGeneration";
import { makeProviderTextGenerationLive } from "./Layers/ProviderTextGeneration";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime";
import type { ProviderMaintenanceGate } from "../provider/providerMaintenanceGate";
import type { ProviderMaintenanceOwnedResourceCoordinator } from "../provider/providerMaintenanceOwnedResources";
import {
  makeProviderServerPasswordResolver,
  ProviderCredentials,
  ProviderCredentialsLive,
} from "../providerCredentials";

interface GitRuntimeLayerOptions {
  readonly maintenanceGate?: ProviderMaintenanceGate;
  readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
}

function makeTextGenerationProviderLayers(options?: GitRuntimeLayerOptions) {
  return Effect.gen(function* () {
    const credentials = yield* ProviderCredentials;
    const resolveProviderServerPassword = makeProviderServerPasswordResolver(credentials);
    const openCodeOptions = options?.maintenanceOwnedResources
      ? { maintenanceOwnedResources: options.maintenanceOwnedResources }
      : undefined;
    return Layer.mergeAll(
      makeKiloTextGenerationServiceLive(resolveProviderServerPassword, openCodeOptions).pipe(
        Layer.provide(OpenCodeRuntimeLive),
      ),
      makeOpenCodeTextGenerationServiceLive(resolveProviderServerPassword, openCodeOptions).pipe(
        Layer.provide(OpenCodeRuntimeLive),
      ),
    );
  }).pipe(Effect.provide(ProviderCredentialsLive.pipe(Layer.orDie)), Layer.unwrap);
}

export function makeTextGenerationLayerLive(options?: GitRuntimeLayerOptions) {
  return makeProviderTextGenerationLive({
    ...(options?.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
  }).pipe(
    Layer.provide(CodexTextGenerationServiceLive),
    Layer.provide(CursorTextGenerationServiceLive),
    Layer.provide(makeTextGenerationProviderLayers(options)),
  );
}

export function makeGitManagerLayerLive(
  options?: GitRuntimeLayerOptions,
  textGenerationLayer = makeTextGenerationLayerLive(options),
) {
  return GitManagerLive.pipe(
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(GitHubCliLive),
    Layer.provideMerge(textGenerationLayer),
  );
}

export function makeGitStatusBroadcasterLayerLive(
  options?: GitRuntimeLayerOptions,
  gitManagerLayer = makeGitManagerLayerLive(options),
) {
  return GitStatusBroadcasterLive.pipe(
    Layer.provide(Layer.mergeAll(GitCoreLive, gitManagerLayer)),
  );
}

export function makeGitLayerLive(
  options?: GitRuntimeLayerOptions,
  dependencies?: {
    readonly textGenerationLayer?: ReturnType<typeof makeTextGenerationLayerLive>;
  },
) {
  const textGenerationLayer =
    dependencies?.textGenerationLayer ?? makeTextGenerationLayerLive(options);
  const gitManagerLayer = makeGitManagerLayerLive(options, textGenerationLayer);
  const gitStatusBroadcasterLayer = makeGitStatusBroadcasterLayerLive(options, gitManagerLayer);

  return Layer.mergeAll(
    GitCoreLive,
    GitHubCliLive,
    gitManagerLayer,
    gitStatusBroadcasterLayer,
  );
}

export const TextGenerationLayerLive = makeTextGenerationLayerLive();
export const GitManagerLayerLive = makeGitManagerLayerLive(undefined, TextGenerationLayerLive);
export const GitStatusBroadcasterLayerLive = makeGitStatusBroadcasterLayerLive(
  undefined,
  GitManagerLayerLive,
);
export const GitLayerLive = Layer.mergeAll(
  GitCoreLive,
  GitHubCliLive,
  GitManagerLayerLive,
  GitStatusBroadcasterLayerLive,
);
