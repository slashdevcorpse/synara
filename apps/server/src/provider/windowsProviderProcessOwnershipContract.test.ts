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

  it("documents the one retained-handle synchronous exception", () => {
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
    expect(synchronousPreparedConsumers).toEqual(["codexAppServerManager.ts"]);

    const allProductionSource = productionSources.map(({ source }) => source).join("\n");
    expect(
      allProductionSource.match(/SYNCHRONOUS_WINDOWS_JOB_OWNERSHIP_EXCEPTION/gu) ?? [],
    ).toHaveLength(1);
    expect(
      allProductionSource.match(/spawnSync\(prepared\.command, prepared\.args/gu) ?? [],
    ).toHaveLength(1);

    const managerSource = readFileSync(
      path.join(serverSourceRoot, "codexAppServerManager.ts"),
      "utf8",
    );
    const versionCheckStart = managerSource.indexOf(
      "async function assertSupportedCodexCliVersion",
    );
    const versionCheckEnd = managerSource.indexOf(
      "function readResumeCursorThreadId",
      versionCheckStart,
    );
    const versionCheckSource = managerSource.slice(versionCheckStart, versionCheckEnd);
    expect(versionCheckStart).toBeGreaterThan(0);
    expect(versionCheckEnd).toBeGreaterThan(versionCheckStart);
    expect(
      versionCheckSource.match(/SYNCHRONOUS_WINDOWS_JOB_OWNERSHIP_EXCEPTION/gu) ?? [],
    ).toHaveLength(1);
    expect(
      versionCheckSource.match(/spawnSync\(prepared\.command, prepared\.args/gu) ?? [],
    ).toHaveLength(1);
    expect(
      versionCheckSource.match(/finalizeSynchronousWindowsJobExit\(prepared/gu) ?? [],
    ).toHaveLength(1);
    const spawnIndex = versionCheckSource.indexOf("const result = spawnSync(");
    const finalizerIndex = versionCheckSource.indexOf("finalizeSynchronousWindowsJobExit(prepared");
    const failureThrowIndex = versionCheckSource.indexOf(
      "if (commandFailure && finalizationFailure)",
    );
    expect(finalizerIndex).toBeGreaterThan(spawnIndex);
    expect(failureThrowIndex).toBeGreaterThan(finalizerIndex);
    expect(versionCheckSource.slice(spawnIndex, finalizerIndex)).not.toMatch(/\bthrow\b/u);
    expect(versionCheckSource).toContain(
      "proofRequired: result.error === undefined && !isUnstartedWindowsLauncherTargetFailure",
    );
  });
});
