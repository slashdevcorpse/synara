// FILE: desktop-build-options.ts
// Purpose: Defines shared desktop artifact build option values and types.
// Layer: Release/build helper

export const DESKTOP_BUILD_ARCHES = ["arm64", "x64", "universal"] as const;
export type DesktopBuildArch = (typeof DESKTOP_BUILD_ARCHES)[number];
