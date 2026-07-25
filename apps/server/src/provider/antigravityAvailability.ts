export const ANTIGRAVITY_WINDOWS_COMPATIBILITY_MESSAGE =
  "Antigravity is available on Windows in native compatibility mode. Synara captures final text and replays the bounded Synara transcript for follow-ups. Live structured events, usage telemetry, and native resume are unavailable. Synara does not install hooks or modify Antigravity provider state.";

export function isAntigravityWindowsCompatibilityMode(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}
