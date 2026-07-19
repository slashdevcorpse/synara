// FILE: desktop-artifact-policy.ts
// Purpose: Defines identity and updater policy for staged desktop packages.

import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { SynaraDesktopIdentity } from "@synara/shared/desktopIdentity";

export interface DesktopGitHubPublishConfig {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly releaseType: "release";
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
