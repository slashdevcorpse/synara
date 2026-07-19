import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectMacSignatureCandidatePaths,
  classifyMacSignatureCandidateFileDescription,
  classifyMacNotarizationTicket,
  hasExplicitMissingNotarizationTicketEvidence,
  type MacSignatureAuditInventory,
  type MacSignatureAllowlist,
  type MacSignatureIdentity,
  type MacUnsignedSignatureReport,
  validateMacSignatureAllowlist,
  validateMacSignatureAuditInventory,
  validateMacUnsignedSignatureReport,
} from "./super-synara-macos-signatures.ts";

const allowlist: MacSignatureAllowlist = {
  schemaVersion: 1,
  electronVersion: "40.10.6",
  productOwnedPaths: [".", "Contents/MacOS/Super Synara", "Contents/Helpers/synara-appsnap-helper"],
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

function missingTicketEvidence(name: string) {
  return {
    command: "xcrun stapler validate" as const,
    exitCode: 65,
    output: [
      `CloudKit query for ${name} (2/abc) failed due to "Record not found".`,
      "Could not find base64 encoded ticket in response for 2/abc",
      "The staple and validate action failed! Error 65.",
    ].join("\n"),
  };
}

function replaceIdentity(
  identities: ReadonlyArray<MacSignatureIdentity>,
  path: string,
  replace: (identity: MacSignatureIdentity) => MacSignatureIdentity,
): ReadonlyArray<MacSignatureIdentity> {
  const index = identities.findIndex((identity) => identity.path === path);
  if (index === -1) throw new Error(`Missing test signature identity: ${path}.`);
  return identities.with(index, replace(identities[index]!));
}

function validReport(): MacUnsignedSignatureReport {
  return {
    schemaVersion: 2,
    diskImage: {
      fileName: "Super-Synara-0.5.5-super.1-macos-arm64-unsigned.dmg",
      size: 123,
      sha256: "9".repeat(64),
      codeSignature: {
        command: "codesign -d --verbose=4",
        exitCode: 1,
        output: "code object is not signed at all",
        status: "unsigned",
        teamId: null,
        authorities: [],
        cdHash: null,
        signature: null,
      },
    },
    appBundle: "Super Synara.app",
    electronVersion: "40.10.6",
    deepVerification: {
      command: "codesign --verify --deep --strict --verbose=4",
      exitCode: 0,
      output: "valid on disk\nsatisfies its Designated Requirement",
    },
    notarization: {
      diskImage: {
        ticket: "absent",
        evidence: missingTicketEvidence("Super Synara.dmg"),
      },
      appBundle: {
        ticket: "absent",
        evidence: missingTicketEvidence("Super Synara.app"),
      },
    },
    productOwned: [
      {
        path: ".",
        identifier: "io.github.slashdevcorpse.supersynara",
        teamId: null,
        authorities: [],
        cdHash: "c".repeat(40),
        signature: "adhoc",
        scheme: "ad-hoc-only",
      },
      {
        path: "Contents/MacOS/Super Synara",
        identifier: "io.github.slashdevcorpse.supersynara",
        teamId: null,
        authorities: [],
        cdHash: "a".repeat(40),
        signature: "adhoc",
        scheme: "ad-hoc-only",
      },
      {
        path: "Contents/Helpers/synara-appsnap-helper",
        identifier: "synara-appsnap-helper",
        teamId: null,
        authorities: [],
        cdHash: "d".repeat(40),
        signature: "adhoc",
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
        signature: "adhoc",
        scheme: "ad-hoc-only",
      },
    ],
  };
}

describe("Super Synara macOS signature evidence", () => {
  it("keeps audit inventories unclassified and separate from admission reports", () => {
    const report = validReport();
    const inventory: MacSignatureAuditInventory = {
      schemaVersion: 2,
      kind: "macos-signature-audit-inventory",
      diskImage: report.diskImage,
      appBundle: report.appBundle,
      electronVersion: report.electronVersion,
      deepVerification: {
        command: "codesign --verify --deep --strict --verbose=4",
        exitCode: 1,
        output: "review needed",
      },
      notarization: report.notarization,
      codeObjects: [...report.productOwned, ...report.thirdParty],
    };
    expect(validateMacSignatureAuditInventory(inventory)).toEqual(inventory);

    for (const output of [
      "Could not establish secure connection to api.apple-cloudkit.com NSURLErrorDomain",
      "Could not validate ticket for /tmp/Super Synara.app",
    ]) {
      const evidence = {
        command: "xcrun stapler validate" as const,
        exitCode: 65,
        output,
      };
      expect(classifyMacNotarizationTicket(evidence)).toBe("indeterminate");
      const indeterminateInventory: MacSignatureAuditInventory = {
        ...inventory,
        notarization: {
          ...inventory.notarization,
          appBundle: { ticket: "indeterminate", evidence },
        },
      };
      expect(validateMacSignatureAuditInventory(indeterminateInventory)).toEqual(
        indeterminateInventory,
      );
      expect(() =>
        validateMacSignatureAuditInventory({
          ...indeterminateInventory,
          notarization: {
            ...indeterminateInventory.notarization,
            appBundle: { ticket: "absent", evidence },
          },
        }),
      ).toThrow("misclassifies notarization ticket evidence");
    }
  });

  it("rejects an empty placeholder allowlist", () => {
    expect(() =>
      validateMacSignatureAllowlist({
        schemaVersion: 1,
        electronVersion: "40.10.6",
        productOwnedPaths: [],
        thirdParty: [],
      }),
    ).toThrow("reviewed product-owned and third-party paths");
  });

  it("hard-pins first-party paths and the Super main bundle identifier", () => {
    const report = validReport();
    expect(() =>
      validateMacSignatureAllowlist({
        ...allowlist,
        productOwnedPaths: allowlist.productOwnedPaths.filter((path) => path !== "."),
        thirdParty: [
          ...allowlist.thirdParty,
          {
            path: ".",
            identifier: "io.github.slashdevcorpse.supersynara",
            teamId: null,
            authorities: [],
            scheme: "ad-hoc-only",
          },
        ],
      }),
    ).toThrow("must not be classified as third-party");
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          productOwned: replaceIdentity(report.productOwned, ".", (identity) => ({
            ...identity,
            identifier: "com.example.drift",
          })),
        },
        allowlist,
      ),
    ).toThrow("Product-owned main bundle identifier");
    expect(() =>
      validateMacSignatureAllowlist({
        ...allowlist,
        thirdParty: [
          ...allowlist.thirdParty,
          {
            path: "Contents/Frameworks/Super Synara Helper (Renderer).app",
            identifier: "io.github.slashdevcorpse.supersynara.helper.renderer",
            teamId: "ABCDE12345",
            authorities: ["Developer ID Application: Unexpected"],
            scheme: "developer-id",
          },
        ],
      }),
    ).toThrow("must not be classified as third-party");
  });

  it("accepts only the reviewed explicit missing-ticket diagnostic", () => {
    expect(
      hasExplicitMissingNotarizationTicketEvidence(validReport().notarization.appBundle.evidence),
    ).toBe(true);
    for (const output of [
      "Could not establish secure connection to api.apple-cloudkit.com",
      "Could not validate ticket for /tmp/Super Synara.app",
      'CloudKit query for Super Synara.app (2/abc) failed due to "Record not found".\nCould not find base64 encoded ticket in response for 2/abc\nNSURLErrorDomain timed out',
      "CloudKit response was corrupt",
      "",
    ]) {
      expect(
        hasExplicitMissingNotarizationTicketEvidence({
          command: "xcrun stapler validate",
          exitCode: 65,
          output,
        }),
      ).toBe(false);
      expect(() =>
        validateMacUnsignedSignatureReport(
          {
            ...validReport(),
            notarization: {
              ...validReport().notarization,
              appBundle: {
                ticket: "absent",
                evidence: {
                  command: "xcrun stapler validate",
                  exitCode: 65,
                  output,
                },
              },
            },
          },
          allowlist,
        ),
      ).toThrow("notarization-ticket absence evidence");
    }
  });

  it("accepts an exact ad-hoc and reviewed-vendor match", () => {
    expect(validateMacUnsignedSignatureReport(validReport(), allowlist)).toEqual(validReport());
  });

  it("rejects Developer ID or ambiguous codesign evidence on the outer DMG", () => {
    const report = validReport();
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          diskImage: {
            ...report.diskImage,
            codeSignature: {
              command: "codesign -d --verbose=4",
              exitCode: 0,
              output: "TeamIdentifier=ABCDE12345\nAuthority=Developer ID Application: Unexpected",
              status: "developer-id",
              teamId: "ABCDE12345",
              authorities: ["Developer ID Application: Unexpected"],
              cdHash: "7".repeat(40),
              signature: null,
            },
          },
        },
        allowlist,
      ),
    ).toThrow("must be unsigned or purely ad-hoc signed");
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          diskImage: {
            ...report.diskImage,
            codeSignature: {
              ...report.diskImage.codeSignature,
              output: "codesign tool failure",
              status: "indeterminate",
            },
          },
        },
        allowlist,
      ),
    ).toThrow("must be unsigned or purely ad-hoc signed");
  });

  it("rejects ambiguous successful codesign output without explicit ad-hoc evidence", () => {
    const report = validReport();
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          diskImage: {
            ...report.diskImage,
            codeSignature: {
              command: "codesign -d --verbose=4",
              exitCode: 0,
              output: `Identifier=Super-Synara\nCDHash=${"7".repeat(40)}`,
              status: "ad-hoc-only",
              teamId: null,
              authorities: [],
              cdHash: "7".repeat(40),
              signature: null,
            },
          },
        },
        allowlist,
      ),
    ).toThrow("incomplete ad-hoc codesign evidence");
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          productOwned: replaceIdentity(report.productOwned, ".", (identity) => ({
            ...identity,
            signature: null,
          })),
        },
        allowlist,
      ),
    ).toThrow("lacks explicit purely ad-hoc signature evidence");
  });

  it("rejects nonzero strict deep-verification evidence for admission", () => {
    const report = validReport();
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          deepVerification: {
            ...report.deepVerification,
            exitCode: 1,
            output: "a sealed resource is missing or invalid",
          },
        },
        allowlist,
      ),
    ).toThrow("successful strict deep verification evidence");
  });

  it("inventories nested signed bundle containers and locks their reviewed classification", () => {
    const root = mkdtempSync(join(tmpdir(), "super-synara-signature-candidates-"));
    try {
      const helperBundle = join(root, "Contents", "Frameworks", "Electron Helper.app");
      const helperBinary = join(helperBundle, "Contents", "MacOS", "helper.node");
      mkdirSync(join(helperBundle, "Contents", "MacOS"), { recursive: true });
      writeFileSync(helperBinary, "native fixture");
      expect(
        collectMacSignatureCandidatePaths(root).map((path) =>
          relative(root, path).replaceAll("\\", "/"),
        ),
      ).toEqual([
        "Contents/Frameworks/Electron Helper.app",
        "Contents/Frameworks/Electron Helper.app/Contents/MacOS/helper.node",
      ]);
      expect(classifyMacSignatureCandidateFileDescription("Mach-O 64-bit executable arm64")).toBe(
        "mach-o",
      );
      expect(
        classifyMacSignatureCandidateFileDescription("POSIX shell script text executable"),
      ).toBe("script");
      expect(() =>
        classifyMacSignatureCandidateFileDescription(
          "PE32+ executable (DLL) (GUI) Aarch64, for MS Windows, 7 sections",
          "Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-win32-arm64/lib/sharp-win32-arm64.node",
        ),
      ).toThrow(
        "Executable candidate Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-win32-arm64/lib/sharp-win32-arm64.node has unsupported native file type: PE32+ executable (DLL) (GUI) Aarch64, for MS Windows, 7 sections.",
      );
      expect(() =>
        classifyMacSignatureCandidateFileDescription(
          "ELF 64-bit LSB shared object, x86-64",
          "Contents/Resources/app.asar.unpacked/node_modules/example/native.node",
        ),
      ).toThrow("Contents/Resources/app.asar.unpacked/node_modules/example/native.node");
      expect(() => classifyMacSignatureCandidateFileDescription("data")).toThrow(
        "unsupported native file type",
      );

      const helperExpectation = {
        path: "Contents/Frameworks/Electron Helper.app",
        identifier: "com.github.Electron.helper",
        teamId: null,
        authorities: [],
        scheme: "ad-hoc-only" as const,
      };
      const extendedAllowlist: MacSignatureAllowlist = {
        ...allowlist,
        thirdParty: [...allowlist.thirdParty, helperExpectation],
      };
      const report = validReport();
      const helperIdentity = {
        ...helperExpectation,
        cdHash: "8".repeat(40),
        signature: "adhoc" as const,
      };
      const extendedReport: MacUnsignedSignatureReport = {
        ...report,
        thirdParty: [...report.thirdParty, helperIdentity],
      };
      expect(validateMacUnsignedSignatureReport(extendedReport, extendedAllowlist)).toEqual(
        extendedReport,
      );
      expect(() => validateMacUnsignedSignatureReport(report, extendedAllowlist)).toThrow(
        "paths differ from the reviewed allowlist",
      );
      expect(() =>
        validateMacUnsignedSignatureReport(
          {
            ...extendedReport,
            thirdParty: replaceIdentity(
              extendedReport.thirdParty,
              helperExpectation.path,
              (identity) => ({ ...identity, identifier: "com.example.changed" }),
            ),
          },
          extendedAllowlist,
        ),
      ).toThrow("identity changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Developer ID signing on product-owned binaries", () => {
    const report = validReport();
    expect(() =>
      validateMacUnsignedSignatureReport(
        {
          ...report,
          productOwned: replaceIdentity(report.productOwned, ".", (identity) => ({
            ...identity,
            scheme: "developer-id" as const,
            teamId: "ABCDE12345",
            authorities: ["Developer ID Application: Unexpected"],
            signature: null,
          })),
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
        {
          ...report,
          notarization: {
            ...report.notarization,
            diskImage: { ...report.notarization.diskImage, ticket: "present" },
          },
        },
        allowlist,
      ),
    ).toThrow("notarization ticket");
  });
});
