import type { ProviderKind } from "@synara/contracts";
import { Effect, Layer } from "effect";

import { parseOpenCodeModelSlug } from "../../provider/opencodeRuntime.ts";
import {
  makeProviderMaintenanceGate,
  type ProviderMaintenanceGate,
} from "../../provider/providerMaintenanceGate.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  CodexTextGeneration,
  CursorTextGeneration,
  KiloTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  type TextGenerationOperation,
  TextGeneration,
} from "../Services/TextGeneration.ts";

export interface ProviderTextGenerationLiveOptions {
  readonly maintenanceGate?: ProviderMaintenanceGate;
}

const makeProviderTextGeneration = (options?: ProviderTextGenerationLiveOptions) =>
  Effect.gen(function* () {
    const codexTextGeneration = yield* CodexTextGeneration;
    const cursorTextGeneration = yield* CursorTextGeneration;
    const kiloTextGeneration = yield* KiloTextGeneration;
    const openCodeTextGeneration = yield* OpenCodeTextGeneration;
    const maintenanceGate = options?.maintenanceGate ?? (yield* makeProviderMaintenanceGate);

    const resolveImplementation = (input: {
      readonly model?: string;
      readonly modelSelection?: { provider: string };
    }): { readonly provider: ProviderKind; readonly service: TextGenerationShape } => {
      if (input.modelSelection?.provider === "cursor") {
        return { provider: "cursor", service: cursorTextGeneration };
      }
      if (input.modelSelection?.provider === "kilo") {
        return { provider: "kilo", service: kiloTextGeneration };
      }
      if (input.modelSelection?.provider === "opencode") {
        return { provider: "opencode", service: openCodeTextGeneration };
      }
      return parseOpenCodeModelSlug(input.model) !== null
        ? { provider: "opencode", service: openCodeTextGeneration }
        : { provider: "codex", service: codexTextGeneration };
    };

    const runWithProviderMaintenance = <A>(input: {
      readonly operation: TextGenerationOperation;
      readonly provider: ProviderKind;
      readonly run: Effect.Effect<A, TextGenerationError>;
    }) =>
      maintenanceGate
        .withOperation({
          provider: input.provider,
          operation: `TextGeneration.${input.operation}`,
          run: input.run,
        })
        .pipe(
          Effect.catchTag("ProviderMaintenanceBusyError", (error) =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: error.message,
                cause: error,
              }),
            ),
          ),
        );

    const run = <A>(
      operation: TextGenerationOperation,
      input: { readonly model?: string; readonly modelSelection?: { provider: string } },
      invoke: (service: TextGenerationShape) => Effect.Effect<A, TextGenerationError>,
    ) => {
      const resolved = resolveImplementation(input);
      return runWithProviderMaintenance({
        operation,
        provider: resolved.provider,
        run: Effect.suspend(() => invoke(resolved.service)),
      });
    };

    return {
      generateCommitMessage: (input) =>
        run("generateCommitMessage", input, (service) => service.generateCommitMessage(input)),
      generatePrContent: (input) =>
        run("generatePrContent", input, (service) => service.generatePrContent(input)),
      generateDiffSummary: (input) =>
        run("generateDiffSummary", input, (service) => service.generateDiffSummary(input)),
      generateBranchName: (input) =>
        run("generateBranchName", input, (service) => service.generateBranchName(input)),
      generateThreadTitle: (input) =>
        run("generateThreadTitle", input, (service) => service.generateThreadTitle(input)),
      generateThreadRecap: (input) =>
        run("generateThreadRecap", input, (service) => service.generateThreadRecap(input)),
      generateAutomationIntent: (input) =>
        run("generateAutomationIntent", input, (service) =>
          service.generateAutomationIntent(input),
        ),
      evaluateAutomationCompletion: (input) =>
        run("evaluateAutomationCompletion", input, (service) =>
          service.evaluateAutomationCompletion(input),
        ),
    } satisfies TextGenerationShape;
  });

export function makeProviderTextGenerationLive(options?: ProviderTextGenerationLiveOptions) {
  return Layer.effect(TextGeneration, makeProviderTextGeneration(options));
}

export const ProviderTextGenerationLive = makeProviderTextGenerationLive();
