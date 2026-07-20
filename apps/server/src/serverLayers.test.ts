import { Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRuntimeLayerMocks = vi.hoisted(() => ({
  makeGitLayerLive: vi.fn(),
  makeTextGenerationLayerLive: vi.fn(),
}));

vi.mock("./git/runtimeLayer", () => ({
  makeGitLayerLive: gitRuntimeLayerMocks.makeGitLayerLive,
  makeTextGenerationLayerLive: gitRuntimeLayerMocks.makeTextGenerationLayerLive,
}));

import { makeServerRuntimeServicesLayer } from "./serverLayers";

describe("server runtime layer assembly", () => {
  beforeEach(() => {
    gitRuntimeLayerMocks.makeGitLayerLive.mockReset();
    gitRuntimeLayerMocks.makeTextGenerationLayerLive.mockReset();
  });

  it("constructs one text-generation layer and passes its identity into the Git graph", () => {
    const textGenerationLayer = Layer.empty;
    const gitLayer = Layer.empty;
    gitRuntimeLayerMocks.makeTextGenerationLayerLive.mockReturnValue(textGenerationLayer);
    gitRuntimeLayerMocks.makeGitLayerLive.mockReturnValue(gitLayer);

    makeServerRuntimeServicesLayer();

    expect(gitRuntimeLayerMocks.makeTextGenerationLayerLive).toHaveBeenCalledTimes(1);
    expect(gitRuntimeLayerMocks.makeGitLayerLive).toHaveBeenCalledTimes(1);
    expect(gitRuntimeLayerMocks.makeGitLayerLive).toHaveBeenCalledWith(undefined, {
      textGenerationLayer,
    });
  });
});
