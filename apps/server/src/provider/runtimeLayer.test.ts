import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeProviderAdapterMaintenanceOptions } from "./runtimeLayer";
import { makeProviderMaintenanceOwnedResourceCoordinator } from "./providerMaintenanceOwnedResources";

describe("provider runtime layer maintenance ownership", () => {
  it("shares one coordinator identity across every process-owning adapter", () => {
    const maintenanceOwnedResources = Effect.runSync(
      makeProviderMaintenanceOwnedResourceCoordinator,
    );
    const options = makeProviderAdapterMaintenanceOptions(maintenanceOwnedResources);

    expect(Object.values(options)).toHaveLength(8);
    expect(options.claude).toBe(options.commandCode);
    expect(options.claude.maintenanceOwnedResources).toBe(maintenanceOwnedResources);
    for (const adapterOptions of Object.values(options)) {
      expect(adapterOptions).toBe(options.commandCode);
      expect(adapterOptions.maintenanceOwnedResources).toBe(maintenanceOwnedResources);
    }
  });
});
