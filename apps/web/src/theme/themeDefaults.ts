// FILE: themeDefaults.ts
// Purpose: Resolves the flavor-specific initial theme without overriding saved preferences.
// Layer: Web appearance domain logic

import { SYNARA_SUPER_DESKTOP_SCHEME, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { DEFAULT_THEME_STATE, type ThemeState } from "./theme.logic";

const SUPER_SYNARA_PROTOCOL = `${SYNARA_SUPER_DESKTOP_SCHEME}:`;
const SUPER_SYNARA_DEFAULT_THEME_MODE = synaraDesktopIdentity("super").defaultThemeMode;

export function resolveDefaultThemeState(protocol: string | undefined): ThemeState {
  if (protocol !== SUPER_SYNARA_PROTOCOL) {
    return DEFAULT_THEME_STATE;
  }

  return {
    ...DEFAULT_THEME_STATE,
    mode: SUPER_SYNARA_DEFAULT_THEME_MODE,
  };
}
