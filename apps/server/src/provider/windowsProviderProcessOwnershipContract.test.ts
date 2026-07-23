import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const serverSourceRoot = path.resolve(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolute = path.join(directory, name);
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return absolute.endsWith(".ts") && !absolute.endsWith(".test.ts") ? [absolute] : [];
  });
}

const ownershipMarkers = new Map<string, ReadonlyArray<string>>([
  ["codexAppServerManager.ts", ["supervisePreparedNodeProcess", "teardownNodeProviderProcess"]],
  [
    "git/Layers/CodexTextGeneration.ts",
    ["installPreparedEffectProcessSupervisor", "installCodexTextGenerationProcessOwnership"],
  ],
  ["provider/acp/AcpSessionRuntime.ts", ["supervisePreparedEffectProcess"]],
  ["provider/containedClaudeSdkProcess.ts", ["supervisePreparedNodeProcess"]],
  ["provider/opencodeRuntime.ts", ["supervisePreparedEffectProcess"]],
  [
    "provider/Layers/AntigravityAdapter.ts",
    ["supervisePreparedNodeProcess", "teardownNodeProviderProcess"],
  ],
  [
    "provider/Layers/CommandCodeAdapter.ts",
    ["installPreparedNodeProcessSupervisor", "makeProviderProcessOwnerTracker"],
  ],
  [
    "provider/Layers/CursorAdapter.ts",
    ["synaraExternallySupervised", "installPreparedEffectProcessSupervisor"],
  ],
  [
    "provider/Layers/GrokAdapter.ts",
    ["synaraExternallySupervised", "installPreparedEffectProcessSupervisor"],
  ],
  ["provider/Layers/PiAdapter.ts", ["supervisePreparedNodeProcess"]],
  [
    "provider/Layers/ProviderHealth.ts",
    [
      "installPreparedEffectProcessSupervisor",
      "supervisePreparedNodeProcess",
      "Effect.addFinalizer",
    ],
  ],
]);

describe("Windows provider process ownership inventory", () => {
  it("keeps every Job-prepared asynchronous spawn on an exact-handle owner", () => {
    const consumers = sourceFiles(serverSourceRoot)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          !file.endsWith("windowsProviderProcess.ts") &&
          /prepare(?:Resolved)?WindowsProviderProcess|containPreparedWindowsProviderProcess/u.test(
            source,
          )
        );
      })
      .map((file) => path.relative(serverSourceRoot, file).replaceAll("\\", "/"))
      .sort();

    expect(consumers).toEqual([...ownershipMarkers.keys()].sort());
    for (const relative of consumers) {
      const source = readFileSync(path.join(serverSourceRoot, relative), "utf8");
      for (const marker of ownershipMarkers.get(relative) ?? []) {
        expect(source, `${relative} must include ${marker}`).toContain(marker);
      }
    }

    const providerHealthSource = readFileSync(
      path.join(serverSourceRoot, "provider/Layers/ProviderHealth.ts"),
      "utf8",
    );
    expect(providerHealthSource).not.toContain("synaraExternallySupervised");
    expect(providerHealthSource).toContain(
      "Effect's child finalizer remains the provisional owner",
    );
  });

  it("keeps automatic and live provider paths off cold synchronous preparation", () => {
    const automaticLiveConsumers = [
      "git/Layers/CodexTextGeneration.ts",
      "provider/acp/AcpSessionRuntime.ts",
      "provider/Layers/ClaudeAdapter.ts",
      "provider/Layers/CommandCodeAdapter.ts",
      "provider/Layers/CursorAdapter.ts",
      "provider/Layers/GrokAdapter.ts",
      "provider/Layers/PiAdapter.ts",
      "provider/Layers/ProviderHealth.ts",
      "provider/opencodeRuntime.ts",
      "provider/providerMaintenance.ts",
    ];
    const forbiddenSyncIdentifiers = [
      "prepareWindowsProviderProcess",
      "prepareResolvedWindowsProviderProcess",
      "prepareWindowsSafeProcess",
      "resolveCodexCliExecutable",
      "resolveCodexCliExecutableWithDiscovery",
      "resolveCommandCodeCliExecutable",
      "resolveCommandCodeCliExecutableWithDiscovery",
    ];

    for (const relative of automaticLiveConsumers) {
      const source = readFileSync(path.join(serverSourceRoot, relative), "utf8");
      for (const identifier of forbiddenSyncIdentifiers) {
        expect(
          source,
          `${relative} must not reference synchronous process API ${identifier}`,
        ).not.toMatch(new RegExp(`\\b${identifier}\\b`, "u"));
      }
      if (relative === "provider/providerMaintenance.ts") {
        expect(source).toContain("resolveWindowsCommandCandidatesAsync");
        expect(source).toContain("resolveWindowsCommandPathAsync");
        expect(source).not.toContain(
          "resolveWindowsCommandCandidates as resolveRuntimeWindowsCommandCandidates",
        );
        expect(source).not.toContain(
          "resolveWindowsCommandPath as resolveRuntimeWindowsCommandPath",
        );
      } else {
        expect(
          source,
          `${relative} must not reference a synchronous shared Windows resolver`,
        ).not.toMatch(/\bresolveWindowsCommand(?:Candidates|Path)\b/u);
      }
    }

    const containedClaudeSource = readFileSync(
      path.join(serverSourceRoot, "provider/containedClaudeSdkProcess.ts"),
      "utf8",
    );
    expect(containedClaudeSource).toContain("prepareWindowsProviderProcessAsync");
    expect(containedClaudeSource).toContain("createWindowsCommandDiscoveryCache");
    expect(containedClaudeSource).toContain('commandDiscoveryMode: "cache-only"');
    expect(
      containedClaudeSource.match(/\bprepareWindowsProviderProcess\s*\(/gu) ?? [],
    ).toHaveLength(1);
  });

  it("keeps Codex startup discovery and version probing off synchronous process APIs", () => {
    const productionSources = sourceFiles(serverSourceRoot).map((file) => ({
      file,
      relative: path.relative(serverSourceRoot, file).replaceAll("\\", "/"),
      source: readFileSync(file, "utf8"),
    }));
    const synchronousPreparedConsumers = productionSources
      .filter(
        ({ source }) =>
          /prepare(?:Resolved)?WindowsProviderProcess|containPreparedWindowsProviderProcess/u.test(
            source,
          ) && source.includes("spawnSync("),
      )
      .map(({ relative }) => relative);
    expect(synchronousPreparedConsumers).toEqual([]);

    const allProductionSource = productionSources.map(({ source }) => source).join("\n");
    expect(
      allProductionSource.match(/SYNCHRONOUS_WINDOWS_JOB_OWNERSHIP_EXCEPTION/gu) ?? [],
    ).toHaveLength(0);

    const managerSource = readFileSync(
      path.join(serverSourceRoot, "codexAppServerManager.ts"),
      "utf8",
    );
    const resolveLaunchStart = managerSource.indexOf("async function resolveCodexLaunch");
    const resolveLaunchEnd = managerSource.indexOf(
      "export function normalizeCodexModelSlug",
      resolveLaunchStart,
    );
    const resolveLaunchSource = managerSource.slice(resolveLaunchStart, resolveLaunchEnd);
    expect(resolveLaunchStart).toBeGreaterThan(0);
    expect(resolveLaunchEnd).toBeGreaterThan(resolveLaunchStart);
    expect(resolveLaunchSource).toContain("resolveCodexCliExecutableAsync");
    expect(resolveLaunchSource).toContain('resolveWindowsCommandCandidatesAsync("node"');
    expect(resolveLaunchSource).not.toMatch(/\bspawnSync\s*\(/u);

    const versionCheckStart = managerSource.indexOf(
      "export async function assertSupportedCodexCliVersion",
    );
    const versionCheckEnd = managerSource.indexOf(
      "function readResumeCursorThreadId",
      versionCheckStart,
    );
    const versionCheckSource = managerSource.slice(versionCheckStart, versionCheckEnd);
    expect(versionCheckStart).toBeGreaterThan(0);
    expect(versionCheckEnd).toBeGreaterThan(versionCheckStart);
    expect(versionCheckSource).not.toMatch(/\bspawnSync\s*\(/u);
    expect(versionCheckSource).not.toContain("finalizeSynchronousWindowsJobExit");
    expect(versionCheckSource).toContain("observeNodeProviderProcessSpawn(child)");
    expect(versionCheckSource).toContain("installPreparedNodeProcessSupervisor(");
    expect(versionCheckSource).toContain("await supervisor.proveExit()");
    expect(versionCheckSource).toContain("throwAfterVerifiedVersionProbeTeardown(");
    expect(managerSource).toContain("await supervisor.teardown()");
  });
});
