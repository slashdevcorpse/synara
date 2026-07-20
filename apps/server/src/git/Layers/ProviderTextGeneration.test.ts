import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CodexTextGeneration,
  CursorTextGeneration,
  KiloTextGeneration,
  OpenCodeTextGeneration,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  makeProviderTextGenerationLive,
  ProviderTextGenerationLive,
  type ProviderTextGenerationLiveOptions,
} from "./ProviderTextGeneration.ts";
import { makeProviderMaintenanceGate } from "../../provider/providerMaintenanceGate.ts";
import { TextGenerationError } from "../Errors.ts";

function createTextGenerationDouble(label: string) {
  const generateCommitMessage = vi.fn<TextGenerationShape["generateCommitMessage"]>(() =>
    Effect.succeed({
      subject: `${label} commit`,
      body: "",
    }),
  );
  const generatePrContent = vi.fn<TextGenerationShape["generatePrContent"]>(() =>
    Effect.succeed({
      title: `${label} pr`,
      body: "",
    }),
  );
  const generateDiffSummary = vi.fn<TextGenerationShape["generateDiffSummary"]>(() =>
    Effect.succeed({
      summary: `${label} summary`,
    }),
  );
  const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
    Effect.succeed({
      branch: `${label}-branch`,
    }),
  );
  const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
    Effect.succeed({
      title: `${label} title`,
    }),
  );
  const generateThreadRecap = vi.fn<TextGenerationShape["generateThreadRecap"]>(() =>
    Effect.succeed({
      recap: `${label} recap`,
    }),
  );
  const generateAutomationIntent = vi.fn<TextGenerationShape["generateAutomationIntent"]>(() =>
    Effect.succeed({
      isAutomation: true,
      confidence: 1,
      language: null,
      name: `${label} automation`,
      taskPrompt: "Check the site",
      schedule: { type: "interval", everySeconds: 3600 },
      mode: "heartbeat",
      completionPolicy: { type: "none" },
      missingFields: [],
      needsConfirmation: false,
      reason: null,
    }),
  );
  const evaluateAutomationCompletion = vi.fn<TextGenerationShape["evaluateAutomationCompletion"]>(
    () =>
      Effect.succeed({
        stopMatched: false,
        confidence: 0.2,
        reason: `${label} completion`,
      }),
  );

  return {
    service: {
      generateCommitMessage,
      generatePrContent,
      generateDiffSummary,
      generateBranchName,
      generateThreadTitle,
      generateThreadRecap,
      generateAutomationIntent,
      evaluateAutomationCompletion,
    } satisfies TextGenerationShape,
    generateCommitMessage,
    generatePrContent,
    generateDiffSummary,
    generateBranchName,
    generateThreadTitle,
    generateThreadRecap,
    generateAutomationIntent,
    evaluateAutomationCompletion,
  };
}

function makeProviderTextGenerationTestLayer(options?: ProviderTextGenerationLiveOptions) {
  const codex = createTextGenerationDouble("codex");
  const cursor = createTextGenerationDouble("cursor");
  const kilo = createTextGenerationDouble("kilo");
  const opencode = createTextGenerationDouble("opencode");
  const layer = (options ? makeProviderTextGenerationLive(options) : ProviderTextGenerationLive).pipe(
    Layer.provide(Layer.succeed(CodexTextGeneration, codex.service)),
    Layer.provide(Layer.succeed(CursorTextGeneration, cursor.service)),
    Layer.provide(Layer.succeed(KiloTextGeneration, kilo.service)),
    Layer.provide(Layer.succeed(OpenCodeTextGeneration, opencode.service)),
  );

  return { layer, codex, cursor, kilo, opencode };
}

describe("ProviderTextGenerationLive", () => {
  it("routes standard git-writing models to Codex", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          model: "gpt-5.4-mini",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.summary).toBe("codex summary");
    expect(codex.generateDiffSummary).toHaveBeenCalledTimes(1);
    expect(cursor.generateDiffSummary).not.toHaveBeenCalled();
    expect(opencode.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("refuses git text generation while the selected provider is under maintenance", async () => {
    const maintenanceGate = Effect.runSync(makeProviderMaintenanceGate);
    const codex = createTextGenerationDouble("codex");
    const cursor = createTextGenerationDouble("cursor");
    const kilo = createTextGenerationDouble("kilo");
    const opencode = createTextGenerationDouble("opencode");
    const layer = makeProviderTextGenerationLive({ maintenanceGate }).pipe(
      Layer.provide(Layer.succeed(CodexTextGeneration, codex.service)),
      Layer.provide(Layer.succeed(CursorTextGeneration, cursor.service)),
      Layer.provide(Layer.succeed(KiloTextGeneration, kilo.service)),
      Layer.provide(Layer.succeed(OpenCodeTextGeneration, opencode.service)),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const maintenanceStarted = yield* Deferred.make<void>();
          const releaseMaintenance = yield* Deferred.make<void>();
          const maintenance = yield* maintenanceGate
            .withExclusiveMaintenance({
              provider: "codex",
              run: Deferred.succeed(maintenanceStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseMaintenance)),
              ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(maintenanceStarted);
          const generated = yield* Effect.gen(function* () {
            const textGeneration = yield* TextGeneration;
            return yield* textGeneration
              .generateDiffSummary({
                cwd: "/repo",
                patch: "diff --git a/file.ts b/file.ts",
                model: "gpt-5.4-mini",
              })
              .pipe(Effect.result);
          }).pipe(Effect.provide(layer));
          yield* Deferred.succeed(releaseMaintenance, undefined);
          yield* Fiber.join(maintenance);
          return generated;
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(TextGenerationError);
      expect(result.failure.message).toContain("being updated");
    }
    expect(codex.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("preserves restart guidance when provider maintenance is latched", async () => {
    const maintenanceGate = Effect.runSync(makeProviderMaintenanceGate);
    const { layer, codex } = makeProviderTextGenerationTestLayer({ maintenanceGate });
    await Effect.runPromise(
      maintenanceGate.latchProvider({
        provider: "codex",
        reason: "descendant 42 survived updater teardown",
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration
          .generateDiffSummary({
            cwd: "/repo",
            patch: "diff --git a/file.ts b/file.ts",
            model: "gpt-5.4-mini",
          })
          .pipe(Effect.result);
      }).pipe(Effect.provide(layer)),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain("Restart Synara before retrying");
      expect(result.failure.message).toContain("descendant 42 survived updater teardown");
    }
    expect(codex.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("routes OpenCode provider/model slugs to OpenCode", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          model: "openai/gpt-5",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.summary).toBe("opencode summary");
    expect(opencode.generateDiffSummary).toHaveBeenCalledTimes(1);
    expect(codex.generateDiffSummary).not.toHaveBeenCalled();
    expect(cursor.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("routes explicit Kilo model selections through Kilo text generation", async () => {
    const { layer, codex, kilo, opencode } = makeProviderTextGenerationTestLayer();

    await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        yield* textGeneration.generateDiffSummary({
          cwd: "/repo",
          patch: "diff --git a/file.ts b/file.ts",
          modelSelection: {
            provider: "kilo",
            model: "kilo/kilo-auto/free",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(kilo.generateDiffSummary).toHaveBeenCalledTimes(1);
    expect(opencode.generateDiffSummary).not.toHaveBeenCalled();
    expect(codex.generateDiffSummary).not.toHaveBeenCalled();
  });

  it("routes explicit OpenCode model selections and preserves provider options", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateThreadTitle({
          cwd: "/repo",
          message: "Plan the deployment work",
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5",
            options: {
              agent: "plan",
              variant: "balanced",
            },
          },
          providerOptions: {
            opencode: {
              binaryPath: "/custom/bin/opencode",
              serverUrl: "http://127.0.0.1:4096",
            },
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.title).toBe("opencode title");
    expect(opencode.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: {
            agent: "plan",
            variant: "balanced",
          },
        },
        providerOptions: {
          opencode: {
            binaryPath: "/custom/bin/opencode",
            serverUrl: "http://127.0.0.1:4096",
          },
        },
      }),
    );
    expect(codex.generateThreadTitle).not.toHaveBeenCalled();
    expect(cursor.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("routes explicit Cursor model selections and preserves provider options", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateThreadTitle({
          cwd: "/repo",
          message: "Plan the Cursor integration work",
          modelSelection: {
            provider: "cursor",
            model: "composer-2",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          providerOptions: {
            cursor: {
              binaryPath: "/custom/bin/agent",
              apiEndpoint: "http://127.0.0.1:3947",
            },
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.title).toBe("cursor title");
    expect(cursor.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          provider: "cursor",
          model: "composer-2",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        providerOptions: {
          cursor: {
            binaryPath: "/custom/bin/agent",
            apiEndpoint: "http://127.0.0.1:3947",
          },
        },
      }),
    );
    expect(codex.generateThreadTitle).not.toHaveBeenCalled();
    expect(opencode.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("routes automation intent generation through the selected provider", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.generateAutomationIntent({
          cwd: "/repo",
          message: "every 6h check the Amazon listing",
          defaultMode: "heartbeat",
          nowIso: "2026-06-19T10:00:00.000Z",
          modelSelection: {
            provider: "cursor",
            model: "composer-2",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.name).toBe("cursor automation");
    expect(cursor.generateAutomationIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "every 6h check the Amazon listing",
        defaultMode: "heartbeat",
      }),
    );
    expect(codex.generateAutomationIntent).not.toHaveBeenCalled();
    expect(opencode.generateAutomationIntent).not.toHaveBeenCalled();
  });

  it("routes automation completion evaluation through the selected provider", async () => {
    const { layer, codex, cursor, opencode } = makeProviderTextGenerationTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        return yield* textGeneration.evaluateAutomationCompletion({
          cwd: "/repo",
          automationName: "Watch PR",
          automationPrompt: "Check PR readiness.",
          stopWhen: "the PR is ready",
          runUserMessage: "Check PR readiness.",
          runAssistantText: "Still working.",
          modelSelection: {
            provider: "cursor",
            model: "composer-2",
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.reason).toBe("cursor completion");
    expect(cursor.evaluateAutomationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        stopWhen: "the PR is ready",
      }),
    );
    expect(codex.evaluateAutomationCompletion).not.toHaveBeenCalled();
    expect(opencode.evaluateAutomationCompletion).not.toHaveBeenCalled();
  });
});
