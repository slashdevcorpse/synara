// FILE: global-setup.ts
// Purpose: Ensures desktop E2E consumes complete prebuilt runtime artifacts.

import * as FS from "node:fs";
import * as Path from "node:path";

const REPO_ROOT = Path.resolve(__dirname, "../../..");

export default function globalSetup(): void {
  const requiredArtifacts = [
    "apps/desktop/dist-electron/main.js",
    "apps/desktop/dist-electron/preload.js",
    "apps/server/dist/index.mjs",
    "apps/web/dist/index.html",
  ];
  const missing = requiredArtifacts.filter(
    (relativePath) => !FS.existsSync(Path.join(REPO_ROOT, relativePath)),
  );
  if (missing.length === 0) return;

  throw new Error(
    [
      "Desktop E2E requires prebuilt desktop, server, and web artifacts.",
      `Missing: ${missing.join(", ")}`,
      "Build them before invoking test:e2e; the E2E command intentionally never rebuilds CI artifacts.",
    ].join(" "),
  );
}
