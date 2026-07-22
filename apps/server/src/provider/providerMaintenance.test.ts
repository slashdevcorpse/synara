import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  resolveWindowsCommandPath as resolveRuntimeWindowsCommandPath,
  type WindowsSafeProcessInput,
} from "@synara/shared/windowsProcess";
import { describe, it, assert } from "@effect/vitest";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { Effect, FileSystem, Fiber } from "effect";

import {
  createProviderVersionAdvisory,
  deriveNpmGlobalPrefix,
  makeCommandPathSuffixMatcher,
  normalizeCommandPath,
  parseGenericCliVersion,
  providerMaintenanceTargetsShareUpdateDestination,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance";

const isStandaloneCodexCommandPath = makeCommandPathSuffixMatcher([
  "/Programs/OpenAI/Codex/bin/codex.exe",
]);
const isWindowsStandaloneCodexCommandPath = (commandPath: string, platform: NodeJS.Platform) =>
  platform === "win32" && isStandaloneCodexCommandPath(commandPath, platform);
const isNativeOpenCodeCommandPath = makeCommandPathSuffixMatcher(["/.opencode/bin/opencode"]);

const CODEX_DEFINITION = {
  provider: "codex",
  binaryName: "codex",
  npmPackageName: "@openai/codex",
  allowedInstallSources: ["npm", "bun", "pnpm", "homebrew", "native"],
  homebrew: { name: "codex", kind: "cask" },
  nativeUpdate: {
    executable: "codex",
    args: () => ["update"],
    lockKey: "codex-native",
    strategy: "matching-path",
    isCommandPath: isWindowsStandaloneCodexCommandPath,
    isVisibleCommandPath: ({ visibleCommandPath, platform }) =>
      isWindowsStandaloneCodexCommandPath(visibleCommandPath, platform),
    resolveInstallRoot: ({ visibleCommandPath }) =>
      NodePath.win32.dirname(NodePath.win32.dirname(visibleCommandPath)),
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const OPENCODE_DEFINITION = {
  provider: "opencode",
  binaryName: "opencode",
  npmPackageName: "opencode-ai",
  allowedInstallSources: ["npm", "bun", "pnpm", "homebrew", "native"],
  homebrew: { name: "anomalyco/tap/opencode", kind: "formula" },
  nativeUpdate: {
    executable: "opencode",
    args: (installSource) =>
      installSource === "unknown" || installSource === "native"
        ? ["upgrade"]
        : ["upgrade", "--method", installSource],
    lockKey: "opencode-native",
    strategy: "matching-path",
    excludedInstallSources: ["homebrew"],
    isCommandPath: isNativeOpenCodeCommandPath,
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const COMMAND_CODE_DEFINITION = {
  provider: "commandCode",
  binaryName: "commandcode",
  allowedBinaryNames: ["cmd", "cmdc", "command-code", "commandcode"],
  npmPackageName: "command-code",
  allowedInstallSources: ["npm"],
  homebrew: null,
  nativeUpdate: null,
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const DROID_DEFINITION = {
  provider: "droid",
  binaryName: "droid",
  allowedBinaryNames: ["droid"],
  npmPackageName: "droid",
  allowedInstallSources: ["npm"],
  homebrew: null,
  nativeUpdate: null,
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const CODEX_PACKAGE_BIN_TARGET = "bin/codex.js";

function codexPackageManifest(input?: {
  readonly binTarget?: string;
  readonly name?: string;
  readonly requested?: "latest" | "custom" | null;
  readonly version?: string;
}): string {
  const requested = input?.requested === undefined ? "latest" : input.requested;
  return `${JSON.stringify({
    name: input?.name ?? "@openai/codex",
    version: input?.version ?? "0.130.0",
    bin: { codex: input?.binTarget ?? CODEX_PACKAGE_BIN_TARGET },
    ...(requested === null
      ? {}
      : {
          _requested: {
            type: requested === "latest" ? "tag" : "git",
            rawSpec: requested,
            raw: requested === "latest" ? "@openai/codex@latest" : requested,
          },
        }),
  })}\n`;
}

function latestChannel(installedVersion: string, metadataPath: string) {
  return {
    kind: "package-dist-tag" as const,
    tag: "latest" as const,
    installedVersion,
    metadataPath,
  };
}

function windowsNpmCmdShim(packageName: string, binTarget: string): string {
  const windowsPackageName = packageName.replaceAll("/", "\\");
  const windowsBinTarget = binTarget.replaceAll("/", "\\");
  return `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\${windowsPackageName}\\${windowsBinTarget}" %*\r\n`;
}

function resolveWindowsCommandFromCandidates(
  candidates: ReadonlyArray<string>,
  observe?: (input: WindowsSafeProcessInput) => void,
): typeof resolveRuntimeWindowsCommandPath {
  return (command, input = {}) => {
    observe?.(input);
    return resolveRuntimeWindowsCommandPath(command, {
      ...input,
      spawnSync: () => ({
        stdout: candidates.length > 0 ? `${candidates.join("\r\n")}\r\n` : "",
        status: candidates.length > 0 ? 0 : 1,
      }),
    });
  };
}

function latestNpmCapabilities(packageName: string): ProviderMaintenanceCapabilities {
  return {
    provider: "codex",
    packageName,
    latestVersionSource: { kind: "npm", name: packageName },
    update: null,
  };
}

function npmVersionResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchMock(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, {
    preconnect: (_url: string | URL) => undefined,
  });
}

function makeDeferredFetchMock(controlledRequestCount: number) {
  const requests: Array<{ readonly resolve: (response: Response) => void }> = [];
  const fetchMock = makeFetchMock(() => {
    if (requests.length >= controlledRequestCount) {
      requests.push({ resolve: () => undefined });
      return Promise.resolve(npmVersionResponse("99.0.0"));
    }
    return new Promise<Response>((resolve) => {
      requests.push({ resolve });
    });
  });
  return { fetchMock, requests };
}

function withFetchMock<A, E, R>(
  fetchMock: typeof fetch,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      return previousFetch;
    }),
    () => use,
    (previousFetch) =>
      Effect.sync(() => {
        globalThis.fetch = previousFetch;
      }),
  );
}

function waitForFetchRequests(
  requests: ReadonlyArray<unknown>,
  expectedCount: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (requests.length >= expectedCount) {
        return;
      }
      yield* Effect.yieldNow;
    }
    throw new Error(`Timed out waiting for ${expectedCount} latest-version fetch requests.`);
  });
}

const yieldToConcurrentRequests = Effect.gen(function* () {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    yield* Effect.yieldNow;
  }
});

const win = it.runIf(process.platform === "win32");
const posix = it.skipIf(process.platform === "win32");

describe("providerMaintenance", () => {
  it("parses generic CLI versions", () => {
    assert.strictEqual(parseGenericCliVersion("codex-cli 0.130.0\n"), "0.130.0");
    assert.strictEqual(parseGenericCliVersion("claude 2.1\n"), "2.1.0");
    assert.strictEqual(parseGenericCliVersion("no version here"), null);
  });

  it("preserves POSIX path case while folding Windows path identity", () => {
    assert.strictEqual(normalizeCommandPath("/Users/Test/Bin", "linux"), "/Users/Test/Bin");
    assert.strictEqual(normalizeCommandPath("C:\\Users\\Test\\Bin", "win32"), "c:/users/test/bin");
  });

  it("resolves npm global updates only with exact manager, root, and latest-tag evidence", () => {
    const binaryPath = "/Users/test/.npm-global/bin/codex";
    const realCommandPath = "/Users/test/.npm-global/lib/node_modules/@openai/codex/bin/codex";
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath,
      realCommandPath,
      canonicalInstallRoot: "/Users/test/.npm-global",
      managerExecutablePath: "/usr/local/bin/npm",
      realManagerExecutablePath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      packageChannelEvidence: latestChannel(
        "0.130.0",
        "/Users/test/.npm-global/lib/node_modules/@openai/codex/package.json",
      ),
    });

    assert.ok(capabilities.update);
    assert.strictEqual(
      capabilities.update.command,
      "/usr/local/bin/npm install -g --prefix /Users/test/.npm-global @openai/codex@latest",
    );
    assert.strictEqual(capabilities.update.executable, "/usr/local/bin/npm");
    assert.strictEqual(capabilities.update.lockKey, "npm-global:/Users/test/.npm-global");
    assert.strictEqual(capabilities.update.target.visibleCommandPath, binaryPath);
    assert.strictEqual(capabilities.update.target.canonicalCommandPath, realCommandPath);
    assert.strictEqual(capabilities.update.target.channel.kind, "package-dist-tag");
    assert.strictEqual(
      capabilities.update.targetFingerprint,
      JSON.stringify({
        platform: "darwin",
        source: "npm",
        visibleCommandPath: "/Users/test/.npm-global/bin/codex",
        canonicalCommandPath: "/Users/test/.npm-global/lib/node_modules/@openai/codex/bin/codex",
        canonicalInstallRoot: "/Users/test/.npm-global",
        managerExecutablePath: "/usr/local/bin/npm",
        canonicalManagerExecutablePath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        channel: {
          kind: "package-dist-tag",
          tag: "latest",
          metadataPath: "/Users/test/.npm-global/lib/node_modules/@openai/codex/package.json",
        },
      }),
    );
    const afterVersionChange = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath,
      realCommandPath,
      canonicalInstallRoot: "/Users/test/.npm-global",
      managerExecutablePath: "/usr/local/bin/npm",
      realManagerExecutablePath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      packageChannelEvidence: latestChannel(
        "0.131.0",
        "/Users/test/.npm-global/lib/node_modules/@openai/codex/package.json",
      ),
    });
    assert.ok(afterVersionChange.update);
    const updatedChannel = afterVersionChange.update.target.channel;
    assert.strictEqual(updatedChannel.kind, "package-dist-tag");
    if (updatedChannel.kind !== "package-dist-tag") {
      throw new Error("Expected package channel evidence");
    }
    assert.strictEqual(
      afterVersionChange.update.targetFingerprint,
      capabilities.update.targetFingerprint,
    );
    assert.strictEqual(updatedChannel.installedVersion, "0.131.0");
    assert.strictEqual(
      providerMaintenanceTargetsShareUpdateDestination(
        capabilities.update.target,
        afterVersionChange.update.target,
      ),
      true,
    );
    assert.strictEqual(
      providerMaintenanceTargetsShareUpdateDestination(capabilities.update.target, {
        ...afterVersionChange.update.target,
        managerExecutablePath: "/other/bin/npm",
      }),
      false,
    );
    assert.strictEqual(
      providerMaintenanceTargetsShareUpdateDestination(capabilities.update.target, {
        ...afterVersionChange.update.target,
        channel: {
          ...updatedChannel,
          metadataPath: "/Users/test/.npm-global/other-package.json",
        },
      }),
      false,
    );
    assert.strictEqual(
      providerMaintenanceTargetsShareUpdateDestination(capabilities.update.target, {
        ...afterVersionChange.update.target,
        canonicalInstallRoot: "/users/test/.npm-global",
      }),
      false,
    );
  });

  it("pins the npm global prefix that owns the detected binary", () => {
    // npm's global prefix follows the node that runs it, so without --prefix a
    // second node install (e.g. nvm) would receive the update while Synara
    // keeps checking the copy it originally detected.
    assert.strictEqual(
      deriveNpmGlobalPrefix("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js", "darwin"),
      "/opt/homebrew",
    );
    assert.strictEqual(
      deriveNpmGlobalPrefix(
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        "win32",
      ),
      "C:\\Users\\Test User\\AppData\\Roaming\\npm",
    );
    // Project-local node_modules paths are not global installs; no prefix.
    assert.strictEqual(deriveNpmGlobalPrefix("/repo/node_modules/.bin/codex", "linux"), null);
  });

  it("treats omitted or provider-disallowed install sources as manual-only", () => {
    const { allowedInstallSources: _allowedInstallSources, ...manualDefinition } = CODEX_DEFINITION;
    const npmOptions = {
      platform: "darwin",
      binaryPath: "/Users/test/.npm-global/bin/codex",
      realCommandPath: "/Users/test/.npm-global/lib/node_modules/@openai/codex/bin/codex",
      canonicalInstallRoot: "/Users/test/.npm-global",
      managerExecutablePath: "/usr/local/bin/npm",
      realManagerExecutablePath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
      packageChannelEvidence: latestChannel(
        "0.130.0",
        "/Users/test/.npm-global/lib/node_modules/@openai/codex/package.json",
      ),
    } as const;
    const npmOnlyDefinition = {
      ...CODEX_DEFINITION,
      allowedInstallSources: ["npm"],
    } as const satisfies PackageManagedProviderMaintenanceDefinition;

    assert.strictEqual(
      resolvePackageManagedProviderMaintenance(manualDefinition, npmOptions).update,
      null,
    );
    assert.strictEqual(
      resolvePackageManagedProviderMaintenance(npmOnlyDefinition, {
        platform: "darwin",
        binaryPath: "/opt/homebrew/bin/codex",
        realCommandPath: "/opt/homebrew/Caskroom/codex/0.130.0/codex",
        canonicalInstallRoot: "/opt/homebrew",
        managerExecutablePath: "/opt/homebrew/bin/brew",
        realManagerExecutablePath: "/opt/homebrew/bin/brew",
      }).update,
      null,
    );
  });

  it("rejects project-local and mismatched npm package paths", () => {
    const projectLocal = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath: "codex",
      realCommandPath: "/repo/node_modules/.bin/codex",
    });
    const mismatchedPackage = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath: "codex",
      realCommandPath: "/Users/test/.npm-global/lib/node_modules/not-codex/bin/codex",
    });

    assert.strictEqual(projectLocal.update, null);
    assert.strictEqual(mismatchedPackage.update, null);
  });

  it("requires exact resolved package identity for Bun and pnpm globals", () => {
    const bunManaged = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath: "/Users/test/.bun/bin/codex",
      realCommandPath: "/Users/test/.bun/install/global/node_modules/@openai/codex/bin/codex.js",
      canonicalInstallRoot: "/Users/test/.bun/install/global",
      managerExecutablePath: "/Users/test/.bun/bin/bun",
      realManagerExecutablePath: "/Users/test/.bun/bin/bun",
      packageChannelEvidence: latestChannel(
        "0.130.0",
        "/Users/test/.bun/install/global/package.json",
      ),
    });
    const unresolvedPnpmLauncher = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      platform: "darwin",
      binaryPath: "opencode",
      realCommandPath: "/Users/test/.local/share/pnpm/opencode",
    });
    const mismatchedPnpmPackage = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      platform: "darwin",
      binaryPath: "opencode",
      realCommandPath:
        "/Users/test/.local/share/pnpm/global/5/.pnpm/not-opencode@1.0.0/node_modules/not-opencode/bin/opencode",
    });

    assert.ok(bunManaged.update);
    assert.strictEqual(
      bunManaged.update.command,
      "/Users/test/.bun/bin/bun i -g @openai/codex@latest",
    );
    assert.strictEqual(bunManaged.update.executable, "/Users/test/.bun/bin/bun");
    assert.strictEqual(bunManaged.update.lockKey, "bun-global:/Users/test/.bun/install/global");
    assert.strictEqual(bunManaged.update.pathPrepend, "/Users/test/.bun/bin");
    assert.strictEqual(unresolvedPnpmLauncher.update, null);
    assert.strictEqual(mismatchedPnpmPackage.update, null);
  });

  it("quotes update command arguments containing spaces", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "win32",
      binaryPath: "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd",
      realCommandPath:
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      canonicalInstallRoot: "C:\\Users\\Test User\\AppData\\Roaming\\npm",
      managerExecutablePath: "C:\\Program Files\\nodejs\\npm.cmd",
      realManagerExecutablePath: "C:\\Program Files\\nodejs\\npm.cmd",
      packageChannelEvidence: latestChannel(
        "0.130.0",
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\package.json",
      ),
    });

    assert.strictEqual(
      capabilities.update?.command,
      '"C:\\Program Files\\nodejs\\npm.cmd" install -g --prefix "C:\\Users\\Test User\\AppData\\Roaming\\npm" @openai/codex@latest',
    );
  });

  win("verifies manifest identity, bin mapping, and linkage for a Windows npm shim", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-provider-maintenance-npm-shim-",
        });
        const npmPrefix = NodePath.join(tempDirectory, "npm");
        const windowsEnv = { PATH: npmPrefix, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
        const shimPath = NodePath.join(npmPrefix, "codex.cmd");
        const npmManagerPath = NodePath.join(npmPrefix, "npm.cmd");
        const packageManifestPath = NodePath.join(
          npmPrefix,
          "node_modules",
          "@openai",
          "codex",
          "package.json",
        );
        const packageBinPath = NodePath.join(
          NodePath.dirname(packageManifestPath),
          ...CODEX_PACKAGE_BIN_TARGET.split("/"),
        );
        yield* fileSystem.makeDirectory(npmPrefix, { recursive: true });
        yield* fileSystem.writeFileString(
          shimPath,
          windowsNpmCmdShim("@openai/codex", CODEX_PACKAGE_BIN_TARGET),
        );
        const unverifiedCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          CODEX_DEFINITION,
          {
            binaryPath: shimPath,
            env: windowsEnv,
            platform: "win32",
          },
        );

        yield* fileSystem.makeDirectory(NodePath.dirname(packageManifestPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(packageManifestPath, codexPackageManifest());
        yield* fileSystem.makeDirectory(NodePath.dirname(packageBinPath), { recursive: true });
        yield* fileSystem.writeFileString(packageBinPath, "console.log('codex fixture');\n");
        yield* fileSystem.writeFileString(npmManagerPath, "@echo off\r\n");

        const explicitCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          CODEX_DEFINITION,
          {
            binaryPath: shimPath,
            env: windowsEnv,
            platform: "win32",
          },
        );
        const pathCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          CODEX_DEFINITION,
          {
            binaryPath: "codex",
            env: windowsEnv,
            platform: "win32",
          },
          { resolveWindowsCommandPath: resolveWindowsCommandFromCandidates([shimPath]) },
        );
        yield* fileSystem.writeFileString(
          packageManifestPath,
          codexPackageManifest({ requested: "custom" }),
        );
        const customChannelCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          CODEX_DEFINITION,
          { binaryPath: shimPath, env: windowsEnv, platform: "win32" },
        );
        yield* fileSystem.writeFileString(
          packageManifestPath,
          codexPackageManifest({ version: "0.131.0-beta.1" }),
        );
        const prereleaseCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          CODEX_DEFINITION,
          { binaryPath: shimPath, env: windowsEnv, platform: "win32" },
        );
        yield* fileSystem.writeFileString(
          packageManifestPath,
          codexPackageManifest({ requested: null }),
        );
        const unprovenChannelCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          CODEX_DEFINITION,
          { binaryPath: shimPath, env: windowsEnv, platform: "win32" },
        );
        return {
          customChannelCapabilities,
          explicitCapabilities,
          npmManagerPath,
          npmPrefix,
          packageBinPath,
          pathCapabilities,
          prereleaseCapabilities,
          shimPath,
          unprovenChannelCapabilities,
          unverifiedCapabilities,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    assert.strictEqual(result.unverifiedCapabilities.update, null);
    assert.strictEqual(result.customChannelCapabilities.update, null);
    assert.strictEqual(result.prereleaseCapabilities.update, null);
    assert.strictEqual(result.unprovenChannelCapabilities.update, null);
    const renderedPrefix = /\s/u.test(result.npmPrefix)
      ? `"${result.npmPrefix}"`
      : result.npmPrefix;
    for (const capabilities of [result.explicitCapabilities, result.pathCapabilities]) {
      assert.ok(capabilities.update);
      const renderedManager = /\s/u.test(capabilities.update.executable)
        ? `"${capabilities.update.executable}"`
        : capabilities.update.executable;
      assert.strictEqual(
        capabilities.update.command,
        `${renderedManager} install -g --prefix ${renderedPrefix} @openai/codex@latest`,
      );
      assert.strictEqual(
        NodePath.win32.extname(capabilities.update.executable).toLowerCase(),
        ".cmd",
      );
      assert.strictEqual(
        capabilities.update.lockKey,
        `npm-global:${normalizeCommandPath(result.npmPrefix, "win32")}`,
      );
      assert.ok(capabilities.update.pathPrepend);
      assert.strictEqual(
        normalizeCommandPath(capabilities.update.pathPrepend, "win32"),
        normalizeCommandPath(NodePath.win32.dirname(capabilities.update.executable), "win32"),
      );
      assert.strictEqual(capabilities.update.target.visibleCommandPath, result.shimPath);
      assert.strictEqual(
        normalizeCommandPath(capabilities.update.target.canonicalCommandPath, "win32"),
        normalizeCommandPath(result.packageBinPath, "win32"),
      );
      assert.strictEqual(capabilities.update.target.channel.kind, "package-dist-tag");
    }
  });

  win(
    "keeps Windows manager discovery inside the canonical requested directory across alias spellings",
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "synara-provider-maintenance-manager-directory-",
          });
          const npmPrefix = NodePath.join(tempDirectory, "npm");
          const shimPath = NodePath.join(npmPrefix, "codex.cmd");
          const packageManifestPath = NodePath.join(
            npmPrefix,
            "node_modules",
            "@openai",
            "codex",
            "package.json",
          );
          const packageBinPath = NodePath.join(
            NodePath.dirname(packageManifestPath),
            ...CODEX_PACKAGE_BIN_TARGET.split("/"),
          );
          yield* fileSystem.makeDirectory(NodePath.dirname(packageBinPath), { recursive: true });
          yield* fileSystem.writeFileString(packageManifestPath, codexPackageManifest());
          yield* fileSystem.writeFileString(packageBinPath, "console.log('codex fixture');\n");
          yield* fileSystem.writeFileString(
            shimPath,
            windowsNpmCmdShim("@openai/codex", CODEX_PACKAGE_BIN_TARGET),
          );

          const allowedManagerDirectory = NodePath.join(tempDirectory, "allowed-manager");
          const escapedManagerDirectory = NodePath.join(tempDirectory, "escaped-manager");
          const escapedManagerPath = NodePath.join(escapedManagerDirectory, "npm.cmd");
          yield* fileSystem.makeDirectory(allowedManagerDirectory, { recursive: true });
          yield* fileSystem.makeDirectory(escapedManagerDirectory, { recursive: true });
          yield* fileSystem.writeFileString(escapedManagerPath, "@echo off\r\n");

          const resolveWithManagerCandidates = (managerPath: string, managerDirectory: string) =>
            resolveProviderMaintenanceCapabilitiesEffect(
              CODEX_DEFINITION,
              {
                binaryPath: "codex",
                env: {
                  PATH: managerDirectory,
                  PATHEXT: ".CMD;.EXE",
                },
                platform: "win32",
              },
              {
                resolveWindowsCommandPath: resolveWindowsCommandFromCandidates([shimPath]),
                resolveWindowsCommandCandidates: (_command, input = {}) =>
                  normalizeCommandPath(input.env?.PATH ?? "", "win32") ===
                  normalizeCommandPath(managerDirectory, "win32")
                    ? [managerPath]
                    : [],
              },
            );

          const escaped = yield* resolveWithManagerCandidates(
            escapedManagerPath,
            allowedManagerDirectory,
          );

          const longManagerDirectory = NodePath.join(tempDirectory, "Program Files", "nodejs");
          const aliasManagerDirectory = NodePath.join(tempDirectory, "NODEJS~1");
          const longManagerPath = NodePath.join(longManagerDirectory, "npm.cmd");
          yield* fileSystem.makeDirectory(longManagerDirectory, { recursive: true });
          yield* fileSystem.writeFileString(longManagerPath, "@echo off\r\n");
          yield* Effect.promise(() =>
            NodeFs.symlink(longManagerDirectory, aliasManagerDirectory, "junction"),
          );
          const aliased = yield* resolveWithManagerCandidates(
            longManagerPath,
            aliasManagerDirectory,
          );

          return { aliased, escaped, longManagerPath };
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );

      assert.strictEqual(result.escaped.update, null);
      assert.ok(result.aliased.update);
      assert.strictEqual(
        normalizeCommandPath(result.aliased.update.executable, "win32"),
        normalizeCommandPath(result.longManagerPath, "win32"),
      );
    },
  );

  win("rejects bogus Windows npm manifests and shims", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-provider-maintenance-bogus-npm-shim-",
        });
        const npmPrefix = NodePath.join(tempDirectory, "npm");
        const shimPath = NodePath.join(npmPrefix, "codex.cmd");
        const npmManagerPath = NodePath.join(npmPrefix, "npm.cmd");
        const packageManifestPath = NodePath.join(
          npmPrefix,
          "node_modules",
          "@openai",
          "codex",
          "package.json",
        );
        const packageBinPath = NodePath.join(
          NodePath.dirname(packageManifestPath),
          ...CODEX_PACKAGE_BIN_TARGET.split("/"),
        );
        yield* fileSystem.makeDirectory(NodePath.dirname(packageManifestPath), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(NodePath.dirname(packageBinPath), { recursive: true });
        yield* fileSystem.writeFileString(packageBinPath, "console.log('codex fixture');\n");
        yield* fileSystem.writeFileString(npmManagerPath, "@echo off\r\n");
        yield* fileSystem.writeFileString(
          shimPath,
          windowsNpmCmdShim("@openai/codex", CODEX_PACKAGE_BIN_TARGET),
        );
        const resolve = () =>
          resolveProviderMaintenanceCapabilitiesEffect(CODEX_DEFINITION, {
            binaryPath: shimPath,
            env: { PATH: npmPrefix },
            platform: "win32",
          });

        yield* fileSystem.writeFileString(
          packageManifestPath,
          codexPackageManifest({ name: "not-codex" }),
        );
        const wrongName = yield* resolve();

        yield* fileSystem.writeFileString(
          packageManifestPath,
          codexPackageManifest({ binTarget: "bin/not-codex.js" }),
        );
        const wrongBinTarget = yield* resolve();

        yield* fileSystem.writeFileString(packageManifestPath, codexPackageManifest());
        yield* fileSystem.writeFileString(
          shimPath,
          windowsNpmCmdShim("other-package", CODEX_PACKAGE_BIN_TARGET),
        );
        const wrongShimTarget = yield* resolve();

        yield* fileSystem.writeFileString(
          shimPath,
          `@ECHO off\r\nGOTO done\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\${CODEX_PACKAGE_BIN_TARGET.replaceAll("/", "\\")}" %*\r\n:done\r\n@ECHO custom wrapper\r\n`,
        );
        const unreachableExpectedTarget = yield* resolve();

        yield* fileSystem.writeFileString(
          shimPath,
          `${windowsNpmCmdShim("@openai/codex", CODEX_PACKAGE_BIN_TARGET)}other-tool.exe --version\r\n`,
        );
        const extraExecutableBranch = yield* resolve();

        return {
          extraExecutableBranch,
          unreachableExpectedTarget,
          wrongBinTarget,
          wrongName,
          wrongShimTarget,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    assert.strictEqual(result.wrongName.update, null);
    assert.strictEqual(result.wrongBinTarget.update, null);
    assert.strictEqual(result.wrongShimTarget.update, null);
    assert.strictEqual(result.unreachableExpectedTarget.update, null);
    assert.strictEqual(result.extraExecutableBranch.update, null);
  });

  win("recognizes Command Code aliases and follows PATHEXT selection for Droid", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-provider-maintenance-windows-aliases-",
        });
        const npmPrefix = NodePath.join(tempDirectory, "npm");
        const npmManagerPath = NodePath.join(npmPrefix, "npm.cmd");
        const npmManagerExePath = NodePath.join(npmPrefix, "npm.exe");
        yield* fileSystem.makeDirectory(npmPrefix, { recursive: true });
        yield* fileSystem.writeFileString(npmManagerPath, "@echo off\r\n");
        yield* fileSystem.writeFileString(npmManagerExePath, "unverified colliding executable\n");

        const commandCodeManifestPath = NodePath.join(
          npmPrefix,
          "node_modules",
          "command-code",
          "package.json",
        );
        const commandCodeBinTarget = "bin/cli.js";
        const commandCodeBinPath = NodePath.join(
          NodePath.dirname(commandCodeManifestPath),
          ...commandCodeBinTarget.split("/"),
        );
        const commandCodeShimPath = NodePath.join(npmPrefix, "cmdc.cmd");
        yield* fileSystem.makeDirectory(NodePath.dirname(commandCodeBinPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(commandCodeBinPath, "console.log('command code');\n");
        yield* fileSystem.writeFileString(
          commandCodeManifestPath,
          `${JSON.stringify({
            name: "command-code",
            version: "0.52.1",
            bin: {
              cmd: commandCodeBinTarget,
              cmdc: commandCodeBinTarget,
              "command-code": commandCodeBinTarget,
              commandcode: commandCodeBinTarget,
            },
            _requested: {
              type: "tag",
              rawSpec: "latest",
              raw: "command-code@latest",
            },
          })}\n`,
        );
        yield* fileSystem.writeFileString(
          commandCodeShimPath,
          windowsNpmCmdShim("command-code", commandCodeBinTarget),
        );
        const commandCode = yield* resolveProviderMaintenanceCapabilitiesEffect(
          COMMAND_CODE_DEFINITION,
          {
            binaryPath: "cmdc",
            env: { PATH: npmPrefix, PATHEXT: ".CMD;.EXE" },
            platform: "win32",
          },
          {
            resolveWindowsCommandPath: resolveWindowsCommandFromCandidates([commandCodeShimPath]),
          },
        );

        const droidManifestPath = NodePath.join(npmPrefix, "node_modules", "droid", "package.json");
        const droidBinTarget = "bin/droid.js";
        const droidBinPath = NodePath.join(
          NodePath.dirname(droidManifestPath),
          ...droidBinTarget.split("/"),
        );
        const droidShimPath = NodePath.join(npmPrefix, "droid.cmd");
        yield* fileSystem.makeDirectory(NodePath.dirname(droidBinPath), { recursive: true });
        yield* fileSystem.writeFileString(droidBinPath, "console.log('droid');\n");
        yield* fileSystem.writeFileString(
          droidManifestPath,
          `${JSON.stringify({
            name: "droid",
            version: "0.41.0",
            bin: { droid: droidBinTarget },
            _requested: { type: "tag", rawSpec: "latest", raw: "droid@latest" },
          })}\n`,
        );
        yield* fileSystem.writeFileString(
          droidShimPath,
          windowsNpmCmdShim("droid", droidBinTarget),
        );
        const droidExePath = NodePath.join(npmPrefix, "droid.exe");
        yield* fileSystem.writeFileString(droidExePath, "unverified colliding executable\n");
        let selectedCmdPathExt: string | undefined;
        const droid = yield* resolveProviderMaintenanceCapabilitiesEffect(
          DROID_DEFINITION,
          {
            binaryPath: NodePath.join(npmPrefix, "droid"),
            env: { PATH: npmPrefix, PATHEXT: ".CMD;.EXE" },
            platform: "win32",
          },
          {
            resolveWindowsCommandPath: resolveWindowsCommandFromCandidates(
              [droidShimPath, droidExePath],
              (input) => {
                selectedCmdPathExt = input.env?.PATHEXT;
              },
            ),
          },
        );
        const unverifiedSelectedDroid = yield* resolveProviderMaintenanceCapabilitiesEffect(
          DROID_DEFINITION,
          {
            binaryPath: NodePath.join(npmPrefix, "droid"),
            env: { PATH: npmPrefix, PATHEXT: ".EXE;.CMD" },
            platform: "win32",
          },
          {
            resolveWindowsCommandPath: resolveWindowsCommandFromCandidates([
              droidExePath,
              droidShimPath,
            ]),
          },
        );
        return {
          commandCode,
          commandCodeShimPath,
          droid,
          droidShimPath,
          npmManagerPath,
          selectedCmdPathExt,
          unverifiedSelectedDroid,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    assert.ok(result.commandCode.update);
    assert.strictEqual(
      NodePath.win32.extname(result.commandCode.update.executable).toLowerCase(),
      ".cmd",
    );
    assert.strictEqual(
      normalizeCommandPath(result.commandCode.update.target.visibleCommandPath, "win32"),
      normalizeCommandPath(result.commandCodeShimPath, "win32"),
    );
    assert.ok(result.droid.update);
    assert.strictEqual(
      NodePath.win32.extname(result.droid.update.executable).toLowerCase(),
      ".cmd",
    );
    assert.strictEqual(
      normalizeCommandPath(result.droid.update.target.visibleCommandPath, "win32"),
      normalizeCommandPath(result.droidShimPath, "win32"),
    );
    assert.strictEqual(result.selectedCmdPathExt, ".CMD;.EXE");
    assert.strictEqual(result.unverifiedSelectedDroid.update, null);
  });

  it("uses the selected standalone Codex executable for native updates", () => {
    const binaryPath =
      "C:\\Users\\Test User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath,
      realCommandPath: binaryPath,
      canonicalInstallRoot: "C:\\Users\\Test User\\AppData\\Local\\Programs\\OpenAI\\Codex",
      managerExecutablePath: binaryPath,
      realManagerExecutablePath: binaryPath,
      platform: "win32",
    });

    assert.ok(capabilities.update);
    assert.strictEqual(capabilities.update.command, `"${binaryPath}" update`);
    assert.strictEqual(capabilities.update.executable, binaryPath);
    assert.deepStrictEqual(capabilities.update.args, ["update"]);
    assert.strictEqual(
      capabilities.update.lockKey,
      "codex-native:c:/users/test user/appdata/local/programs/openai/codex",
    );
    assert.deepStrictEqual(capabilities.update.target.channel, {
      kind: "native-self-update",
      provider: "codex",
    });
  });

  it("keeps visible and canonical Codex paths distinct for a Windows installer junction", () => {
    const visibleCommandPath =
      "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const canonicalCommandPath =
      "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\releases\\0.130.0\\codex.exe";
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "win32",
      binaryPath: visibleCommandPath,
      realCommandPath: canonicalCommandPath,
      canonicalInstallRoot: "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex",
      managerExecutablePath: visibleCommandPath,
      realManagerExecutablePath: canonicalCommandPath,
    });

    assert.ok(capabilities.update);
    assert.strictEqual(capabilities.update.executable, visibleCommandPath);
    assert.strictEqual(capabilities.update.target.visibleCommandPath, visibleCommandPath);
    assert.strictEqual(capabilities.update.target.canonicalCommandPath, canonicalCommandPath);
    const updatedCanonicalCommandPath =
      "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\releases\\0.131.0\\codex.exe";
    const updatedCapabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "win32",
      binaryPath: visibleCommandPath,
      realCommandPath: updatedCanonicalCommandPath,
      canonicalInstallRoot: "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex",
      managerExecutablePath: visibleCommandPath,
      realManagerExecutablePath: updatedCanonicalCommandPath,
    });
    assert.ok(updatedCapabilities.update);
    assert.notStrictEqual(
      capabilities.update.targetFingerprint,
      updatedCapabilities.update.targetFingerprint,
    );
    assert.strictEqual(
      providerMaintenanceTargetsShareUpdateDestination(
        capabilities.update.target,
        updatedCapabilities.update.target,
      ),
      true,
    );
  });

  win("does not fall back to a different npm install when native Codex is selected", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-provider-maintenance-native-selection-",
        });
        const nativeBinaryPath = NodePath.join(
          tempDirectory,
          "Programs",
          "OpenAI",
          "Codex",
          "bin",
          "codex.exe",
        );
        const npmPrefix = NodePath.join(tempDirectory, "npm");
        const npmShimPath = NodePath.join(npmPrefix, "codex.cmd");
        const npmPackageManifestPath = NodePath.join(
          npmPrefix,
          "node_modules",
          "@openai",
          "codex",
          "package.json",
        );
        yield* fileSystem.makeDirectory(NodePath.dirname(nativeBinaryPath), { recursive: true });
        yield* fileSystem.makeDirectory(NodePath.dirname(npmPackageManifestPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(nativeBinaryPath, "standalone codex fixture\n");
        yield* fileSystem.writeFileString(
          npmShimPath,
          windowsNpmCmdShim("@openai/codex", CODEX_PACKAGE_BIN_TARGET),
        );
        yield* fileSystem.writeFileString(npmPackageManifestPath, codexPackageManifest());

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(CODEX_DEFINITION, {
          binaryPath: nativeBinaryPath,
          env: { PATH: npmPrefix },
          platform: "win32",
        });
        return { capabilities, nativeBinaryPath };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    const renderedBinaryPath = /\s/u.test(result.nativeBinaryPath)
      ? `"${result.nativeBinaryPath}"`
      : result.nativeBinaryPath;
    assert.ok(result.capabilities.update);
    assert.strictEqual(result.capabilities.update.command, `${renderedBinaryPath} update`);
    assert.strictEqual(result.capabilities.update.executable, result.nativeBinaryPath);
    assert.deepStrictEqual(result.capabilities.update.args, ["update"]);
    assert.strictEqual(
      result.capabilities.update.lockKey,
      `codex-native:${normalizeCommandPath(
        NodePath.dirname(NodePath.dirname(result.nativeBinaryPath)),
        "win32",
      )}`,
    );
  });

  it("does not guess an update command for unclassified binaries", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "C:\\custom\\bin\\codex.exe",
      realCommandPath: "C:\\custom\\bin\\codex.exe",
      platform: "win32",
    });

    assert.strictEqual(capabilities.update, null);
  });

  it("does not classify a Windows Codex suffix as standalone on POSIX", () => {
    const binaryPath = "/tmp/Programs/OpenAI/Codex/bin/codex.exe";
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "linux",
      binaryPath,
      realCommandPath: binaryPath,
      canonicalInstallRoot: "/tmp/Programs/OpenAI/Codex",
      managerExecutablePath: binaryPath,
      realManagerExecutablePath: binaryPath,
    });

    assert.strictEqual(capabilities.update, null);
  });

  it("does not classify an arbitrary Homebrew bin path as package ownership", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath: "/opt/homebrew/bin/codex",
      realCommandPath: "/opt/homebrew/bin/codex",
    });
    const wrongCask = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath: "/opt/homebrew/bin/codex",
      realCommandPath: "/opt/homebrew/Caskroom/not-codex/0.130.0/codex",
    });

    assert.strictEqual(capabilities.update, null);
    assert.strictEqual(wrongCask.update, null);
  });

  posix("keeps absent and unverified bare commands manual-only", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-provider-maintenance-unverified-command-",
        });
        const resolve = () =>
          resolveProviderMaintenanceCapabilitiesEffect(OPENCODE_DEFINITION, {
            binaryPath: "opencode",
            env: { PATH: tempDirectory },
            platform: "linux",
          });

        const absent = yield* resolve();
        yield* fileSystem.writeFileString(NodePath.join(tempDirectory, "opencode"), "wrapper\n");
        const unverified = yield* resolve();
        return { absent, unverified };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    assert.strictEqual(result.absent.update, null);
    assert.strictEqual(result.unverified.update, null);
  });

  it("allows an always-native updater only for a positively matched native path", () => {
    const binaryPath = "/Users/test/.opencode/bin/opencode";
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      platform: "darwin",
      binaryPath,
      realCommandPath: binaryPath,
      canonicalInstallRoot: "/Users/test/.opencode/bin",
      managerExecutablePath: binaryPath,
      realManagerExecutablePath: binaryPath,
    });

    assert.ok(capabilities.update);
    assert.strictEqual(capabilities.update.command, `${binaryPath} upgrade`);
    assert.strictEqual(capabilities.update.executable, binaryPath);
    assert.deepStrictEqual(capabilities.update.args, ["upgrade"]);
    assert.strictEqual(capabilities.update.lockKey, "opencode-native:/Users/test/.opencode/bin");
    assert.strictEqual(capabilities.update.pathPrepend, "/Users/test/.opencode/bin");
  });

  it("resolves Homebrew cask update commands", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      platform: "darwin",
      binaryPath: "/opt/homebrew/bin/codex",
      realCommandPath: "/opt/homebrew/Caskroom/codex/0.130.0/codex",
      canonicalInstallRoot: "/opt/homebrew",
      managerExecutablePath: "/opt/homebrew/bin/brew",
      realManagerExecutablePath: "/opt/homebrew/bin/brew",
    });

    assert.ok(capabilities.update);
    assert.strictEqual(capabilities.update.command, "/opt/homebrew/bin/brew upgrade --cask codex");
    assert.strictEqual(capabilities.update.executable, "/opt/homebrew/bin/brew");
    assert.deepStrictEqual(capabilities.update.args, ["upgrade", "--cask", "codex"]);
    assert.strictEqual(capabilities.update.lockKey, "homebrew:/opt/homebrew");
    assert.strictEqual(capabilities.packageName, null);
  });

  it("uses the owning package manager for a detected pnpm install", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      platform: "darwin",
      binaryPath: "/Users/test/.local/share/pnpm/opencode",
      realCommandPath:
        "/Users/test/.local/share/pnpm/global/5/.pnpm/opencode-ai@1.14.46/node_modules/opencode-ai/bin/opencode",
      canonicalInstallRoot: "/Users/test/.local/share/pnpm/global/5",
      managerExecutablePath: "/Users/test/.local/share/pnpm/pnpm",
      realManagerExecutablePath: "/Users/test/.local/share/pnpm/pnpm.cjs",
      packageChannelEvidence: latestChannel(
        "1.14.46",
        "/Users/test/.local/share/pnpm/global/5/package.json",
      ),
    });

    assert.ok(capabilities.update);
    assert.strictEqual(
      capabilities.update.command,
      "/Users/test/.local/share/pnpm/pnpm add -g opencode-ai@latest",
    );
    assert.strictEqual(capabilities.update.executable, "/Users/test/.local/share/pnpm/pnpm");
    assert.deepStrictEqual(capabilities.update.args, ["add", "-g", "opencode-ai@latest"]);
    assert.strictEqual(
      capabilities.update.lockKey,
      "pnpm-global:/Users/test/.local/share/pnpm/global/5",
    );
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "npm",
      name: "opencode-ai",
    });
    const updatedCapabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      platform: "darwin",
      binaryPath: "/Users/test/.local/share/pnpm/opencode",
      realCommandPath:
        "/Users/test/.local/share/pnpm/global/5/.pnpm/opencode-ai@1.14.47/node_modules/opencode-ai/bin/opencode",
      canonicalInstallRoot: "/Users/test/.local/share/pnpm/global/5",
      managerExecutablePath: "/Users/test/.local/share/pnpm/pnpm",
      realManagerExecutablePath: "/Users/test/.local/share/pnpm/pnpm.cjs",
      packageChannelEvidence: latestChannel(
        "1.14.47",
        "/Users/test/.local/share/pnpm/global/5/package.json",
      ),
    });
    assert.ok(updatedCapabilities.update);
    assert.notStrictEqual(
      capabilities.update.targetFingerprint,
      updatedCapabilities.update.targetFingerprint,
    );
    assert.strictEqual(
      providerMaintenanceTargetsShareUpdateDestination(
        capabilities.update.target,
        updatedCapabilities.update.target,
      ),
      true,
    );
  });

  it("uses Homebrew updates and same-channel latest metadata for tapped OpenCode installs", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      platform: "darwin",
      binaryPath: "/opt/homebrew/bin/opencode",
      realCommandPath: "/opt/homebrew/Cellar/opencode/1.14.46/bin/opencode",
      canonicalInstallRoot: "/opt/homebrew",
      managerExecutablePath: "/opt/homebrew/bin/brew",
      realManagerExecutablePath: "/opt/homebrew/bin/brew",
    });

    assert.ok(capabilities.update);
    assert.strictEqual(
      capabilities.update.command,
      "/opt/homebrew/bin/brew upgrade anomalyco/tap/opencode",
    );
    assert.strictEqual(capabilities.update.executable, "/opt/homebrew/bin/brew");
    assert.deepStrictEqual(capabilities.update.args, ["upgrade", "anomalyco/tap/opencode"]);
    assert.strictEqual(capabilities.update.lockKey, "homebrew:/opt/homebrew");
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "homebrew",
      name: "anomalyco/tap/opencode",
      homebrewKind: "formula",
    });
  });

  it.effect("coalesces concurrent normal latest-version lookups", () => {
    const mock = makeDeferredFetchMock(1);
    const capabilities = latestNpmCapabilities("@synara-tests/latest-normal-coalescing");

    return withFetchMock(
      mock.fetchMock,
      Effect.gen(function* () {
        const requests = yield* Effect.all(
          [resolveLatestProviderVersion(capabilities), resolveLatestProviderVersion(capabilities)],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* waitForFetchRequests(mock.requests, 1);
        yield* yieldToConcurrentRequests;
        assert.strictEqual(mock.requests.length, 1);

        mock.requests[0]!.resolve(npmVersionResponse("1.2.3"));
        assert.deepStrictEqual(yield* Fiber.join(requests), ["1.2.3", "1.2.3"]);
        assert.strictEqual(yield* resolveLatestProviderVersion(capabilities), "1.2.3");
        assert.strictEqual(mock.requests.length, 1);
      }),
    );
  });

  it.effect("prevents an older normal lookup from overwriting a forced generation", () => {
    const mock = makeDeferredFetchMock(2);
    const capabilities = latestNpmCapabilities("@synara-tests/latest-forced-generation");

    return withFetchMock(
      mock.fetchMock,
      Effect.gen(function* () {
        const normal = yield* resolveLatestProviderVersion(capabilities).pipe(Effect.forkChild);
        yield* waitForFetchRequests(mock.requests, 1);

        const forced = yield* resolveLatestProviderVersion(capabilities, {
          forceRefresh: true,
        }).pipe(Effect.forkChild);
        yield* waitForFetchRequests(mock.requests, 2);

        mock.requests[1]!.resolve(npmVersionResponse("2.0.0"));
        assert.strictEqual(yield* Fiber.join(forced), "2.0.0");
        mock.requests[0]!.resolve(npmVersionResponse("1.0.0"));
        assert.strictEqual(yield* Fiber.join(normal), "1.0.0");

        assert.strictEqual(yield* resolveLatestProviderVersion(capabilities), "2.0.0");
        assert.strictEqual(mock.requests.length, 2);
      }),
    );
  });

  it.effect("keeps a forced null result authoritative over an older normal lookup", () => {
    const mock = makeDeferredFetchMock(2);
    const capabilities = latestNpmCapabilities("@synara-tests/latest-forced-null");

    return withFetchMock(
      mock.fetchMock,
      Effect.gen(function* () {
        const normal = yield* resolveLatestProviderVersion(capabilities).pipe(Effect.forkChild);
        yield* waitForFetchRequests(mock.requests, 1);

        const forced = yield* resolveLatestProviderVersion(capabilities, {
          forceRefresh: true,
        }).pipe(Effect.forkChild);
        yield* waitForFetchRequests(mock.requests, 2);

        mock.requests[1]!.resolve(new Response(null, { status: 503 }));
        assert.strictEqual(yield* Fiber.join(forced), null);
        mock.requests[0]!.resolve(npmVersionResponse("1.0.0"));
        assert.strictEqual(yield* Fiber.join(normal), "1.0.0");

        assert.strictEqual(yield* resolveLatestProviderVersion(capabilities), null);
        assert.strictEqual(mock.requests.length, 2);
      }),
    );
  });

  it.effect("coalesces concurrent forced refreshes into one generation", () => {
    const mock = makeDeferredFetchMock(1);
    const capabilities = latestNpmCapabilities("@synara-tests/latest-forced-coalescing");

    return withFetchMock(
      mock.fetchMock,
      Effect.gen(function* () {
        const requests = yield* Effect.all(
          [
            resolveLatestProviderVersion(capabilities, { forceRefresh: true }),
            resolveLatestProviderVersion(capabilities, { forceRefresh: true }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* waitForFetchRequests(mock.requests, 1);
        yield* yieldToConcurrentRequests;
        assert.strictEqual(mock.requests.length, 1);

        mock.requests[0]!.resolve(npmVersionResponse("3.0.0"));
        assert.deepStrictEqual(yield* Fiber.join(requests), ["3.0.0", "3.0.0"]);
        assert.strictEqual(yield* resolveLatestProviderVersion(capabilities), "3.0.0");
        assert.strictEqual(mock.requests.length, 1);
      }),
    );
  });

  it("marks older semver versions as behind latest", () => {
    const advisory = createProviderVersionAdvisory({
      provider: "codex",
      currentVersion: "0.129.0",
      latestVersion: "0.130.0",
    });

    assert.strictEqual(advisory.status, "behind_latest");
    assert.strictEqual(advisory.currentVersion, "0.129.0");
    assert.strictEqual(advisory.latestVersion, "0.130.0");
  });
});
