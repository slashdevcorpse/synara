#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect, FileSystem, Logger, Option, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { assertPatchedEffectProcessSpawnerIsBundled, bytesEqual } from "./cliPublishContract.ts";
import rootPackageJson from "../../../package.json" with { type: "json" };
import serverPackageJson from "../package.json" with { type: "json" };

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const ACP_WINDOWS_JOB_HELPER_FILES = ["acp-windows-job.ps1", "acp-windows-job-native.cs"] as const;

// Some desktop builds do not expose workspace metadata in the root package.json.
// Publish prep only needs the catalog map when it exists.
function resolveRootWorkspaceCatalog(): Record<string, unknown> {
  const rootWorkspaces =
    typeof rootPackageJson === "object" &&
    rootPackageJson !== null &&
    "workspaces" in rootPackageJson
      ? rootPackageJson.workspaces
      : null;

  if (
    typeof rootWorkspaces !== "object" ||
    rootWorkspaces === null ||
    !("catalog" in rootWorkspaces)
  ) {
    return {};
  }

  const catalog = rootWorkspaces.catalog;
  return typeof catalog === "object" && catalog !== null
    ? (catalog as Record<string, unknown>)
    : {};
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new CliError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

const makeNpmCommand = Effect.fn("makeNpmCommand")(function* (
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly verbose: boolean;
  },
) {
  if (process.platform !== "win32") {
    return ChildProcess.make("npm", args, {
      cwd: options.cwd,
      stdout: options.verbose ? "inherit" : "ignore",
      stderr: "inherit",
      shell: false,
    });
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const configuredNpmCli = process.env.npm_execpath?.trim();
  const npmCliCandidates = [
    ...(configuredNpmCli && /\.(?:c?js|mjs)$/iu.test(configuredNpmCli) ? [configuredNpmCli] : []),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const npmCliPath of npmCliCandidates) {
    if (path.isAbsolute(npmCliPath) && (yield* fs.exists(npmCliPath))) {
      return ChildProcess.make(process.execPath, [npmCliPath, ...args], {
        cwd: options.cwd,
        stdout: options.verbose ? "inherit" : "ignore",
        stderr: "inherit",
        shell: false,
      });
    }
  }

  return yield* new CliError({
    message: `Cannot locate npm's JavaScript CLI beside Node: ${process.execPath}`,
  });
});

const packStagedPackage = Effect.fn("packStagedPackage")(function* (input: {
  readonly stagedPackageDir: string;
  readonly verbose: boolean;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const packDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "synara-cli-pack-",
  });
  const packCommand = yield* makeNpmCommand(
    ["pack", "--pack-destination", packDirectory, ...(input.verbose ? [] : ["--loglevel=error"])],
    { cwd: input.stagedPackageDir, verbose: input.verbose },
  );
  yield* runCommand(packCommand);

  const tarballs = (yield* fs.readDirectory(packDirectory))
    .filter((entry) => entry.endsWith(".tgz"))
    .sort();
  if (tarballs.length !== 1) {
    return yield* new CliError({
      message: `Expected exactly one packed CLI tarball, found: ${tarballs.join(", ") || "none"}`,
    });
  }
  return path.join(packDirectory, tarballs[0] ?? "");
});

const verifyIsolatedPackageInstall = Effect.fn("verifyIsolatedPackageInstall")(function* (input: {
  readonly packageName: string;
  readonly serverDir: string;
  readonly tarballPath: string;
  readonly verbose: boolean;
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(input.packageName)) {
    return yield* new CliError({
      message: `Cannot verify an invalid npm package name: ${input.packageName}`,
    });
  }

  const installDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "synara-cli-install-",
  });
  yield* fs.writeFileString(
    path.join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "synara-cli-install-smoke", private: true }, null, 2)}\n`,
  );
  const installCommand = yield* makeNpmCommand(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...(input.verbose ? [] : ["--loglevel=error"]),
      input.tarballPath,
    ],
    { cwd: installDirectory, verbose: input.verbose },
  );
  yield* runCommand(installCommand);

  const installedPackageDirectory = path.join(
    installDirectory,
    "node_modules",
    ...input.packageName.split("/"),
  );
  const installedDistDirectory = path.join(installedPackageDirectory, "dist");
  const installedRuntimeEntries = (yield* fs.readDirectory(installedDistDirectory))
    .filter((entry) => entry.endsWith(".mjs") || entry.endsWith(".cjs"))
    .sort();
  const installedRuntimeBundles = yield* Effect.forEach(installedRuntimeEntries, (entry) =>
    fs
      .readFileString(path.join(installedDistDirectory, entry))
      .pipe(Effect.map((source) => ({ path: entry, source }))),
  );
  yield* Effect.try({
    try: () => assertPatchedEffectProcessSpawnerIsBundled(installedRuntimeBundles),
    catch: (cause) =>
      new CliError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

  for (const helperFile of ACP_WINDOWS_JOB_HELPER_FILES) {
    const [source, installed] = yield* Effect.all([
      fs.readFile(path.join(input.serverDir, "scripts", helperFile)),
      fs.readFile(path.join(installedDistDirectory, helperFile)),
    ]);
    if (!bytesEqual(source, installed)) {
      return yield* new CliError({
        message: `Packed CLI contains a stale Windows ACP helper: ${helperFile}`,
      });
    }
  }

  yield* Effect.log("[cli] Verified patched runtime from an isolated packed CLI install");
});

const applyPublishIconOverrides = Effect.fn("applyPublishIconOverrides")(function* (
  repoRoot: string,
  stagedPackageDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of PUBLISH_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(stagedPackageDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing publish icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing publish icon target: ${targetPath}. Run the build subcommand first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied publish icon overrides inside the isolated package stage");
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing development icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing development icon target: ${targetPath}. Build web first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make({
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
          shell: process.platform === "win32",
        })`bun tsdown`,
      );

      for (const helperFile of ACP_WINDOWS_JOB_HELPER_FILES) {
        const helperSource = path.join(serverDir, "scripts", helperFile);
        if (!(yield* fs.exists(helperSource))) {
          return yield* new CliError({
            message: `Missing Windows ACP Job Object helper: ${helperSource}`,
          });
        }
        yield* fs.copyFile(helperSource, path.join(serverDir, "dist", helperFile));
      }
      yield* Effect.log("[cli] Bundled Windows ACP Job Object helper");

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      // Assert build assets exist
      for (const relPath of [
        "dist/index.mjs",
        "dist/index.cjs",
        "dist/restoreMigrationBackup.mjs",
        "dist/acp-windows-job.ps1",
        "dist/acp-windows-job-native.cs",
        "dist/client/index.html",
      ]) {
        const abs = path.join(serverDir, relPath);
        if (!(yield* fs.exists(abs))) {
          return yield* new CliError({
            message: `Missing build asset: ${abs}. Run the build subcommand first.`,
          });
        }
      }

      for (const helperFile of ACP_WINDOWS_JOB_HELPER_FILES) {
        const sourcePath = path.join(serverDir, "scripts", helperFile);
        const distPath = path.join(serverDir, "dist", helperFile);
        if (!(yield* fs.exists(sourcePath))) {
          return yield* new CliError({
            message: `Missing Windows ACP helper source: ${sourcePath}`,
          });
        }
        const [source, built] = yield* Effect.all([fs.readFile(sourcePath), fs.readFile(distPath)]);
        if (!bytesEqual(source, built)) {
          return yield* new CliError({
            message: `Stale Windows ACP helper in dist: ${helperFile}. Run the build subcommand again.`,
          });
        }
      }

      const runtimeBundleEntries = (yield* fs.readDirectory(path.join(serverDir, "dist")))
        .filter((entry) => entry.endsWith(".mjs") || entry.endsWith(".cjs"))
        .sort();
      if (runtimeBundleEntries.length === 0) {
        return yield* new CliError({ message: "No server runtime bundles were produced." });
      }
      const runtimeBundles = yield* Effect.forEach(runtimeBundleEntries, (entry) =>
        fs
          .readFileString(path.join(serverDir, "dist", entry))
          .pipe(Effect.map((source) => ({ path: entry, source }))),
      );
      yield* Effect.try({
        try: () => assertPatchedEffectProcessSpawnerIsBundled(runtimeBundles),
        catch: (cause) =>
          new CliError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
      const pkg = {
        name: serverPackageJson.name,
        license: serverPackageJson.license,
        repository: serverPackageJson.repository,
        bin: serverPackageJson.bin,
        type: serverPackageJson.type,
        version,
        engines: serverPackageJson.engines,
        files: serverPackageJson.files,
        dependencies: resolveCatalogDependencies(
          serverPackageJson.dependencies as Record<string, unknown>,
          resolveRootWorkspaceCatalog(),
          "apps/server dependencies",
        ),
      };

      const stagedPackageDir = yield* fs.makeTempDirectoryScoped({
        prefix: "synara-cli-publish-",
      });
      yield* fs.copy(path.join(serverDir, "dist"), path.join(stagedPackageDir, "dist"));
      for (const binTarget of Object.values(pkg.bin)) {
        if (typeof binTarget !== "string" || !binTarget.startsWith("dist/")) {
          return yield* new CliError({
            message: `CLI bin target must stay inside the staged dist directory: ${String(binTarget)}`,
          });
        }
        const stagedBinPath = path.join(stagedPackageDir, binTarget);
        if (!(yield* fs.exists(stagedBinPath))) {
          return yield* new CliError({ message: `Missing staged CLI bin target: ${binTarget}` });
        }
        const stagedBin = yield* fs.readFileString(stagedBinPath);
        if (!stagedBin.startsWith("#!/usr/bin/env node\n")) {
          return yield* new CliError({
            message: `Staged CLI bin target is missing its Node shebang: ${binTarget}`,
          });
        }
        yield* fs.chmod(stagedBinPath, 0o755);
      }
      yield* applyPublishIconOverrides(repoRoot, stagedPackageDir);
      yield* fs.writeFileString(
        path.join(stagedPackageDir, "package.json"),
        `${JSON.stringify(pkg, null, 2)}\n`,
      );
      const stagedRootEntries = (yield* fs.readDirectory(stagedPackageDir)).sort();
      if (
        stagedRootEntries.length !== 2 ||
        stagedRootEntries[0] !== "dist" ||
        stagedRootEntries[1] !== "package.json"
      ) {
        return yield* new CliError({
          message: `Unexpected CLI publish-stage entries: ${stagedRootEntries.join(", ")}`,
        });
      }

      const tarballPath = yield* packStagedPackage({
        stagedPackageDir,
        verbose: config.verbose,
      });
      yield* verifyIsolatedPackageInstall({
        packageName: pkg.name,
        serverDir,
        tarballPath,
        verbose: config.verbose,
      });

      const args = ["publish", tarballPath, "--access", config.access, "--tag", config.tag];
      if (config.provenance) args.push("--provenance");
      if (config.dryRun) args.push("--dry-run");
      if (!config.verbose) args.push("--loglevel=error");

      yield* Effect.log(`[cli] Publishing the exact verified tarball: npm ${args.join(" ")}`);
      const publishCommand = yield* makeNpmCommand(args, {
        cwd: stagedPackageDir,
        verbose: config.verbose,
      });
      yield* runCommand(publishCommand);
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("Synara server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
