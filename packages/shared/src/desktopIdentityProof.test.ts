import { describe, expect, it } from "vitest";

import {
  parsePackagedDesktopIdentityProof,
  renderPackagedDesktopIdentityProof,
  type PackagedDesktopIdentityProof,
} from "./desktopIdentityProof";

const proof: PackagedDesktopIdentityProof = {
  flavor: "super",
  appUserModelId: "io.github.slashdevcorpse.supersynara",
  bundleId: "io.github.slashdevcorpse.supersynara",
  internalProtocolScheme: "super-synara",
  internalProtocolRegistered: true,
  userDataDirectoryName: "super-synara",
  userDataPath: "C:\\isolated\\appdata\\super-synara",
  backendHomePath: "C:\\isolated\\super-synara-home",
};

describe("packaged desktop identity proof", () => {
  it("round-trips the stable non-secret startup evidence", () => {
    expect(parsePackagedDesktopIdentityProof(renderPackagedDesktopIdentityProof(proof))).toEqual(
      proof,
    );
  });

  it("rejects incomplete or malformed evidence", () => {
    expect(parsePackagedDesktopIdentityProof("packaged desktop identity proof {}")).toBeNull();
    expect(parsePackagedDesktopIdentityProof("not identity evidence")).toBeNull();
  });
});
