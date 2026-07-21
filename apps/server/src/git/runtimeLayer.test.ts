import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import { TextGeneration, type TextGenerationShape } from "./Services/TextGeneration";
import { makeGitLayerLive } from "./runtimeLayer";

const unused = (operation: string) =>
  Effect.die(`${operation} should not run during layer assembly`);

const textGenerationService: TextGenerationShape = {
  generateCommitMessage: () => unused("generateCommitMessage"),
  generatePrContent: () => unused("generatePrContent"),
  generateDiffSummary: () => unused("generateDiffSummary"),
  generateBranchName: () => unused("generateBranchName"),
  generateThreadTitle: () => unused("generateThreadTitle"),
  generateThreadRecap: () => unused("generateThreadRecap"),
  generateAutomationIntent: () => unused("generateAutomationIntent"),
  evaluateAutomationCompletion: () => unused("evaluateAutomationCompletion"),
};

describe("Git runtime layer assembly", () => {
  it("acquires one shared text-generation layer for top-level and Git consumers", async () => {
    let textGenerationAcquisitions = 0;
    const textGenerationLayer = Layer.effect(
      TextGeneration,
      Effect.sync(() => {
        textGenerationAcquisitions += 1;
        return textGenerationService;
      }),
    );
    const gitLayer = makeGitLayerLive(undefined, { textGenerationLayer });
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-git-runtime-layer-test-",
    });
    const testLayer = Layer.mergeAll(textGenerationLayer, gitLayer).pipe(
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(Layer.build(testLayer).pipe(Effect.scoped));

    expect(textGenerationAcquisitions).toBe(1);
  });
});
