import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  quarantineTestNamePattern,
  validateQuarantineRegistry,
  type QuarantinePlatform,
} from "../../scripts/lib/quarantine-registry";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTRY_PATH = fileURLToPath(new URL("../../.github/quarantine.yml", import.meta.url));

function quarantinePlatform(): QuarantinePlatform | null {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return null;
}

export function browserQuarantineTestNamePattern(mode: "stable" | "quarantine"): RegExp {
  const platform = quarantinePlatform();
  if (!platform) return mode === "stable" ? /.*/ : /$a/;

  const result = validateQuarantineRegistry(readFileSync(REGISTRY_PATH, "utf8"), {
    repositoryRoot: REPOSITORY_ROOT,
  });
  if (!result.registry || result.errors.length > 0) {
    throw new Error(`Browser quarantine registry validation failed:\n- ${result.errors.join("\n- ")}`);
  }
  return quarantineTestNamePattern(result.registry, platform, mode);
}
