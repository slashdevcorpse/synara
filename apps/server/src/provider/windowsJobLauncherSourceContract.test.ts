import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const launcherSource = readFileSync(
  fileURLToPath(new URL("../../native/windows-job-launcher/launcher.cpp", import.meta.url)),
  "utf8",
);

describe("Windows Job launcher source contract", () => {
  it("only advertises inherited standard handles when the complete set is valid", () => {
    expect(launcherSource).toContain("const bool has_complete_standard_handle_set =");
    expect(launcherSource).toContain("if (has_complete_standard_handle_set) {");
    expect(launcherSource).toContain("startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;");
    expect(launcherSource).not.toContain(
      "startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;",
    );
  });
});
