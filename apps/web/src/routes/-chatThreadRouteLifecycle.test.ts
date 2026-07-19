// FILE: -chatThreadRouteLifecycle.test.ts
// Purpose: Guards the missing-thread recovery finalizer against React StrictMode effect replay.
// Layer: Route lifecycle regression test

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ChatThreadRouteView lifecycle", () => {
  it("re-arms the async-finalizer mount guard in effect setup", () => {
    const source = readFileSync(new URL("./_chat.$threadId.tsx", import.meta.url), "utf8");

    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*mountedRef\.current = true;\s*return \(\) => \{\s*mountedRef\.current = false;/,
    );
  });
});
