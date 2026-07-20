import { describe, expect, it } from "vitest";

import { parseArgs } from "./prepare-super-synara-release.ts";

const commonArguments = [
  "--directory",
  "release-stage",
  "--license",
  "LICENSE",
  "--version",
  "0.5.5-super.1",
  "--tag",
  "super-v0.5.5-super.1",
  "--source-commit",
  "a".repeat(40),
  "--absorbed-upstream-sha",
  "b".repeat(40),
  "--max-total-bytes",
  "1000000",
] as const;

describe("Super Synara release admission CLI", () => {
  it("requires and validates an explicit release scope", () => {
    expect(() => parseArgs(["prepare", ...commonArguments])).toThrow(
      "Missing release admission argument: --release-scope",
    );
    expect(() =>
      parseArgs(["prepare", ...commonArguments, "--release-scope", "unsupported-platform"]),
    ).toThrow("must be windows-only or windows-and-macos");
  });

  it("admits Windows-only arguments without a macOS allowlist", () => {
    const options = parseArgs(["prepare", ...commonArguments, "--release-scope", "windows-only"]);
    expect(options.releaseScope).toBe("windows-only");
    expect(options.macSignatureAllowlistPath).toBeUndefined();
  });

  it("requires a macOS allowlist only for the combined scope", () => {
    expect(() =>
      parseArgs(["prepare", ...commonArguments, "--release-scope", "windows-and-macos"]),
    ).toThrow("requires --mac-signature-allowlist");

    const combined = parseArgs([
      "prepare",
      ...commonArguments,
      "--release-scope",
      "windows-and-macos",
      "--mac-signature-allowlist",
      "scripts/super-synara-macos-signature-allowlist.json",
    ]);
    expect(combined.macSignatureAllowlistPath).toBe(
      "scripts/super-synara-macos-signature-allowlist.json",
    );

    expect(() =>
      parseArgs([
        "prepare",
        ...commonArguments,
        "--release-scope",
        "windows-only",
        "--mac-signature-allowlist",
        "scripts/super-synara-macos-signature-allowlist.json",
      ]),
    ).toThrow("does not accept --mac-signature-allowlist");
  });
});
