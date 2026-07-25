export const ANTIGRAVITY_WINDOWS_COMPATIBILITY_MESSAGE =
  "Antigravity is available on Windows in native compatibility mode. Synara starts each request as a new Antigravity CLI conversation in its default project, captures final response text, and passes a bounded recent Synara transcript as a CLI command-line argument for follow-ups; long history is truncated. That bounded text may be visible to local process-inspection tools while the request runs. Live structured events, usage telemetry, and native resume are unavailable. Synara does not install hooks or read or modify Antigravity configuration or transcript files. Antigravity may retain its normal local conversation records.";

export function isAntigravityWindowsCompatibilityMode(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}
