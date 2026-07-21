// FILE: OpenCodeTextGeneration.ts
// Purpose: Runs OpenCode-compatible one-shot text generation for titles, branches, recaps, and release text.
// Layer: Server git/text-generation adapter
// Depends on: OpenCode SDK runtime, prompt builders, attachment projection, and server config.

import { Cause, Effect, Exit, Fiber, Layer, Ref, Schema, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  ChatAttachment,
  KiloModelSelection,
  OpenCodeModelSelection,
  OpenCodeModelOptions,
  ProviderStartOptions,
} from "@synara/contracts";
import { sanitizeGeneratedThreadTitle } from "@synara/shared/chatThreads";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@synara/shared/git";
import { getModelSelectionStringOptionValue } from "@synara/shared/model";

import { resolveProviderAttachmentPath } from "../../provider/providerAttachmentPaths.ts";
import { ServerConfig } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../../provider/attachmentProjection.ts";
import {
  makeProviderMaintenanceOwnedResourceCoordinator,
  type ProviderMaintenanceOwnedResourceCoordinator,
  type ProviderMaintenanceOwnedResourceRegistration,
} from "../../provider/providerMaintenanceOwnedResources.ts";
import {
  OpenCodeRuntime,
  KILO_CLI_SPEC,
  OPENCODE_CLI_SPEC,
  type OpenCodeCompatibleCliSpec,
  type OpenCodeOwnedServerProcess,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
} from "../../provider/opencodeRuntime.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type TextGenerationOperation,
  type TextGenerationShape,
  KiloTextGeneration,
  OpenCodeTextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildAutomationIntentPrompt,
  buildAutomationCompletionEvaluationPrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildDiffSummaryPrompt,
  buildPrContentPrompt,
  buildThreadRecapPrompt,
  buildThreadTitlePrompt,
  decodeStructuredTextGenerationOutput,
  type RawTextFallback,
  sanitizeCommitSubject,
  sanitizeDiffSummary,
  sanitizeThreadRecap,
  sanitizePrTitle,
} from "../textGenerationShared.ts";

const OPENCODE_TEXT_GENERATION_IDLE_TTL = "30 seconds";

function getOpenCodePromptErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return message;
  }

  if ("name" in error && typeof error.name === "string") {
    const name = error.name.trim();
    return name.length > 0 ? name : null;
  }

  return null;
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      if (!("type" in part) || part.type !== "text") {
        return [];
      }
      if (!("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
}

interface OwnedOpenCodeTextGenerationServerResource {
  readonly process: OpenCodeOwnedServerProcess;
  server: OpenCodeServerProcess | null;
  readonly serverScope: Scope.Closeable;
  readonly operation: TextGenerationOperation;
  registration: ProviderMaintenanceOwnedResourceRegistration | null;
  closeFailure: TextGenerationError | null;
  closed: boolean;
}

interface ReadyOpenCodeTextGenerationServerResource extends OwnedOpenCodeTextGenerationServerResource {
  server: OpenCodeServerProcess;
}

interface SharedOpenCodeTextGenerationServerState {
  resource: ReadyOpenCodeTextGenerationServerResource | null;
  binaryPath: string | null;
  cwd: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

interface AcquiredOpenCodeTextGenerationServer {
  resource: ReadyOpenCodeTextGenerationServerResource;
  shared: boolean;
}

type OpenCodeCompatibleTextGenerationProvider = "opencode" | "kilo";
type OpenCodeCompatibleModelSelection = OpenCodeModelSelection | KiloModelSelection;

interface OpenCodeCompatibleTextGenerationConfig {
  readonly provider: OpenCodeCompatibleTextGenerationProvider;
  readonly displayName: string;
  readonly serviceName: string;
  readonly cliSpec: OpenCodeCompatibleCliSpec;
  readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
  readonly resolveServerPassword?: (
    provider: OpenCodeCompatibleTextGenerationProvider,
  ) => Effect.Effect<string | undefined>;
}

export interface OpenCodeCompatibleTextGenerationLiveOptions {
  readonly maintenanceOwnedResources?: ProviderMaintenanceOwnedResourceCoordinator;
}

function resolveOpenCodeCompatibleModelSelection(
  config: OpenCodeCompatibleTextGenerationConfig,
  input: {
    readonly model?: string;
    readonly modelSelection?: { provider: string; model: string; options?: unknown };
  },
): OpenCodeCompatibleModelSelection | null {
  if (input.modelSelection?.provider === config.provider) {
    return input.modelSelection as OpenCodeCompatibleModelSelection;
  }

  const model = input.model?.trim();
  if (config.provider !== "opencode" || !model || parseOpenCodeModelSlug(model) === null) {
    return null;
  }

  return {
    provider: "opencode",
    model,
  };
}

const makeOpenCodeCompatibleTextGeneration = (config: OpenCodeCompatibleTextGenerationConfig) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const maintenanceOwnedResources =
      config.maintenanceOwnedResources ?? (yield* makeProviderMaintenanceOwnedResourceCoordinator);
    const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const sharedServerMutex = yield* Semaphore.make(1);
    let nextOwnedResourceId = 1;
    const ownedServerResources = new Set<OwnedOpenCodeTextGenerationServerResource>();
    const sharedServerState: SharedOpenCodeTextGenerationServerState = {
      resource: null,
      binaryPath: null,
      cwd: null,
      activeRequests: 0,
      idleCloseFiber: null,
    };

    const cancelIdleCloseFiber = Effect.fn("cancelIdleCloseFiber")(function* () {
      const idleCloseFiber = sharedServerState.idleCloseFiber;
      sharedServerState.idleCloseFiber = null;
      if (idleCloseFiber !== null) {
        yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
      }
    });

    const clearSharedServer = (resource: OwnedOpenCodeTextGenerationServerResource) => {
      if (sharedServerState.resource !== resource) {
        return;
      }
      sharedServerState.resource = null;
      sharedServerState.binaryPath = null;
      sharedServerState.cwd = null;
      sharedServerState.activeRequests = 0;
    };

    const closeOwnedServerResourceEffect = Effect.fn("closeOwnedOpenCodeTextGenerationServer")(
      function* (resource: OwnedOpenCodeTextGenerationServerResource) {
        if (resource.closed) {
          return;
        }
        yield* resource.process.stop.pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: resource.operation,
                detail: `Failed to prove ${config.displayName} text-generation server process-tree exit: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              resource.closeFailure = error;
            }),
          ),
        );
        const scopeExit = yield* Effect.exit(Scope.close(resource.serverScope, Exit.void));
        if (Exit.isFailure(scopeExit)) {
          const cause = Cause.squash(scopeExit.cause);
          const error = new TextGenerationError({
            operation: resource.operation,
            detail: `Failed to close ${config.displayName} text-generation server scope after process exit: ${openCodeRuntimeErrorDetail(cause)}`,
            cause,
          });
          resource.closeFailure = error;
          return yield* error;
        }
        resource.closeFailure = null;
        resource.closed = true;
        if (resource.registration !== null) {
          yield* resource.registration.unregister;
        }
        ownedServerResources.delete(resource);
        clearSharedServer(resource);
      },
    );

    const closeOwnedServerResource = (resource: OwnedOpenCodeTextGenerationServerResource) =>
      closeOwnedServerResourceEffect(resource).pipe(Effect.uninterruptible);

    const closeRegisteredResource = (resource: OwnedOpenCodeTextGenerationServerResource) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          if (sharedServerState.resource === resource) {
            yield* cancelIdleCloseFiber();
          }
          yield* closeOwnedServerResource(resource);
        }),
      );

    const registerOwnedServerResource = Effect.fn("registerOwnedOpenCodeTextGenerationServer")(
      function* (input: {
        readonly process: OpenCodeOwnedServerProcess;
        readonly serverScope: Scope.Closeable;
        readonly operation: TextGenerationOperation;
      }) {
        const resource: OwnedOpenCodeTextGenerationServerResource = {
          process: input.process,
          server: null,
          serverScope: input.serverScope,
          operation: input.operation,
          registration: null,
          closeFailure: null,
          closed: false,
        };
        ownedServerResources.add(resource);
        const resourceId = `${config.serviceName}:${nextOwnedResourceId}`;
        nextOwnedResourceId += 1;
        resource.registration = yield* maintenanceOwnedResources.register({
          provider: config.provider,
          resourceId,
          close: () => closeRegisteredResource(resource),
        });
        return resource;
      },
    );

    const closeFailedStartupResources = Effect.fn("closeFailedOpenCodeTextGenerationStarts")(
      function* () {
        for (const resource of Array.from(ownedServerResources)) {
          if (resource.server === null) {
            yield* closeOwnedServerResource(resource);
          }
        }
      },
    );

    const closeSharedServer = Effect.fn("closeSharedServer")(function* (
      expectedResource?: OwnedOpenCodeTextGenerationServerResource,
    ) {
      const resource = sharedServerState.resource;
      if (resource === null || (expectedResource !== undefined && resource !== expectedResource)) {
        return;
      }
      yield* closeOwnedServerResource(resource);
    });

    const reportBackgroundCloseFailure = (cause: TextGenerationError) =>
      Effect.logError(
        `${config.displayName} text-generation server remains registered after shutdown failure`,
        { cause },
      );

    const watchReadyServerExit = Effect.fn("watchReadyOpenCodeTextGenerationServerExit")(function* (
      resource: ReadyOpenCodeTextGenerationServerResource,
    ) {
      yield* resource.server.exitCode.pipe(
        Effect.flatMap(() =>
          sharedServerMutex.withPermit(
            Effect.gen(function* () {
              if (resource.closed) {
                return;
              }
              if (sharedServerState.resource === resource) {
                yield* cancelIdleCloseFiber();
              }
              // A root exit does not prove descendants are gone. Keep the mutex until the exact
              // owner proves process-tree exit and the shared cache is cleared or retained for retry.
              yield* closeOwnedServerResource(resource);
            }),
          ),
        ),
        Effect.catch(reportBackgroundCloseFailure),
        Effect.forkIn(idleFiberScope),
      );
    });

    const scheduleIdleClose = Effect.fn("scheduleIdleClose")(function* (
      resource: OwnedOpenCodeTextGenerationServerResource,
    ) {
      yield* cancelIdleCloseFiber();
      const fiber = yield* Effect.sleep(OPENCODE_TEXT_GENERATION_IDLE_TTL).pipe(
        Effect.andThen(
          sharedServerMutex.withPermit(
            Effect.gen(function* () {
              if (sharedServerState.resource !== resource || sharedServerState.activeRequests > 0) {
                return;
              }
              sharedServerState.idleCloseFiber = null;
              yield* closeSharedServer(resource).pipe(Effect.catch(reportBackgroundCloseFailure));
            }),
          ),
        ),
        Effect.forkIn(idleFiberScope),
      );
      sharedServerState.idleCloseFiber = fiber;
    });

    const acquireSharedServer = (input: {
      readonly binaryPath: string;
      readonly cwd: string;
      readonly operation: TextGenerationOperation;
    }) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          yield* cancelIdleCloseFiber();
          // Failed readiness never exposes a server, but its exact process owner remains here until
          // either a later request or provider maintenance proves cleanup and unregisters it.
          yield* closeFailedStartupResources();

          const startServer = Effect.fn("startOpenCodeTextGenerationServer")(() =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const serverScope = yield* Scope.make();
                const ownedResourceRef =
                  yield* Ref.make<OwnedOpenCodeTextGenerationServerResource | null>(null);
                const startedExit = yield* Effect.exit(
                  restore(
                    openCodeRuntime
                      .startOpenCodeServerProcess({
                        binaryPath: input.binaryPath,
                        cliSpec: config.cliSpec,
                        cwd: input.cwd,
                        onProcessOwned: (process) =>
                          registerOwnedServerResource({
                            process,
                            serverScope,
                            operation: input.operation,
                          }).pipe(
                            Effect.flatMap((resource) => Ref.set(ownedResourceRef, resource)),
                          ),
                      })
                      .pipe(
                        Effect.provideService(Scope.Scope, serverScope),
                        Effect.mapError(
                          (cause) =>
                            new TextGenerationError({
                              operation: input.operation,
                              detail: openCodeRuntimeErrorDetail(cause),
                              cause,
                            }),
                        ),
                      ),
                  ),
                );
                let resource = yield* Ref.get(ownedResourceRef);

                if (startedExit._tag === "Failure") {
                  if (resource === null) {
                    yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
                  } else {
                    // Preserve the original startup failure while retaining any rejected cleanup
                    // in both the local owner set and the provider maintenance coordinator.
                    yield* closeOwnedServerResource(resource).pipe(Effect.ignore);
                  }
                  return yield* Effect.failCause(startedExit.cause);
                }

                // Compatibility fallback for non-live runtime implementations that do not consume
                // the early ownership hook. Production always registers before readiness awaits.
                if (resource === null) {
                  resource = yield* registerOwnedServerResource({
                    process: startedExit.value,
                    serverScope,
                    operation: input.operation,
                  });
                }
                resource.server = startedExit.value;
                const readyResource = resource as ReadyOpenCodeTextGenerationServerResource;
                yield* watchReadyServerExit(readyResource);
                return readyResource;
              }),
            ),
          );

          let existingResource = sharedServerState.resource;
          if (existingResource !== null && existingResource.closeFailure !== null) {
            yield* closeSharedServer(existingResource);
            existingResource = sharedServerState.resource;
          }
          if (existingResource !== null) {
            const sameConfigScope =
              sharedServerState.binaryPath === input.binaryPath &&
              sharedServerState.cwd === input.cwd;
            if (!sameConfigScope && sharedServerState.activeRequests === 0) {
              yield* closeSharedServer(existingResource);
            } else {
              if (!sameConfigScope) {
                yield* Effect.logWarning(
                  `${config.displayName} shared server config scope mismatch: requested ` +
                    input.binaryPath +
                    " at " +
                    input.cwd +
                    " but active server uses " +
                    sharedServerState.binaryPath +
                    " at " +
                    sharedServerState.cwd +
                    "; starting a dedicated server for this request",
                );
                const dedicatedResource = yield* startServer();
                return {
                  resource: dedicatedResource,
                  shared: false,
                } satisfies AcquiredOpenCodeTextGenerationServer;
              }
              sharedServerState.activeRequests += 1;
              return {
                resource: existingResource,
                shared: true,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }
          }

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const resource = yield* restore(startServer());
              sharedServerState.resource = resource;
              sharedServerState.binaryPath = input.binaryPath;
              sharedServerState.cwd = input.cwd;
              sharedServerState.activeRequests = 1;
              return {
                resource,
                shared: true,
              } satisfies AcquiredOpenCodeTextGenerationServer;
            }),
          );
        }),
      );

    const releaseSharedServer = (acquired: AcquiredOpenCodeTextGenerationServer) =>
      sharedServerMutex.withPermit(
        Effect.gen(function* () {
          if (!acquired.shared) {
            yield* closeOwnedServerResource(acquired.resource).pipe(
              Effect.catch(reportBackgroundCloseFailure),
            );
            return;
          }
          if (sharedServerState.resource !== acquired.resource) {
            return;
          }
          sharedServerState.activeRequests = Math.max(0, sharedServerState.activeRequests - 1);
          if (sharedServerState.activeRequests === 0) {
            yield* scheduleIdleClose(acquired.resource);
          }
        }),
      );

    yield* Effect.addFinalizer(() =>
      sharedServerMutex
        .withPermit(
          Effect.gen(function* () {
            yield* cancelIdleCloseFiber();
            sharedServerState.activeRequests = 0;
            for (const resource of Array.from(ownedServerResources)) {
              yield* closeOwnedServerResource(resource);
            }
          }),
        )
        .pipe(Effect.orDie),
    );

    const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
      readonly operation: TextGenerationOperation;
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchemaJson: S;
      readonly rawTextFallback?: RawTextFallback;
      readonly modelSelection: OpenCodeCompatibleModelSelection;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
      readonly providerOptions?: ProviderStartOptions;
    }) {
      const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
      if (!parsedModel) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `${config.displayName} model selection must use the 'provider/model' format.`,
        });
      }

      const providerOptions = input.providerOptions?.[config.provider];
      const binaryPath = providerOptions?.binaryPath?.trim() || config.cliSpec.defaultBinaryPath;
      const serverUrl = providerOptions?.serverUrl?.trim() || "";
      const serverPassword = config.resolveServerPassword
        ? ((yield* config.resolveServerPassword(config.provider)) ?? "")
        : "";
      const providerId = parsedModel.providerID;
      const modelId = parsedModel.modelID;
      const modelOptions = input.modelSelection.options as OpenCodeModelOptions | undefined;
      const agent = modelOptions?.agent?.trim();
      const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant")?.trim();

      const promptText =
        appendFileAttachmentsPromptBlock({
          text: input.prompt,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        }) ?? input.prompt;
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveProviderAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });

      const runAgainstServer = (server: Pick<OpenCodeServerConnection, "url">) =>
        Effect.tryPromise({
          try: async () => {
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: input.cwd,
              ...(serverPassword.length > 0 ? { serverPassword } : {}),
              cliSpec: config.cliSpec,
            });
            const sessionCreateInput = {
              title: `Synara ${input.operation}`,
              model: {
                providerID: providerId,
                id: modelId,
                ...(variant ? { variant } : {}),
              },
              ...(agent ? { agent } : {}),
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            };
            const session = await client.session.create(
              sessionCreateInput as unknown as Parameters<typeof client.session.create>[0],
            );
            if (!session.data) {
              throw new Error("OpenCode session.create returned no session payload.");
            }

            const result = await client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(agent ? { agent } : {}),
              ...(variant ? { variant } : {}),
              parts: [{ type: "text", text: promptText }, ...fileParts],
            });
            const info = result.data?.info;
            const errorMessage = getOpenCodePromptErrorMessage(info?.error);
            if (errorMessage) {
              throw new Error(errorMessage);
            }
            const rawText = getOpenCodeTextResponse(result.data?.parts);
            if (rawText.length === 0) {
              throw new Error("OpenCode returned empty output.");
            }
            return rawText;
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: [
                openCodeRuntimeErrorDetail(cause),
                `model=${providerId}/${modelId}`,
                variant ? `variant=${variant}` : null,
                agent ? `agent=${agent}` : null,
                serverUrl.length > 0 ? "server=external" : "server=managed",
              ]
                .filter(Boolean)
                .join(" "),
              cause,
            }),
        });

      yield* Effect.logDebug("OpenCode text generation request", {
        operation: input.operation,
        cwd: input.cwd,
        providerId,
        modelId,
        variant,
        agent,
        attachmentCount: input.attachments?.length ?? 0,
        filePartCount: fileParts.length,
        binaryPath,
        usingExternalServer: serverUrl.length > 0,
      });

      const rawOutput =
        serverUrl.length > 0
          ? yield* runAgainstServer({ url: serverUrl })
          : yield* Effect.acquireUseRelease(
              acquireSharedServer({
                binaryPath,
                cwd: input.cwd,
                operation: input.operation,
              }),
              (acquired) => runAgainstServer(acquired.resource.server),
              releaseSharedServer,
            );

      return yield* decodeStructuredTextGenerationOutput({
        schema: input.outputSchemaJson,
        raw: rawOutput,
        operation: input.operation,
        providerLabel: config.displayName,
        ...(input.rawTextFallback ? { rawTextFallback: input.rawTextFallback } : {}),
      });
    });

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
      `${config.serviceName}.generateCommitMessage`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateCommitMessage",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

    const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
      `${config.serviceName}.generatePrContent`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generatePrContent",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

    const generateDiffSummary: TextGenerationShape["generateDiffSummary"] = Effect.fn(
      `${config.serviceName}.generateDiffSummary`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateDiffSummary",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildDiffSummaryPrompt({
        patch: input.patch,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateDiffSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        summary: sanitizeDiffSummary(generated.summary),
      };
    });

    const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
      `${config.serviceName}.generateBranchName`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateBranchName",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildBranchNamePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

    const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
      `${config.serviceName}.generateThreadTitle`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildThreadTitlePrompt({
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        title: sanitizeGeneratedThreadTitle(generated.title),
      };
    });

    const generateThreadRecap: TextGenerationShape["generateThreadRecap"] = Effect.fn(
      `${config.serviceName}.generateThreadRecap`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateThreadRecap",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson, rawTextFallback } = buildThreadRecapPrompt({
        ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
        newMaterial: input.newMaterial,
        ...(input.currentState ? { currentState: input.currentState } : {}),
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadRecap",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        rawTextFallback,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });

      return {
        recap: sanitizeThreadRecap(generated.recap, input.previousRecap),
      };
    });

    const generateAutomationIntent: TextGenerationShape["generateAutomationIntent"] = Effect.fn(
      `${config.serviceName}.generateAutomationIntent`,
    )(function* (input) {
      const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
      if (!modelSelection) {
        return yield* new TextGenerationError({
          operation: "generateAutomationIntent",
          detail: `Invalid ${config.displayName} model selection.`,
        });
      }

      const { prompt, outputSchemaJson } = buildAutomationIntentPrompt({
        message: input.message,
        ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
        nowIso: input.nowIso,
      });
      return yield* runOpenCodeJson({
        operation: "generateAutomationIntent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      });
    });

    const evaluateAutomationCompletion: TextGenerationShape["evaluateAutomationCompletion"] =
      Effect.fn(`${config.serviceName}.evaluateAutomationCompletion`)(function* (input) {
        const modelSelection = resolveOpenCodeCompatibleModelSelection(config, input);
        if (!modelSelection) {
          return yield* new TextGenerationError({
            operation: "evaluateAutomationCompletion",
            detail: `Invalid ${config.displayName} model selection.`,
          });
        }

        const { prompt, outputSchemaJson } = buildAutomationCompletionEvaluationPrompt(input);
        return yield* runOpenCodeJson({
          operation: "evaluateAutomationCompletion",
          cwd: input.cwd,
          prompt,
          outputSchemaJson,
          modelSelection,
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        });
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateDiffSummary,
      generateBranchName,
      generateThreadTitle,
      generateThreadRecap,
      generateAutomationIntent,
      evaluateAutomationCompletion,
    } satisfies TextGenerationShape;
  });

export const makeOpenCodeTextGenerationServiceLive = (
  resolveServerPassword?: OpenCodeCompatibleTextGenerationConfig["resolveServerPassword"],
  options?: OpenCodeCompatibleTextGenerationLiveOptions,
) =>
  Layer.effect(
    OpenCodeTextGeneration,
    makeOpenCodeCompatibleTextGeneration({
      provider: "opencode",
      displayName: "OpenCode",
      serviceName: "OpenCodeTextGeneration",
      cliSpec: OPENCODE_CLI_SPEC,
      ...(resolveServerPassword ? { resolveServerPassword } : {}),
      ...(options?.maintenanceOwnedResources
        ? { maintenanceOwnedResources: options.maintenanceOwnedResources }
        : {}),
    }),
  );

export const makeKiloTextGenerationServiceLive = (
  resolveServerPassword?: OpenCodeCompatibleTextGenerationConfig["resolveServerPassword"],
  options?: OpenCodeCompatibleTextGenerationLiveOptions,
) =>
  Layer.effect(
    KiloTextGeneration,
    makeOpenCodeCompatibleTextGeneration({
      provider: "kilo",
      displayName: "Kilo",
      serviceName: "KiloTextGeneration",
      cliSpec: KILO_CLI_SPEC,
      ...(resolveServerPassword ? { resolveServerPassword } : {}),
      ...(options?.maintenanceOwnedResources
        ? { maintenanceOwnedResources: options.maintenanceOwnedResources }
        : {}),
    }),
  );

export const OpenCodeTextGenerationServiceLive = makeOpenCodeTextGenerationServiceLive();
export const KiloTextGenerationServiceLive = makeKiloTextGenerationServiceLive();
