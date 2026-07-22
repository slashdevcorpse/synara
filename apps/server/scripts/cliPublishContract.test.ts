import { describe, expect, it } from "vitest";

import { assertPatchedEffectProcessSpawnerIsBundled } from "./cliPublishContract.ts";

const structurallyPatchedEntry = `
const spawnCommand = Effect.fnUntraced(function* (cmd) {
  switch (cmd._tag) {
    case "StandardCommand": {
      const [childProcess] = yield* Effect.acquireRelease(spawn(cmd), Effect.fnUntraced(function* ([childProcess, exitSignal]) {
        if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;
        const exited = yield* Deferred.isDone(exitSignal);
        const killWithTimeout = withTimeout(childProcess, cmd, cmd.options);
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

const structurallyUnpatchedEntry = `
const spawnCommand = Effect.fnUntraced(function* (cmd) {
  switch (cmd._tag) {
    case "StandardCommand": {
      const [childProcess] = yield* Effect.acquireRelease(spawn(cmd), cleanup);
      const handle = makeHandle({});
      return handle;
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

  it("accepts the Effect namespace aliases emitted by the ESM and CJS bundles", () => {
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(
          structurallyPatchedEntry.replaceAll("Effect.", "Effect$1."),
          structurallyPatchedEntry.replaceAll("Effect.", "effect_Effect."),
        ),
      ),
    ).not.toThrow();
  });

  it("accepts the unbound makeHandle import call emitted by the CommonJS bundle", () => {
    const commonJsEntry = structurallyPatchedEntry.replace(
      "makeHandle({})",
      "(0, effect_unstable_process_ChildProcessSpawner.makeHandle)({})",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(structurallyPatchedEntry, commonJsEntry),
      ),
    ).not.toThrow();
  });

  it("rejects noncanonical comma expressions around the CommonJS makeHandle import", () => {
    const counterfeitCommonJsEntry = structurallyPatchedEntry.replace(
      "makeHandle({})",
      "(1, effect_unstable_process_ChildProcessSpawner.makeHandle)({})",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(structurallyPatchedEntry, counterfeitCommonJsEntry),
      ),
    ).toThrow("does not structurally contain");
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

  it("rejects an unpatched live spawner accompanied by an unreachable patched decoy", () => {
    const unreachableDecoy = `
      if (false) {
        ${structurallyPatchedEntry.replace("const spawnCommand", "const decoySpawnCommand")}
      }
    `;
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(`${structurallyUnpatchedEntry}\n${unreachableDecoy}`),
      ),
    ).toThrow("does not structurally contain");
  });

  it("rejects a structurally patched spawner nested under dead top-level control flow", () => {
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(`if (false) {\n${structurallyPatchedEntry}\n}`),
      ),
    ).toThrow("does not structurally contain");
  });

  it("rejects an external-supervision finalizer nested under dead control flow", () => {
    const deadFinalizer = structurallyPatchedEntry.replace(
      "if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;",
      "if (false) { if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void; }",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(deadFinalizer))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects cleanup before the external-supervision guard in the live finalizer", () => {
    const cleanupBeforeGuard = structurallyPatchedEntry.replace(
      "if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;",
      "yield* cleanup(childProcess);\n        if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(cleanupBeforeGuard)),
    ).toThrow("does not structurally contain");
  });

  it("rejects cleanup hidden in an initializer before the external-supervision guard", () => {
    const cleanupBeforeGuard = structurallyPatchedEntry.replace(
      "if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;",
      "const cleanupResult = yield* cleanup(childProcess);\n        if (cmd.options.synaraExternallySupervised === true) return yield* Effect.void;",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(cleanupBeforeGuard)),
    ).toThrow("does not structurally contain");
  });

  it("rejects an external-supervision guard that yields an unrelated void effect", () => {
    const unrelatedVoid = structurallyPatchedEntry.replace(
      "return yield* Effect.void;",
      "return yield* cleanup.void;",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(unrelatedVoid))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects acquireRelease wrapped before the child binding", () => {
    const wrappedAcquire = structurallyPatchedEntry
      .replace(
        "const [childProcess] = yield* Effect.acquireRelease(",
        "const [childProcess] = wrap(yield* Effect.acquireRelease(",
      )
      .replace("      }));\n      const handle", "      })));\n      const handle");
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(wrappedAcquire))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects acquireRelease stored before an indirect child binding", () => {
    const indirectAcquire = structurallyPatchedEntry
      .replace(
        "const [childProcess] = yield* Effect.acquireRelease(",
        "const acquired = yield* Effect.acquireRelease(",
      )
      .replace(
        "      }));\n      const handle",
        "      }));\n      const [childProcess] = acquired;\n      const handle",
      );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(indirectAcquire))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects cleanup in a live finalizer parameter default", () => {
    const cleanupParameter = structurallyPatchedEntry.replace(
      "function* ([childProcess, exitSignal])",
      "function* ([childProcess = cleanup(), exitSignal])",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(cleanupParameter)),
    ).toThrow("does not structurally contain");
  });

  it("rejects a reassigned acquired child binding", () => {
    const reassignedChild = structurallyPatchedEntry
      .replace("const [childProcess]", "let [childProcess]")
      .replace(
        "      const handle = makeHandle({});",
        "      childProcess = replacementChild;\n      const handle = makeHandle({});",
      );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(reassignedChild))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects a patched handle return after an earlier live unpatched return", () => {
    const unreachablePatchedReturn = structurallyPatchedEntry.replace(
      "return Object.assign",
      "return handle;\n      return Object.assign",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(unreachablePatchedReturn)),
    ).toThrow("does not structurally contain");
  });

  it("rejects a patch attached to an object that was not made by makeHandle", () => {
    const fakeHandle = structurallyPatchedEntry.replace(
      "const handle = makeHandle({});",
      "const handle = {};",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(fakeHandle))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects an aliased makeHandle result", () => {
    const aliasedHandle = structurallyPatchedEntry.replace(
      "const handle = makeHandle({});",
      "const actualHandle = makeHandle({});\n      const handle = actualHandle;",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(aliasedHandle))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects a reassigned handle binding", () => {
    const reassignedHandle = structurallyPatchedEntry.replace(
      "const handle = makeHandle({});",
      "let handle = makeHandle({});\n      handle = replacementHandle;",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(reassignedHandle)),
    ).toThrow("does not structurally contain");
  });

  it("rejects an ambiguous nested handle declaration", () => {
    const ambiguousHandle = structurallyPatchedEntry.replace(
      "const handle = makeHandle({});",
      "const handle = makeHandle({});\n      if (flag) { const handle = makeHandle({}); use(handle); }",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(ambiguousHandle))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects duplicate lifecycle properties that override the exact implementations", () => {
    const duplicateOverrides = structurallyPatchedEntry.replace(
      "synaraCloseStdin: () => {\n          childProcess.stdin.end();\n        },",
      "synaraCloseStdin: () => {\n          childProcess.stdin.end();\n        },\n        synaraTerminateExact: () => false,\n        synaraCloseStdin: () => {},",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(duplicateOverrides)),
    ).toThrow("does not structurally contain");
  });

  it("rejects spread properties that can override lifecycle implementations", () => {
    const spreadOverride = structurallyPatchedEntry.replace(
      "synaraCloseStdin: () => {\n          childProcess.stdin.end();\n        },",
      "synaraCloseStdin: () => {\n          childProcess.stdin.end();\n        },\n        ...lifecycleOverrides,",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(spreadOverride))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects computed properties that can override lifecycle implementations", () => {
    const computedOverride = structurallyPatchedEntry.replace(
      "synaraCloseStdin: () => {\n          childProcess.stdin.end();\n        },",
      "synaraCloseStdin: () => {\n          childProcess.stdin.end();\n        },\n        [lifecycleProperty]: () => {},",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(computedOverride)),
    ).toThrow("does not structurally contain");
  });

  it("rejects a conditional patched return with a reachable unpatched fallback", () => {
    const conditionalPatch = structurallyPatchedEntry
      .replace("return Object.assign", "if (flag) return Object.assign")
      .replace("      });\n    }", "      });\n      return handle;\n    }");
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(conditionalPatch)),
    ).toThrow("does not structurally contain");
  });

  it("rejects a stdin-close proof that is reachable only through dead control flow", () => {
    const deadStdinClose = structurallyPatchedEntry.replace(
      "childProcess.stdin.end();",
      "if (false) childProcess.stdin.end();",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(deadStdinClose))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects a stdin-close implementation that shadows the acquired child", () => {
    const shadowedChild = structurallyPatchedEntry.replace(
      "childProcess.stdin.end();",
      "const childProcess = replacementChild; childProcess.stdin.end();",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(shadowedChild))).toThrow(
      "does not structurally contain",
    );
  });

  it("rejects a stdin-close implementation that reassigns the acquired child", () => {
    const reassignedChild = structurallyPatchedEntry.replace(
      "childProcess.stdin.end();",
      "childProcess = replacementChild; childProcess.stdin.end();",
    );
    expect(() => assertPatchedEffectProcessSpawnerIsBundled(entryBundles(reassignedChild))).toThrow(
      "does not structurally contain",
    );
  });

  it("accepts the guarded stdin close emitted by the patched runtime bundle", () => {
    const guardedStdinClose = structurallyPatchedEntry.replace(
      "childProcess.stdin.end();",
      "if (childProcess.stdin !== null && !childProcess.stdin.destroyed) { childProcess.stdin.end(); }",
    );
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(entryBundles(guardedStdinClose)),
    ).not.toThrow();
  });

  it("rejects any remaining external platform-node runtime import", () => {
    expect(() =>
      assertPatchedEffectProcessSpawnerIsBundled(
        entryBundles(`${structurallyPatchedEntry}\nimport "@effect/platform-node/NodeRuntime";`),
      ),
    ).toThrow("externalizes patched Effect process code");
  });
});
