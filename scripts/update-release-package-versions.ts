import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

interface UpdateReleasePackageVersionsOptions {
  readonly rootDir?: string;
}

interface MutablePackageJson {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

interface PreparedPackageVersionUpdate {
  readonly filePath: string;
  readonly manifestPath: string;
  readonly packageJson: MutablePackageJson;
  readonly changed: boolean;
}

function updateLockfileWorkspaceVersion(
  lockfile: string,
  update: PreparedPackageVersionUpdate,
  version: string,
): { readonly changed: boolean; readonly lockfile: string } {
  const packageName = update.packageJson.name;
  if (!packageName) {
    throw new Error(`Expected ${update.manifestPath} to declare a package name.`);
  }

  const workspacePath = dirname(update.manifestPath).split(sep).join("/");
  const newline = lockfile.includes("\r\n") ? "\r\n" : "\n";
  const lines = lockfile.split(newline);
  const importerLine = `    ${JSON.stringify(workspacePath)}: {`;
  const importerIndexes = lines.flatMap((line, index) => (line === importerLine ? [index] : []));
  if (importerIndexes.length !== 1) {
    throw new Error(
      `Expected bun.lock to contain exactly one ${workspacePath} workspace importer; found ${importerIndexes.length}.`,
    );
  }

  const importerIndex = importerIndexes[0];
  if (importerIndex === undefined) {
    throw new Error(`Expected bun.lock to contain the ${workspacePath} workspace importer.`);
  }
  const importerEndIndex = lines.findIndex(
    (line, index) => index > importerIndex && line === "    },",
  );
  if (importerEndIndex < 0) {
    throw new Error(`Expected bun.lock to terminate the ${workspacePath} workspace importer.`);
  }

  const expectedNameLine = `      "name": ${JSON.stringify(packageName)},`;
  const nameIndexes = lines.flatMap((line, index) =>
    index > importerIndex && index < importerEndIndex && line.startsWith('      "name": ')
      ? [index]
      : [],
  );
  if (nameIndexes.length !== 1 || lines[nameIndexes[0] ?? -1] !== expectedNameLine) {
    throw new Error(
      `Expected bun.lock importer ${workspacePath} to identify package ${packageName}.`,
    );
  }

  const versionIndexes = lines.flatMap((line, index) =>
    index > importerIndex && index < importerEndIndex && line.startsWith('      "version": ')
      ? [index]
      : [],
  );
  if (versionIndexes.length !== 1) {
    throw new Error(
      `Expected bun.lock importer ${workspacePath} to contain exactly one version; found ${versionIndexes.length}.`,
    );
  }

  const versionIndex = versionIndexes[0];
  if (versionIndex === undefined) {
    throw new Error(`Expected bun.lock importer ${workspacePath} to contain a version.`);
  }
  const nextVersionLine = `      "version": ${JSON.stringify(version)},`;
  if (lines[versionIndex] === nextVersionLine) {
    return { changed: false, lockfile };
  }

  lines[versionIndex] = nextVersionLine;
  return { changed: true, lockfile: lines.join(newline) };
}

export function updateReleasePackageVersions(
  version: string,
  options: UpdateReleasePackageVersionsOptions = {},
): { changed: boolean } {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const packageUpdates = releasePackageFiles.map((manifestPath) => {
    const filePath = resolve(rootDir, manifestPath);
    const packageJson = JSON.parse(readFileSync(filePath, "utf8")) as MutablePackageJson;
    return {
      filePath,
      manifestPath,
      packageJson,
      changed: packageJson.version !== version,
    } satisfies PreparedPackageVersionUpdate;
  });

  const lockfilePath = resolve(rootDir, "bun.lock");
  let nextLockfile = readFileSync(lockfilePath, "utf8");
  let lockfileChanged = false;
  for (const update of packageUpdates) {
    const result = updateLockfileWorkspaceVersion(nextLockfile, update, version);
    nextLockfile = result.lockfile;
    lockfileChanged ||= result.changed;
  }

  for (const update of packageUpdates) {
    if (!update.changed) {
      continue;
    }
    update.packageJson.version = version;
    writeFileSync(update.filePath, `${JSON.stringify(update.packageJson, null, 2)}\n`);
  }
  if (lockfileChanged) {
    writeFileSync(lockfilePath, nextLockfile);
  }

  return { changed: lockfileChanged || packageUpdates.some((update) => update.changed) };
}

function parseArgs(argv: ReadonlyArray<string>): {
  version: string;
  rootDir: string | undefined;
  writeGithubOutput: boolean;
} {
  let version: string | undefined;
  let rootDir: string | undefined;
  let writeGithubOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--github-output") {
      writeGithubOutput = true;
      continue;
    }

    if (argument === "--root") {
      rootDir = argv[index + 1];
      if (!rootDir) {
        throw new Error("Missing value for --root.");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (version !== undefined) {
      throw new Error("Only one release version can be provided.");
    }
    version = argument;
  }

  if (!version) {
    throw new Error(
      "Usage: node scripts/update-release-package-versions.ts <version> [--root <path>] [--github-output]",
    );
  }

  return { version, rootDir, writeGithubOutput };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { version, rootDir, writeGithubOutput } = parseArgs(process.argv.slice(2));
  const { changed } = updateReleasePackageVersions(
    version,
    rootDir === undefined ? {} : { rootDir },
  );

  if (!changed) {
    console.log("All package.json versions already match release version.");
  }

  if (writeGithubOutput) {
    const githubOutputPath = process.env.GITHUB_OUTPUT;
    if (!githubOutputPath) {
      throw new Error("GITHUB_OUTPUT is required when --github-output is set.");
    }
    appendFileSync(githubOutputPath, `changed=${changed}\n`);
  }
}
