// FILE: desktopWindowLifecycle.ts
// Purpose: Defines pure desktop last-window and reopen lifecycle policy.
// Layer: Desktop main-process utility
// Exports: window-all-closed keep-alive policy, reopen decisions, and open-intent policy.

import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";

export interface DesktopWindowAllClosedPolicyInput {
  readonly flavor: SynaraDesktopFlavor;
  readonly platform: NodeJS.Platform;
}

export interface DesktopWindowReopenInput {
  readonly startupBlocked: boolean;
  readonly isQuitting: boolean;
  readonly hasExistingWindow: boolean;
  readonly hasBackendEndpoint: boolean;
}

export type DesktopWindowReopenDecision = "ignore" | "focus" | "defer" | "create";
export type DesktopMainWindowOpenIntent = "open-requested" | "closed";

export function shouldKeepDesktopRuntimeAliveAfterWindowAllClosed(
  input: DesktopWindowAllClosedPolicyInput,
): boolean {
  if (input.platform === "darwin") {
    return true;
  }

  return input.flavor === "super" && (input.platform === "win32" || input.platform === "linux");
}

export function resolveDesktopWindowReopenDecision(
  input: DesktopWindowReopenInput,
): DesktopWindowReopenDecision {
  if (input.startupBlocked || input.isQuitting) {
    return "ignore";
  }
  if (input.hasExistingWindow) {
    return "focus";
  }
  if (!input.hasBackendEndpoint) {
    return "defer";
  }
  return "create";
}

export function shouldOpenDesktopMainWindowAfterBackendLaunch(
  intent: DesktopMainWindowOpenIntent,
): boolean {
  return intent === "open-requested";
}
