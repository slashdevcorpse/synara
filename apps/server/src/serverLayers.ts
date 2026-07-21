import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AgentGatewayLive } from "./agentGateway/Layers/AgentGateway";
import { AgentGatewayOperationRepositoryLive } from "./agentGateway/Layers/AgentGatewayOperationRepository";
import { AgentGatewayCredentialsWithSecretsLive } from "./agentGateway/Layers/AgentGatewayCredentials";
import { AutomationRunReactorLive } from "./automation/Layers/AutomationRunReactor";
import { AutomationSchedulerLive } from "./automation/Layers/AutomationScheduler";
import { AutomationServiceLive } from "./automation/Layers/AutomationService";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { StudioOutputReactorLive } from "./orchestration/Layers/StudioOutputReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer";

import { DevServerManagerLive } from "./devServerManager";
import { KeybindingsLive } from "./keybindings";
import { GitCoreLive } from "./git/Layers/GitCore";
import { makeGitLayerLive, makeTextGenerationLayerLive } from "./git/runtimeLayer";
import { TerminalLayerLive } from "./terminal/runtimeLayer";
import { AuthControlPlaneLive } from "./auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { ProfileStatsQueryLive } from "./profileStats";
import { ProfileStatsArchiveLive } from "./profileStatsArchive";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { ServerSettingsLive } from "./serverSettings";
import { WorkspaceLayerLive } from "./workspace/runtimeLayer";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";
import { AutomationRepositoryLive } from "./persistence/Layers/AutomationRepository";
import { ProjectPullRequestPinsLive } from "./persistence/Layers/ProjectPullRequestPins";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns";
import { OrchestrationEventDeliveryRepositoryLive } from "./persistence/Layers/OrchestrationEventDeliveries";
import { ManagedAttachmentCleanupLive } from "./managedAttachmentCleanup";
import { PullRequestServiceLive } from "./pullRequests/Layers/PullRequestService";
import { makeProviderHealthLive } from "./provider/Layers/ProviderHealth";
import type { ProviderMaintenanceGate } from "./provider/providerMaintenanceGate";
import type { ProviderMaintenanceOwnedResourceCoordinator } from "./provider/providerMaintenanceOwnedResources";
import { makeServerProviderLayer } from "./provider/runtimeLayer";

export { makeServerProviderLayer } from "./provider/runtimeLayer";

interface ServerRuntimeServicesLayerOptions {
  readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
  readonly maintenanceGate?: ProviderMaintenanceGate;
  readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
  readonly providerLayer?: ReturnType<typeof makeServerProviderLayer>;
}

export function makeServerRuntimeServicesLayer(
  options: ServerRuntimeServicesLayerOptions = {},
) {
  const agentGatewayCredentialsLayer =
    options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
  const maintenanceOptions =
    options.maintenanceGate || options.maintenanceOwnedResources
      ? {
          ...(options.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
          ...(options.maintenanceOwnedResources
            ? { maintenanceOwnedResources: options.maintenanceOwnedResources }
            : {}),
        }
      : undefined;
  const providerLayer =
    options.providerLayer ??
    makeServerProviderLayer({
      agentGatewayCredentialsLayer,
      ...(options.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
    });
  const providerHealthLayer = makeProviderHealthLive(maintenanceOptions).pipe(
    Layer.provideMerge(ServerSettingsLive),
    Layer.provide(providerLayer),
  );
  const textGenerationLayer = makeTextGenerationLayerLive(maintenanceOptions);
  const gitLayer = makeGitLayerLive(maintenanceOptions, { textGenerationLayer });
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(checkpointStoreLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    OrchestrationLayerLive,
    checkpointStoreLayer,
    checkpointDiffQueryLayer,
    RuntimeReceiptBusLive,
  );
  const managedAttachmentCleanupLayer = ManagedAttachmentCleanupLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const studioOutputReactorLayer = StudioOutputReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(studioOutputReactorLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(textGenerationLayer),
    Layer.provideMerge(ServerSettingsLive),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const profileStatsArchiveLayer = ProfileStatsArchiveLive.pipe(
    Layer.provideMerge(checkpointStoreLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
    Layer.provideMerge(studioOutputReactorLayer),
  );
  const threadDeletionReactorLayer = ThreadDeletionReactorLive.pipe(
    Layer.provideMerge(profileStatsArchiveLayer),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(TerminalLayerLive),
  );
  // Shares the single memoized TerminalManager with the top-level TerminalLayerLive.
  const devServerManagerLayer = DevServerManagerLive.pipe(Layer.provide(TerminalLayerLive));
  const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(ServerSecretStoreLive),
  );
  const authControlPlaneLayer = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
  );
  const serverAuthLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
    Layer.provide(authControlPlaneLayer),
  );
  const authServicesLayer = Layer.mergeAll(
    ServerAuthPolicyLive,
    ServerSecretStoreLive,
    BootstrapCredentialServiceLive,
    sessionCredentialLayer,
    authControlPlaneLayer,
    serverAuthLayer,
  );
  const automationServiceLayer = AutomationServiceLive.pipe(
    Layer.provideMerge(AutomationRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(textGenerationLayer),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const automationSchedulerLayer = AutomationSchedulerLive.pipe(
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(AutomationRepositoryLive),
  );
  const automationRunReactorLayer = AutomationRunReactorLive.pipe(
    Layer.provideMerge(automationServiceLayer),
  );
  const agentGatewayLayer = AgentGatewayLive.pipe(
    Layer.provideMerge(agentGatewayCredentialsLayer),
    Layer.provideMerge(automationServiceLayer),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(AgentGatewayOperationRepositoryLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(providerHealthLayer),
  );
  const pullRequestServiceLayer = PullRequestServiceLive.pipe(
    Layer.provideMerge(gitLayer),
    Layer.provideMerge(ProjectPullRequestPinsLive),
    Layer.provideMerge(OrchestrationLayerLive),
  );

  return Layer.mergeAll(
    agentGatewayCredentialsLayer,
    agentGatewayLayer,
    automationServiceLayer,
    automationSchedulerLayer,
    automationRunReactorLayer,
    managedAttachmentCleanupLayer,
    AutomationRepositoryLive,
    AgentGatewayOperationRepositoryLive,
    providerHealthLayer,
    ProjectPullRequestPinsLive,
    pullRequestServiceLayer,
    orchestrationReactorLayer,
    providerCommandReactorLayer,
    threadDeletionReactorLayer,
    devServerManagerLayer,
    gitLayer,
    textGenerationLayer,
    TerminalLayerLive,
    KeybindingsLive,
    ServerSettingsLive,
    ServerEnvironmentLive,
    ProfileStatsQueryLive,
    authServicesLayer,
    ServerLifecycleEventsLive,
    ServerRuntimeStartupLive,
    WorkspaceLayerLive,
    ProjectFaviconResolverLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

/**
 * Compose the two top-level server graphs around one credential layer. Provider
 * adapters issue tokens from this registry and the HTTP gateway verifies those
 * same tokens, so constructing them independently would break scoped MCP.
 */
export function makeServerApplicationLayers(
  options: {
    readonly maintenanceGate?: ProviderMaintenanceGate;
    readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
  } = {},
) {
  const agentGatewayCredentialsLayer = AgentGatewayCredentialsWithSecretsLive;
  const providerLayer = makeServerProviderLayer({
    agentGatewayCredentialsLayer,
    ...(options.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
  });
  return {
    runtimeServicesLayer: makeServerRuntimeServicesLayer({
      agentGatewayCredentialsLayer,
      providerLayer,
      ...(options.maintenanceGate ? { maintenanceGate: options.maintenanceGate } : {}),
      ...(options.maintenanceOwnedResources
        ? { maintenanceOwnedResources: options.maintenanceOwnedResources }
        : {}),
    }),
    providerLayer,
  } as const;
}
