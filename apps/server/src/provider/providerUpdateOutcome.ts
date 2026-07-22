import type { ProviderKind, ServerProviderUpdateState } from "@synara/contracts";

type CompletedProviderUpdateStatus = Extract<
  ServerProviderUpdateState["status"],
  "failed" | "succeeded" | "still_outdated" | "unchanged" | "unverified"
>;

export interface CompletedProviderUpdateOutcome {
  readonly status: CompletedProviderUpdateStatus;
  readonly message: string;
}

export interface CompletedProviderUpdateInput {
  readonly provider: ProviderKind;
  readonly configuredBinaryUnavailable: boolean;
  readonly configuredBinaryMessage?: string;
  readonly targetChanged: boolean;
  readonly beforeVersion: string | null;
  readonly afterVersion: string | null;
  readonly verifiedUpgrade: boolean;
  readonly stillOutdated: boolean;
  readonly currentReported: boolean;
  readonly stillOutdatedVersions: string;
  readonly usesExternalServer: boolean;
}

/**
 * Classifies only commands that exited successfully. A result is successful
 * only when the same configured target proves a monotonic version increase.
 */
export function classifyCompletedProviderUpdate(
  input: CompletedProviderUpdateInput,
): CompletedProviderUpdateOutcome {
  if (input.configuredBinaryUnavailable) {
    return {
      status: "failed",
      message: `Update command completed, but the configured provider binary is unavailable${input.configuredBinaryMessage ? `: ${input.configuredBinaryMessage}` : "."}`,
    };
  }
  if (input.targetChanged) {
    return {
      status: "unverified",
      message:
        "Update command completed, but the configured provider target changed before verification.",
    };
  }
  if (input.beforeVersion === null || input.afterVersion === null) {
    return {
      status: "unverified",
      message: "Update command completed, but a same-target version change could not be verified.",
    };
  }
  if (input.beforeVersion !== input.afterVersion && !input.verifiedUpgrade) {
    return {
      status: "unverified",
      message: `Update command completed, but the configured provider CLI version changed unexpectedly (${input.beforeVersion} to ${input.afterVersion}).`,
    };
  }
  if (input.stillOutdated) {
    return {
      status: "still_outdated",
      message: `Update command completed, but Synara still detects an outdated provider version${input.stillOutdatedVersions}.`,
    };
  }
  if (!input.verifiedUpgrade) {
    return {
      status: "unchanged",
      message: input.currentReported
        ? "Update command completed, but the configured provider CLI version did not change; the selected channel now reports it current."
        : "Update command completed, but the configured provider CLI version did not change and current status could not be verified.",
    };
  }
  if (input.provider === "pi") {
    return {
      status: "succeeded",
      message: "External Pi CLI updated. Super Synara's bundled Pi runtime is unchanged.",
    };
  }
  if (input.usesExternalServer) {
    return {
      status: "succeeded",
      message: "Local provider CLI updated. The configured external server was unchanged.",
    };
  }
  return { status: "succeeded", message: "Provider CLI update verified." };
}
