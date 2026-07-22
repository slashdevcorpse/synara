import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  quarantinePlatformForRuntime,
  quarantineTestNamePattern,
  validateQuarantineRegistry,
} from "../../scripts/lib/quarantine-registry";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTRY_PATH = fileURLToPath(new URL("../../.github/quarantine.yml", import.meta.url));

export function browserQuarantineTestNamePattern(mode: "stable" | "quarantine"): RegExp {
  const platform = quarantinePlatformForRuntime(process.platform);
  if (!platform) return mode === "stable" ? /.*/ : /$a/;

  const result = validateQuarantineRegistry(readFileSync(REGISTRY_PATH, "utf8"), {
    repositoryRoot: REPOSITORY_ROOT,
    validateSources: false,
  });
  if (!result.registry || result.errors.length > 0) {
    throw new Error(
      `Browser quarantine registry validation failed:\n- ${result.errors.join("\n- ")}`,
    );
  }
  return quarantineTestNamePattern(result.registry, platform, mode);
}
