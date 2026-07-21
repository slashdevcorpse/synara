import { describe, expect, it } from "vitest";

import { assertPatchedEffectProcessSpawnerIsBundled } from "./cliPublishContract.ts";

const structurallyPatchedEntry = `
const spawnCommand = Effect.fnUntraced(function* (cmd) {
  switch (cmd._tag) {
    case "StandardCommand": {
      const [childProcess] = yield* Effect.acquireRelease(spawn(cmd), Effect.fnUntraced(function* () {
        if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;
      }));
      const handle = makeHandle({});
      return Object.assign(handle, {
        synaraTerminateExact: () => childProcess.kill(),
        synaraCloseStdin: () => {
          childProcess.stdin.end();
        },
      });
    }
  }
});
`;

function entryBundles(indexMjs = structurallyPatchedEntry, indexCjs = structurallyPatchedEntry) {
  return [
    { path: "index.mjs", source: indexMjs },
    { path: "index.cjs", source: indexCjs },
  ];
}

describe("assertPatchedEffectProcessSpawnerIsBundled", () => {
  it("accepts structural patch implementations in both runtime entries", () => {
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles())).not.toThrow();
  });

  it("rejects comment-only and string-only patch marker text", () => {
    const markerText = `
      if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;
      synaraTerminateExact: () => childProcess.kill(),
      synaraCloseStdin: () => { childProcess.stdin.end(); }
    `;
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(`/* ${markerText} */\nconst marker = ${JSON.stringify(markerText)};`),
      ),
    ).toThrow("does not structurally contain");
  });

  it("rejects a missing implementation in either entry format", () => {
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(structurallyPatchedEntry, "module.exports = {};"),
      ),
    ).toThrow("index.cjs");
  });

  it("rejects patched handle properties outside the live StandardCommand return", () => {
    const deadHandle = `
      function deadPatchMarker() {
        const handle = {};
        void Object.assign(handle, {
          synaraTerminateExact: () => childProcess.kill(),
          synaraCloseStdin: () => { childProcess.stdin.end(); },
        });
      }
    `;
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(
          `${structurallyPatchedEntry.replace("return Object.assign", "void Object.assign")}\n${deadHandle}`,
        ),
      ),
    ).toThrow("does not structurally contain");
  });

  it("rejects any remaining external platform-node runtime import", () => {
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(`${structurallyPatchedEntry}\nimport "@effect/platform-node/NodeRuntime";`),
      ),
    ).toThrow("externalizes patched Effect process code");
  });
});
