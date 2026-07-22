import { describe, expect, it } from "vitest";

import {
  classifyCompletedProviderUpdate,
  type CompletedProviderUpdateInput,
} from "./providerUpdateOutcome.ts";

const baseInput: CompletedProviderUpdateInput = {
  provider: "codex",
  configuredBinaryUnavailable: false,
  targetChanged: false,
  beforeVersion: "1.0.0",
  afterVersion: "1.1.0",
  verifiedUpgrade: true,
  stillOutdated: false,
  currentReported: true,
  stillOutdatedVersions: "",
  usesExternalServer: false,
};

describe("classifyCompletedProviderUpdate", () => {
  it("requires a same-target monotonic version increase for success", () => {
    expect(classifyCompletedProviderUpdate(baseInput)).toEqual({
      status: "succeeded",
      message: "Provider CLI update verified.",
    });
    expect(classifyCompletedProviderUpdate({ ...baseInput, targetChanged: true })).toMatchObject({
      status: "unverified",
    });
    expect(classifyCompletedProviderUpdate({ ...baseInput, beforeVersion: null })).toMatchObject({
      status: "unverified",
    });
    expect(
      classifyCompletedProviderUpdate({
        ...baseInput,
        beforeVersion: "1.1.0",
        afterVersion: "1.0.0",
        verifiedUpgrade: false,
      }),
    ).toMatchObject({ status: "unverified" });
  });

  it("distinguishes unchanged and still-outdated commands", () => {
    expect(
      classifyCompletedProviderUpdate({
        ...baseInput,
        afterVersion: "1.0.0",
        verifiedUpgrade: false,
        currentReported: true,
      }),
    ).toMatchObject({ status: "unchanged" });
    expect(
      classifyCompletedProviderUpdate({
        ...baseInput,
        stillOutdated: true,
        stillOutdatedVersions: " (installed 1.1.0, latest 1.2.0)",
      }),
    ).toEqual({
      status: "still_outdated",
      message:
        "Update command completed, but Synara still detects an outdated provider version (installed 1.1.0, latest 1.2.0).",
    });
  });

  it("treats an unavailable configured binary as a command failure", () => {
    expect(
      classifyCompletedProviderUpdate({
        ...baseInput,
        configuredBinaryUnavailable: true,
        configuredBinaryMessage: "binary missing",
      }),
    ).toEqual({
      status: "failed",
      message:
        "Update command completed, but the configured provider binary is unavailable: binary missing",
    });
  });

  it("describes embedded Pi and external-server boundaries after verified upgrades", () => {
    expect(classifyCompletedProviderUpdate({ ...baseInput, provider: "pi" })).toMatchObject({
      status: "succeeded",
      message: expect.stringContaining("bundled Pi runtime is unchanged"),
    });
    expect(
      classifyCompletedProviderUpdate({ ...baseInput, provider: "kilo", usesExternalServer: true }),
    ).toMatchObject({
      status: "succeeded",
      message: expect.stringContaining("external server was unchanged"),
    });
  });
});
