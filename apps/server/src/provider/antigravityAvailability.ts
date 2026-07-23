export const ANTIGRAVITY_WINDOWS_UNAVAILABLE_MESSAGE =
  "Antigravity is unavailable on Windows because Synara's current capture integration requires a persistent provider plugin and a cmd.exe hook. Synara will not install or launch that integration on Windows.";

export function isAntigravityAvailableOnPlatform(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}
