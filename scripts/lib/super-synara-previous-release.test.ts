import { describe, expect, it } from "vitest";

import {
  parseSuperSynaraVersion,
  selectPublishedUpstreamSynaraRelease,
  selectPreviousSuperSynaraRelease,
  superSynaraWindowsInstallerName,
} from "./super-synara-previous-release.ts";

function release(
  version: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    draft: false,
    prerelease: true,
    tag_name: `super-v${version}`,
    assets: [{ name: superSynaraWindowsInstallerName(version) }],
    ...overrides,
  };
}

describe("previous Super Synara release selection", () => {
  it("selects the newest older published prerelease from paginated GitHub output", () => {
    expect(
      selectPreviousSuperSynaraRelease(
        [
          [release("0.5.5-super.1"), release("0.5.5-super.3")],
          [release("0.5.5-super.2"), release("0.5.5-super.4")],
        ],
        "0.5.5-super.4",
      ),
    ).toEqual({
      version: "0.5.5-super.3",
      tag: "super-v0.5.5-super.3",
      assetName: "Super-Synara-0.5.5-super.3-windows-x64-unsigned.exe",
    });
  });

  it("ignores drafts, future releases, malformed tags, and incomplete asset sets", () => {
    expect(
      selectPreviousSuperSynaraRelease(
        [
          release("0.5.5-super.1", { draft: true }),
          release("0.5.5-super.2", { assets: [] }),
          release("0.5.5-super.3"),
          release("0.5.5-super.4"),
          release("0.5.5-super.5"),
          { ...release("0.5.5-super.2"), tag_name: "v0.5.5-super.2" },
        ],
        "0.5.5-super.4",
      ),
    ).toEqual({
      version: "0.5.5-super.3",
      tag: "super-v0.5.5-super.3",
      assetName: "Super-Synara-0.5.5-super.3-windows-x64-unsigned.exe",
    });
  });

  it("reports no previous installer instead of inventing an upgrade", () => {
    expect(selectPreviousSuperSynaraRelease([], "0.5.5-super.1")).toBeNull();
  });

  it("rejects non-canonical versions and emits exact installer names", () => {
    expect(parseSuperSynaraVersion("1.2.3-super.9").iteration).toBe(9);
    expect(superSynaraWindowsInstallerName("1.2.3-super.9")).toBe(
      "Super-Synara-1.2.3-super.9-windows-x64-unsigned.exe",
    );
    expect(() => parseSuperSynaraVersion("1.2.3-super.0")).toThrow("Invalid Super Synara version");
  });

  it("selects the exact upstream core release embedded in the Super version", () => {
    expect(
      selectPublishedUpstreamSynaraRelease(
        [
          {
            draft: false,
            prerelease: false,
            tag_name: "v0.5.4",
            assets: [{ name: "Synara-0.5.4-x64.exe" }],
          },
          {
            draft: false,
            prerelease: false,
            tag_name: "v0.5.5",
            assets: [{ name: "Synara-0.5.5-x64.exe" }],
          },
          {
            draft: false,
            prerelease: false,
            tag_name: "v0.6.0",
            assets: [{ name: "Synara-0.6.0-x64.exe" }],
          },
        ],
        "0.5.5-super.7",
      ),
    ).toEqual({ version: "0.5.5", tag: "v0.5.5", assetName: "Synara-0.5.5-x64.exe" });
  });

  it("fails closed when upstream has no exact stable Windows asset", () => {
    expect(() =>
      selectPublishedUpstreamSynaraRelease(
        [{ draft: false, prerelease: false, tag_name: "v0.5.5", assets: [] }],
        "0.5.5-super.1",
      ),
    ).toThrow("Expected one published upstream Synara v0.5.5 release");
  });
});
