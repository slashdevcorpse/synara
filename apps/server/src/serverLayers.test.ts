import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRuntimeLayerMocks = vi.hoisted(() => ({
  makeGitLayerLive: vi.fn(),
  makeTextGenerationLayerLive: vi.fn(),
}));
const providerRuntimeLayerMocks = vi.hoisted(() => ({
  makeServerProviderLayer: vi.fn(),
}));
const providerHealthLayerMocks = vi.hoisted(() => ({
  makeProviderHealthLive: vi.fn(),
}));

vi.mock("./git/runtimeLayer", () => ({
  makeGitLayerLive: gitRuntimeLayerMocks.makeGitLayerLive,
  makeTextGenerationLayerLive: gitRuntimeLayerMocks.makeTextGenerationLayerLive,
}));
vi.mock("./provider/runtimeLayer", () => ({
  makeServerProviderLayer: providerRuntimeLayerMocks.makeServerProviderLayer,
}));
vi.mock("./provider/Layers/ProviderHealth", () => ({
  makeProviderHealthLive: providerHealthLayerMocks.makeProviderHealthLive,
}));

import { makeServerApplicationLayers, makeServerRuntimeServicesLayer } from "./serverLayers";
import { makeProviderMaintenanceGate } from "./provider/providerMaintenanceGate";
import { makeProviderMaintenanceOwnedResourceCoordinator } from "./provider/providerMaintenanceOwnedResources";

describe("server runtime layer assembly", () => {
  beforeEach(() => {
    gitRuntimeLayerMocks.makeGitLayerLive.mockReset();
    gitRuntimeLayerMocks.makeTextGenerationLayerLive.mockReset();
    providerRuntimeLayerMocks.makeServerProviderLayer.mockReset();
    providerRuntimeLayerMocks.makeServerProviderLayer.mockReturnValue(Layer.empty);
    providerHealthLayerMocks.makeProviderHealthLive.mockReset();
    providerHealthLayerMocks.makeProviderHealthLive.mockReturnValue(Layer.empty);
  });

  it("constructs one fallback coordination pair and one text-generation layer", () => {
    const textGenerationLayer = Layer.empty;
    const gitLayer = Layer.empty;
    gitRuntimeLayerMocks.makeTextGenerationLayerLive.mockReturnValue(textGenerationLayer);
    gitRuntimeLayerMocks.makeGitLayerLive.mockReturnValue(gitLayer);

    makeServerRuntimeServicesLayer();

    expect(providerRuntimeLayerMocks.makeServerProviderLayer).toHaveBeenCalledTimes(1);
    expect(providerHealthLayerMocks.makeProviderHealthLive).toHaveBeenCalledTimes(1);
    expect(gitRuntimeLayerMocks.makeTextGenerationLayerLive).toHaveBeenCalledTimes(1);
    expect(gitRuntimeLayerMocks.makeGitLayerLive).toHaveBeenCalledTimes(1);
    const maintenanceOptions = gitRuntimeLayerMocks.makeTextGenerationLayerLive.mock.calls[0]?.[0];
    const providerOptions = providerRuntimeLayerMocks.makeServerProviderLayer.mock.calls[0]?.[0];
    const providerHealthOptions =
      providerHealthLayerMocks.makeProviderHealthLive.mock.calls[0]?.[0];
    const gitOptions = gitRuntimeLayerMocks.makeGitLayerLive.mock.calls[0]?.[0];
    expect(maintenanceOptions?.maintenanceGate).toBeDefined();
    expect(maintenanceOptions?.maintenanceOwnedResources).toBeDefined();
    expect(providerOptions?.maintenanceGate).toBe(maintenanceOptions?.maintenanceGate);
    expect(providerHealthOptions).toBe(maintenanceOptions);
    expect(gitOptions).toBe(maintenanceOptions);
    expect(gitRuntimeLayerMocks.makeGitLayerLive.mock.calls[0]?.[1]).toEqual({
      textGenerationLayer,
    });
  });

  it("reuses the fallback coordination pair across both application graphs", () => {
    const providerLayer = Layer.empty;
    const textGenerationLayer = Layer.empty;
    const gitLayer = Layer.empty;
    providerRuntimeLayerMocks.makeServerProviderLayer.mockReturnValue(providerLayer);
    gitRuntimeLayerMocks.makeTextGenerationLayerLive.mockReturnValue(textGenerationLayer);
    gitRuntimeLayerMocks.makeGitLayerLive.mockReturnValue(gitLayer);

    const layers = makeServerApplicationLayers();

    expect(layers.providerLayer).toBe(providerLayer);
    expect(providerRuntimeLayerMocks.makeServerProviderLayer).toHaveBeenCalledTimes(1);
    expect(providerHealthLayerMocks.makeProviderHealthLive).toHaveBeenCalledTimes(1);
    expect(gitRuntimeLayerMocks.makeTextGenerationLayerLive).toHaveBeenCalledTimes(1);
    expect(gitRuntimeLayerMocks.makeGitLayerLive).toHaveBeenCalledTimes(1);
    const maintenanceOptions = gitRuntimeLayerMocks.makeTextGenerationLayerLive.mock.calls[0]?.[0];
    const providerOptions = providerRuntimeLayerMocks.makeServerProviderLayer.mock.calls[0]?.[0];
    const providerHealthOptions =
      providerHealthLayerMocks.makeProviderHealthLive.mock.calls[0]?.[0];
    const gitOptions = gitRuntimeLayerMocks.makeGitLayerLive.mock.calls[0]?.[0];
    expect(maintenanceOptions?.maintenanceGate).toBeDefined();
    expect(maintenanceOptions?.maintenanceOwnedResources).toBeDefined();
    expect(providerOptions?.maintenanceGate).toBe(maintenanceOptions?.maintenanceGate);
    expect(providerHealthOptions).toBe(maintenanceOptions);
    expect(gitOptions).toBe(maintenanceOptions);
    expect(gitRuntimeLayerMocks.makeGitLayerLive.mock.calls[0]?.[1]).toEqual({
      textGenerationLayer,
    });
  });

  it("preserves an explicitly supplied coordination pair across both application graphs", () => {
    const maintenanceGate = Effect.runSync(makeProviderMaintenanceGate);
    const maintenanceOwnedResources = Effect.runSync(
      makeProviderMaintenanceOwnedResourceCoordinator,
    );
    const providerLayer = Layer.empty;
    const textGenerationLayer = Layer.empty;
    providerRuntimeLayerMocks.makeServerProviderLayer.mockReturnValue(providerLayer);
    gitRuntimeLayerMocks.makeTextGenerationLayerLive.mockReturnValue(textGenerationLayer);
    gitRuntimeLayerMocks.makeGitLayerLive.mockReturnValue(Layer.empty);

    makeServerApplicationLayers({ maintenanceGate, maintenanceOwnedResources });

    const maintenanceOptions = gitRuntimeLayerMocks.makeTextGenerationLayerLive.mock.calls[0]?.[0];
    const providerOptions = providerRuntimeLayerMocks.makeServerProviderLayer.mock.calls[0]?.[0];
    const providerHealthOptions =
      providerHealthLayerMocks.makeProviderHealthLive.mock.calls[0]?.[0];
    const gitOptions = gitRuntimeLayerMocks.makeGitLayerLive.mock.calls[0]?.[0];
    expect(maintenanceOptions?.maintenanceGate).toBe(maintenanceGate);
    expect(maintenanceOptions?.maintenanceOwnedResources).toBe(maintenanceOwnedResources);
    expect(providerOptions?.maintenanceGate).toBe(maintenanceGate);
    expect(providerHealthOptions).toBe(maintenanceOptions);
    expect(gitOptions).toBe(maintenanceOptions);
  });
});
