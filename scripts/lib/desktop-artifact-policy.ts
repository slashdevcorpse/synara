// FILE: desktop-artifact-policy.ts
// Purpose: Defines identity and updater policy for staged desktop packages.

import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { SynaraDesktopFlavor, SynaraDesktopIdentity } from "@synara/shared/desktopIdentity";

export interface DesktopGitHubPublishConfig {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly releaseType: "release";
}

const FROZEN_STAGE_INSTALL_ARGS = [
  "install",
  "--production",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--linker",
  "hoisted",
] as const;

export function resolveDesktopStageInstallArgs(
  flavor: Exclude<SynaraDesktopFlavor, "development">,
): ReadonlyArray<string> {
  if (flavor === "super") {
    return ["install", "--production", "--ignore-scripts", "--linker", "hoisted"];
  }
  return [...FROZEN_STAGE_INSTALL_ARGS, "--filter", "@synara/cli", "--filter", "@synara/desktop"];
}

export function resolveSuperDesktopStageInstallEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...inheritedEnvironment };
  delete environment.npm_config_user_agent;
  return environment;
}

export function desktopStageFileBytesMatch(
  repositoryFile: Uint8Array,
  stagedFile: Uint8Array,
): boolean {
  return Buffer.from(repositoryFile).equals(Buffer.from(stagedFile));
}

export function resolveDesktopSourceTag(
  flavor: Exclude<SynaraDesktopFlavor, "development">,
  version: string,
): string {
  return flavor === "super" ? `super-v${version}` : `v${version}`;
}

export function resolveDesktopPlatformBuildVersion(
  flavor: Exclude<SynaraDesktopFlavor, "development">,
  version: string,
): string {
  if (flavor !== "super") return version;

  const match = /^(\d+)\.(\d+)\.(\d+)(?:-super\.(\d+))?$/.exec(version);
  if (!match) {
    throw new Error(
      `Super Synara version '${version}' must use <major>.<minor>.<patch> or <major>.<minor>.<patch>-super.<number>.`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}.${match[4] ?? "0"}`;
}

export function resolveDesktopGitHubPublishConfig(input: {
  readonly disableUpdates: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): DesktopGitHubPublishConfig | undefined {
  if (input.disableUpdates) return undefined;

  const env = input.env ?? process.env;
  const rawRepository =
    env.SYNARA_DESKTOP_UPDATE_REPOSITORY?.trim() || env.GITHUB_REPOSITORY?.trim() || "";
  if (!rawRepository) return undefined;

  const [owner, repo, ...rest] = rawRepository.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return { provider: "github", owner, repo, releaseType: "release" };
}

export function createDesktopIdentityBuildConfig(input: {
  readonly identity: SynaraDesktopIdentity;
  readonly signed: boolean;
  readonly disableUpdates: boolean;
}): Record<string, unknown> {
  const publish = resolveDesktopGitHubPublishConfig({ disableUpdates: input.disableUpdates });
  return {
    appId: input.identity.bundleId,
    productName: input.identity.displayName,
    artifactName: `${input.identity.artifactPrefix}-\${version}-\${arch}.\${ext}`,
    directories: {
      buildResources: "apps/desktop/resources",
    },
    forceCodeSigning: input.signed,
    extraResources: [{ from: "LICENSE", to: "LICENSE" }],
    ...(publish ? { publish: [publish] } : {}),
  };
}

export function isProhibitedUpdaterMetadataFile(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  return (
    normalized === "app-update.yml" ||
    normalized === "dev-app-update.yml" ||
    normalized.endsWith(".blockmap") ||
    /^latest(?:-[a-z0-9-]+)?\.ya?ml$/.test(normalized)
  );
}

export function findProhibitedUpdaterMetadataFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && isProhibitedUpdaterMetadataFile(basename(candidate))) {
        matches.push(relative(root, candidate));
      }
    }
  }
  return matches.toSorted((left, right) => left.localeCompare(right));
}
