// FILE: prepare-effect-language-service.ts
// Purpose: Applies the Effect TypeScript patch once without mutating Bun's package cache.
// Layer: Repository install lifecycle

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareEffectLanguageServiceInstall } from "./lib/effect-language-service-install.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

prepareEffectLanguageServiceInstall(repoRoot);
