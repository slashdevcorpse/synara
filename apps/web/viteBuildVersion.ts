// FILE: viteBuildVersion.ts
// Purpose: Resolves the exact version embedded in release web bundles.
// Layer: Web build configuration

export function resolveWebBuildVersion(
  env: NodeJS.ProcessEnv,
  packageVersion: string,
): string {
  return env.SYNARA_WEB_BUILD_VERSION?.trim() || packageVersion;
}
