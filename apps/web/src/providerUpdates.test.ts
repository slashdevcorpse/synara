// FILE: providerUpdates.test.ts
// Purpose: Covers provider-update filtering shared by notifications and settings.
// Layer: Web utility tests
// Exports: Vitest suites for providerUpdates.ts

import type { ProviderKind, ServerProviderStatus, ServerSettings } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getProviderUpdatePresentation,
  getVisibleProviderUpdateStatuses,
  isProviderUpdateActive,
  isProviderUpdateIncomplete,
  providerUpdateNotificationKey,
  providerUpdateIncompleteMessage,
  resolveProviderUpdateManualCommand,
  shouldOfferProviderUpdateAction,
  shouldShowProviderUpdateStatus,
  withProviderUpdateTimeout,
} from "./providerUpdates";

afterEach(() => {
  vi.useRealTimers();
});

function providerStatus(
  provider: ProviderKind,
  overrides: Partial<ServerProviderStatus> = {},
): ServerProviderStatus {
  return {
    provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    version: "1.0.0",
    checkedAt: "2026-06-10T10:00:00.000Z",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g provider@latest",
      canUpdate: true,
      checkedAt: "2026-06-10T10:00:00.000Z",
      message: "Update available.",
    },
    ...overrides,
  };
}

function serverSettings(overrides: Partial<ServerSettings["providers"]> = {}): ServerSettings {
  const provider = {
    enabled: true,
    binaryPath: "",
    customModels: [],
  };

  return {
    enableAssistantStreaming: false,
    enableProviderUpdateChecks: true,
    defaultThreadEnvMode: "local",
    addProjectBaseDirectory: "",
    textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    providers: {
      codex: { ...provider, binaryPath: "codex", homePath: "" },
      commandCode: { ...provider, binaryPath: "commandcode" },
      claudeAgent: { ...provider, binaryPath: "claude", launchArgs: "" },
      cursor: { ...provider, binaryPath: "cursor-agent", apiEndpoint: "" },
      antigravity: { ...provider, binaryPath: "agy" },
      grok: { ...provider, binaryPath: "grok" },
      droid: { ...provider, binaryPath: "droid" },
      kilo: { ...provider, binaryPath: "kilo", serverUrl: "", serverPasswordConfigured: false },
      opencode: {
        ...provider,
        binaryPath: "opencode",
        serverUrl: "",
        serverPasswordConfigured: false,
        experimentalWebSockets: false,
      },
      pi: { ...provider, binaryPath: "pi", agentDir: "" },
      ...overrides,
    },
    skills: { disabled: [] },
  };
}

describe("getVisibleProviderUpdateStatuses", () => {
  it("excludes providers hidden from Synara so unchecked providers do not nag", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex"), providerStatus("pi")],
      hiddenProviders: ["pi"],
      serverSettings: serverSettings(),
    });

    expect(result.map((provider) => provider.provider)).toEqual(["codex"]);
  });

  it("excludes server-disabled providers", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex"), providerStatus("pi")],
      serverSettings: serverSettings({
        pi: { enabled: false, binaryPath: "pi", agentDir: "", customModels: [] },
      }),
    });

    expect(result.map((provider) => provider.provider)).toEqual(["codex"]);
  });

  it("waits for server settings before showing provider updates", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex")],
      serverSettings: null,
    });

    expect(result).toEqual([]);
  });

  it("excludes provider updates when automatic update checks are disabled", () => {
    const result = getVisibleProviderUpdateStatuses({
      providers: [providerStatus("codex")],
      serverSettings: { ...serverSettings(), enableProviderUpdateChecks: false },
    });

    expect(result).toEqual([]);
  });

  it("can narrow notifications to one-click updates while settings keep manual updates visible", () => {
    const manualOnly = providerStatus("pi", {
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateCommand: null,
        canUpdate: false,
        checkedAt: "2026-06-10T10:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(
      getVisibleProviderUpdateStatuses({
        providers: [providerStatus("codex"), manualOnly],
        serverSettings: serverSettings(),
      }).map((provider) => provider.provider),
    ).toEqual(["codex", "pi"]);
    expect(
      getVisibleProviderUpdateStatuses({
        providers: [providerStatus("codex"), manualOnly],
        serverSettings: serverSettings(),
        oneClickOnly: true,
      }).map((provider) => provider.provider),
    ).toEqual(["codex"]);
    expect(shouldOfferProviderUpdateAction(manualOnly)).toBe(false);
    expect(getProviderUpdatePresentation(manualOnly)).toMatchObject({
      kind: "behind_latest",
      label: "v1.0.0 -> v1.1.0",
      isVerifiedSuccess: false,
      severity: "warning",
    });
  });
});

describe("providerUpdateNotificationKey", () => {
  it("keys by provider/version and ignores ordering", () => {
    const left = providerUpdateNotificationKey([
      providerStatus("pi", {
        versionAdvisory: {
          ...providerStatus("pi").versionAdvisory!,
          latestVersion: "2.0.0",
        },
      }),
      providerStatus("codex"),
    ]);
    const right = providerUpdateNotificationKey([
      providerStatus("codex"),
      providerStatus("pi", {
        versionAdvisory: {
          ...providerStatus("pi").versionAdvisory!,
          latestVersion: "2.0.0",
        },
      }),
    ]);

    expect(left).toBe(right);
  });
});

describe("shouldShowProviderUpdateStatus", () => {
  it("matches the list filter for hidden and server-disabled providers", () => {
    const codex = providerStatus("codex");
    const hiddenPi = providerStatus("pi");
    const settings = serverSettings({
      codex: { enabled: false, binaryPath: "codex", homePath: "", customModels: [] },
    });

    expect(
      shouldShowProviderUpdateStatus({
        provider: codex,
        hiddenProviderSet: new Set(),
        serverSettings: settings,
      }),
    ).toBe(false);
    expect(
      shouldShowProviderUpdateStatus({
        provider: hiddenPi,
        hiddenProviders: ["pi"],
        serverSettings: serverSettings(),
      }),
    ).toBe(false);
  });
});

describe("isProviderUpdateActive", () => {
  it("only treats queued and running provider updates as active", () => {
    const queuedState = {
      status: "queued",
      startedAt: null,
      finishedAt: null,
      message: null,
      output: null,
    } satisfies NonNullable<ServerProviderStatus["updateState"]>;
    const succeededState = {
      ...queuedState,
      status: "succeeded",
    } satisfies NonNullable<ServerProviderStatus["updateState"]>;

    expect(isProviderUpdateActive(providerStatus("codex", { updateState: queuedState }))).toBe(
      true,
    );
    expect(isProviderUpdateActive(providerStatus("codex", { updateState: succeededState }))).toBe(
      false,
    );
  });
});

describe("provider update terminal outcomes", () => {
  const terminalState = (
    status: NonNullable<ServerProviderStatus["updateState"]>["status"],
    message: string | null = `${status} message`,
  ): NonNullable<ServerProviderStatus["updateState"]> => ({
    status,
    startedAt: "2026-06-10T10:00:00.000Z",
    finishedAt: "2026-06-10T10:01:00.000Z",
    message,
    output: "raw updater output",
  });

  it.each(["failed", "still_outdated", "unchanged", "unverified"] as const)(
    "treats %s as incomplete",
    (status) => {
      expect(
        isProviderUpdateIncomplete(providerStatus("codex", { updateState: terminalState(status) })),
      ).toBe(true);
    },
  );

  it.each(["already_current", "succeeded"] as const)(
    "does not treat %s as incomplete",
    (status) => {
      expect(
        isProviderUpdateIncomplete(providerStatus("codex", { updateState: terminalState(status) })),
      ).toBe(false);
    },
  );

  it("prefers the semantic result message over raw updater output", () => {
    const provider = providerStatus("codex", {
      updateState: terminalState("unverified", "Same-target version proof was unavailable."),
    });
    expect(providerUpdateIncompleteMessage(provider)).toBe(
      "Same-target version proof was unavailable.",
    );
  });

  it("keeps failed updater output alongside the semantic failure message", () => {
    const provider = providerStatus("codex", {
      updateState: {
        ...terminalState("failed", "Update command exited with code 1."),
        output: "npm error EACCES: permission denied",
      },
    });

    expect(providerUpdateIncompleteMessage(provider)).toBe(
      "Update command exited with code 1.\n\nnpm error EACCES: permission denied",
    );
  });

  it.each(["already_current", "succeeded"] as const)(
    "lets a later release supersede a stale %s result",
    (status) => {
      const provider = providerStatus("codex", {
        version: "1.1.0",
        versionAdvisory: {
          ...providerStatus("codex").versionAdvisory!,
          currentVersion: "1.1.0",
          latestVersion: "1.2.0",
          checkedAt: "2026-06-10T10:02:00.000Z",
          message: "A newer release is available.",
        },
        updateState: terminalState(status),
      });

      expect(getProviderUpdatePresentation(provider)).toEqual({
        kind: "behind_latest",
        label: "v1.1.0 -> v1.2.0",
        message: "A newer release is available.",
        manualCommand: "npm install -g provider@latest",
        isVerifiedSuccess: false,
        severity: "warning",
      });
    },
  );

  it.each(["already_current", "succeeded"] as const)(
    "keeps a newer %s result ahead of the advisory used to verify it",
    (status) => {
      const provider = providerStatus("codex", {
        updateState: terminalState(status),
      });

      expect(getProviderUpdatePresentation(provider)).toMatchObject({
        kind: status,
        isVerifiedSuccess: true,
      });
    },
  );

  it("keeps active work ahead of a later advisory", () => {
    const provider = providerStatus("codex", {
      versionAdvisory: {
        ...providerStatus("codex").versionAdvisory!,
        checkedAt: "2026-06-10T10:02:00.000Z",
      },
      updateState: {
        ...terminalState("running", "Updating provider."),
        finishedAt: null,
      },
    });

    expect(getProviderUpdatePresentation(provider)).toEqual({
      kind: "running",
      label: "Updating",
      message: "Updating provider.",
      manualCommand: "npm install -g provider@latest",
      isVerifiedSuccess: false,
      severity: "warning",
    });
  });

  it.each(["queued", "running"] as const)(
    "keeps %s work ahead of a newer current advisory",
    (status) => {
      const provider = providerStatus("codex", {
        version: "1.1.0",
        versionAdvisory: {
          status: "current",
          currentVersion: "1.1.0",
          latestVersion: "1.1.0",
          updateCommand: "npm install -g provider@latest",
          canUpdate: true,
          checkedAt: "2026-06-10T10:02:00.000Z",
          message: null,
        },
        updateState: {
          ...terminalState(status, status === "queued" ? "Update queued." : "Updating provider."),
          finishedAt: null,
        },
      });

      expect(getProviderUpdatePresentation(provider)).toMatchObject({
        kind: status,
        isVerifiedSuccess: false,
        severity: "warning",
      });
    },
  );

  it("keeps an incomplete semantic result ahead of a later advisory", () => {
    const provider = providerStatus("codex", {
      versionAdvisory: {
        ...providerStatus("codex").versionAdvisory!,
        checkedAt: "2026-06-10T10:02:00.000Z",
      },
      updateState: terminalState(
        "unverified",
        "Update completed, but same-target version proof was unavailable.",
      ),
    });

    expect(getProviderUpdatePresentation(provider)).toEqual({
      kind: "unverified",
      label: "Update unverified",
      message: "Update completed, but same-target version proof was unavailable.",
      manualCommand: "npm install -g provider@latest",
      isVerifiedSuccess: false,
      severity: "warning",
    });
  });

  it.each(["failed", "still_outdated", "unchanged", "unverified"] as const)(
    "lets a newer current advisory supersede stale %s presentation",
    (status) => {
      const provider = providerStatus("codex", {
        version: "1.1.0",
        versionAdvisory: {
          status: "current",
          currentVersion: "1.1.0",
          latestVersion: "1.1.0",
          updateCommand: "npm install -g provider@latest",
          canUpdate: true,
          checkedAt: "2026-06-10T10:02:00.000Z",
          message: null,
        },
        updateState: terminalState(status),
      });

      expect(getProviderUpdatePresentation(provider)).toEqual({
        kind: "current",
        label: "Current v1.1.0",
        message: null,
        manualCommand: "npm install -g provider@latest",
        isVerifiedSuccess: false,
        severity: "warning",
      });
    },
  );

  it("labels a known version as installed when latest-version metadata is unknown", () => {
    const provider = providerStatus("antigravity", {
      version: "1.1.2",
      versionAdvisory: {
        status: "unknown",
        currentVersion: "1.1.2",
        latestVersion: null,
        updateCommand: "agy update",
        canUpdate: true,
        checkedAt: "2026-07-15T14:00:00.000Z",
        message: null,
      },
    });

    expect(getProviderUpdatePresentation(provider)).toEqual({
      kind: "unknown",
      label: "Installed v1.1.2",
      message: null,
      manualCommand: "agy update",
      isVerifiedSuccess: false,
      severity: "warning",
    });
  });

  it("classifies provider-update result severity for both update call sites", () => {
    expect(getProviderUpdatePresentation(undefined).severity).toBe("error");
    expect(
      getProviderUpdatePresentation(
        providerStatus("codex", { updateState: terminalState("failed") }),
      ),
    ).toMatchObject({
      manualCommand: "npm install -g provider@latest",
      severity: "error",
    });

    for (const status of ["still_outdated", "unchanged", "unverified"] as const) {
      expect(
        getProviderUpdatePresentation(
          providerStatus("codex", { updateState: terminalState(status) }),
        ).severity,
      ).toBe("warning");
    }
    expect(getProviderUpdatePresentation(providerStatus("codex")).severity).toBe("warning");

    for (const status of ["already_current", "succeeded"] as const) {
      expect(
        getProviderUpdatePresentation(
          providerStatus("codex", { updateState: terminalState(status) }),
        ).severity,
      ).toBe("success");
    }
  });

  it("falls back to the original provider command when refreshed evidence is missing", () => {
    expect(resolveProviderUpdateManualCommand(undefined, providerStatus("codex"))).toBe(
      "npm install -g provider@latest",
    );
  });

  it("rejects contradictory single and bulk success decisions from the same result", () => {
    const contradictoryResult = providerStatus("codex", {
      versionAdvisory: {
        ...providerStatus("codex").versionAdvisory!,
        checkedAt: "2026-06-10T10:02:00.000Z",
      },
      updateState: terminalState("succeeded"),
    });

    const singleResult = getProviderUpdatePresentation(contradictoryResult);
    const bulkResult = getProviderUpdatePresentation(contradictoryResult);

    expect(singleResult.isVerifiedSuccess).toBe(false);
    expect(bulkResult.isVerifiedSuccess).toBe(false);
    expect(singleResult.kind).toBe("behind_latest");
    expect(bulkResult.kind).toBe("behind_latest");
  });
});

describe("withProviderUpdateTimeout", () => {
  it("rejects a provider request that never settles", async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => undefined);
    const assertion = expect(
      withProviderUpdateTimeout({
        provider: "kilo",
        request: pending,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Kilo update timed out after 1 second");

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("clears its watchdog when the provider request finishes", async () => {
    vi.useFakeTimers();
    await expect(
      withProviderUpdateTimeout({
        provider: "antigravity",
        request: Promise.resolve("updated"),
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("updated");

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shouldOfferProviderUpdateAction", () => {
  it("offers native AGY updates even when upstream latest-version metadata is unavailable", () => {
    expect(
      shouldOfferProviderUpdateAction(
        providerStatus("antigravity", {
          versionAdvisory: {
            status: "unknown",
            currentVersion: "1.1.2",
            latestVersion: null,
            updateCommand: "agy update",
            canUpdate: true,
            checkedAt: "2026-07-15T14:00:00.000Z",
            message: null,
          },
        }),
      ),
    ).toBe(true);
  });
});
