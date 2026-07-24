import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { Duration, Effect } from "effect";

import type { ProviderMaintenanceChannelIdentity } from "./providerMaintenance.ts";

export const PROVIDER_UPDATE_POST_PROBE_RETRY_DELAYS_MS = [250, 750, 1_500, 2_500] as const;

export interface ProviderUpdateVerificationSnapshot {
  readonly status: ServerProviderStatus;
  readonly targetChanged: boolean;
}

export function shouldRetryDelayedProviderUpdateVersion(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function mayStillBeReplacing(
  snapshot: ProviderUpdateVerificationSnapshot,
  beforeVersion: string | null,
): boolean {
  return (
    beforeVersion !== null &&
    !snapshot.targetChanged &&
    snapshot.status.available &&
    snapshot.status.version === beforeVersion
  );
}

export function shouldRunWindowsDroidNativeUpdateFinalizer(input: {
  readonly platform: NodeJS.Platform;
  readonly provider: ProviderKind;
  readonly updateChannelKind: ProviderMaintenanceChannelIdentity["kind"];
  readonly beforeVersion: string | null;
  readonly initialSnapshot: ProviderUpdateVerificationSnapshot;
}): boolean {
  return (
    input.platform === "win32" &&
    input.provider === "droid" &&
    input.updateChannelKind === "native-self-update" &&
    mayStillBeReplacing(input.initialSnapshot, input.beforeVersion)
  );
}

/**
 * Gives self-updating CLIs a bounded window to finish replacing their binary
 * after the updater exits. The sleeps suspend only this update fiber and stay
 * interruptible by the enclosing update timeout.
 */
export function verifyDelayedProviderUpdateVersion<
  Snapshot extends ProviderUpdateVerificationSnapshot,
  E,
  R,
>(input: {
  readonly beforeVersion: string | null;
  readonly initialSnapshot: Snapshot;
  readonly probe: Effect.Effect<Snapshot, E, R>;
}): Effect.Effect<Snapshot, E, R> {
  return Effect.gen(function* () {
    let snapshot = input.initialSnapshot;
    for (const delayMs of PROVIDER_UPDATE_POST_PROBE_RETRY_DELAYS_MS) {
      if (!mayStillBeReplacing(snapshot, input.beforeVersion)) {
        break;
      }
      yield* Effect.sleep(Duration.millis(delayMs));
      snapshot = yield* input.probe;
    }
    return snapshot;
  });
}
