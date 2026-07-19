import { describe, expect, it } from "vitest";

import {
  type MacSignatureAllowlist,
  type MacUnsignedSignatureReport,
  validateMacUnsignedSignatureReport,
} from "./super-synara-macos-signatures.ts";

const allowlist: MacSignatureAllowlist = {
  schemaVersion: 1,
  electronVersion: "40.10.6",
  productOwnedPaths: ["Contents/MacOS/Super Synara"],
  thirdParty: [
    {
      path: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      identifier: "com.github.Electron.framework",
      teamId: null,
      authorities: [],
      scheme: "ad-hoc-only",
    },
  ],
};

function validReport(): MacUnsignedSignatureReport {
  return {
    schemaVersion: 1,
    appBundle: "Super Synara.app",
    electronVersion: "40.10.6",
    notarizationTicket: "absent",
    notarizationEvidence: {
      command: "xcrun stapler validate",
      exitCode: 65,
      output: "The validate action failed because no ticket was found.",
    },
    productOwned: [
      {
        path: "Contents/MacOS/Super Synara",
        identifier: "io.github.slashdevcorpse.supersynara",
        teamId: null,
        authorities: [],
        cdHash: "a".repeat(40),
        scheme: "ad-hoc-only",
      },
    ],
    thirdParty: [
      {
        path: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
        identifier: "com.github.Electron.framework",
        teamId: null,
        authorities: [],
        cdHash: "b".repeat(40),
        scheme: "ad-hoc-only",
      },
    ],
  };
}

describe("Super Synara macOS signature evidence", () => {
  it("accepts an exact ad-hoc and reviewed-vendor match", () => {
    expect(validateMacUnsignedSignatureReport(validReport(), allowlist)).toEqual(validReport());
  });

  it("rejects Developer ID signing on product-owned binaries", () => {
    const report = validReport();
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          productOwned: [
            {
              ...report.productOwned[0]!,
              scheme: "developer-id",
              teamId: "ABCDE12345",
              authorities: ["Developer ID Application: Unexpected"],
            },
          ],
        },
        allowlist,
      ),
    ).toThrow("unexpectedly has Developer ID signing");
  });

  it("rejects new vendor paths, signature drift, and notarization", () => {
    const report = validReport();
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          thirdParty: [
            ...report.thirdParty,
            {
              ...report.thirdParty[0]!,
              path: "Contents/Frameworks/Unreviewed.framework/Unreviewed",
            },
          ],
        },
        allowlist,
      ),
    ).toThrow("paths differ from the reviewed allowlist");
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          thirdParty: [{ ...report.thirdParty[0]!, identifier: "changed.identifier" }],
        },
        allowlist,
      ),
    ).toThrow("identity changed");
    expect(() =>
      validateMacUnsignedSignatureReport(
        { ...report, notarizationTicket: "present" },
        allowlist,
      ),
    ).toThrow("notarization ticket");
  });
});
