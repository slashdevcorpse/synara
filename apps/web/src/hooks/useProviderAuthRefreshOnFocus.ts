// FILE: useProviderAuthRefreshOnFocus.ts
// Purpose: Re-probe provider auth status when the window regains focus/visibility,
//   so account changes made outside the app (e.g. `claude login` / logout / adding
//   an account in a terminal) reflect without restarting the app.
// Layer: Web UI hooks
// Exports: useProviderAuthRefreshOnFocus

import {
  PROVIDER_STATUS_FOREGROUND_REFRESH_MIN_INTERVAL_MS,
  useProviderStatusRefresh,
} from "./useProviderStatusRefresh";

export function useProviderAuthRefreshOnFocus(): void {
  useProviderStatusRefresh({
    minIntervalMs: PROVIDER_STATUS_FOREGROUND_REFRESH_MIN_INTERVAL_MS,
    refreshOnFocus: true,
  });
}
