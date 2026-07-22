import { defineConfig, mergeConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";
import { browserQuarantineTestNamePattern } from "./vitest.browser.quarantine";

export default mergeConfig(
  browserConfig,
  defineConfig({
    test: {
      testNamePattern: browserQuarantineTestNamePattern("quarantine"),
      browser: {
        fileParallelism: false,
      },
    },
  }),
);
