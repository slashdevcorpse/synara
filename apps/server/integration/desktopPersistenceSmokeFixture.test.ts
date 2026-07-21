// FILE: desktopPersistenceSmokeFixture.test.ts
// Purpose: Verifies the offline seed/arm/assert lifecycle against a real temporary SQLite database.
// Layer: Focused integration test using the production provider-session directory.
// Depends on: The desktop persistence fixture and real file-backed SQLite repositories.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { deriveServerPaths } from "../src/config.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../src/provider/Services/ProviderSessionDirectory.ts";
import {
  DESKTOP_PERSISTENCE_SMOKE_ACTIVE_TURN_ID,
  DESKTOP_PERSISTENCE_SMOKE_ARM_EVENT,
  DESKTOP_PERSISTENCE_SMOKE_ARM_MARKER,
  DESKTOP_PERSISTENCE_SMOKE_THREAD_ID,
  assertDesktopPersistenceSmokeFixture,
  seedDesktopPersistenceSmokeFixture,
} from "./desktopPersistenceSmokeFixture.ts";

const FIXTURE_CLI_PATH = Path.join(import.meta.dirname, "desktopPersistenceSmokeFixture.ts");

async function openProviderDirectory(synaraHome: string) {
  const { dbPath } = await Effect.runPromise(
    deriveServerPaths(synaraHome, undefined).pipe(Effect.provide(NodeServices.layer)),
  );
  const layer = ProviderSessionDirectoryLive.pipe(
    Layer.provideMerge(ProviderSessionRuntimeRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const directory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));
  return { directory, runtime };
}

function runFixtureCli(mode: "arm", synaraHome: string) {
  return spawnSync("bun", ["run", FIXTURE_CLI_PATH, mode, "--home-dir", synaraHome], {
    cwd: Path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function persistCrashRecoveryOutcome(
  synaraHome: string,
  options: {
    readonly includeArmMarker?: boolean;
    readonly lastRuntimeEventAt?: string;
  } = {},
): Promise<void> {
  const { directory, runtime } = await openProviderDirectory(synaraHome);
  try {
    const bindingOption = await runtime.runPromise(
      directory.getBinding(DESKTOP_PERSISTENCE_SMOKE_THREAD_ID),
    );
    assert(Option.isSome(bindingOption), "seeded binding must exist before recovery");
    const binding = bindingOption.value;
    const runtimePayload =
      binding.runtimePayload !== null && typeof binding.runtimePayload === "object"
        ? binding.runtimePayload
        : {};
    await runtime.runPromise(
      directory.upsert({
        ...binding,
        status: "stopped",
        runtimePayload: {
          ...runtimePayload,
          activeTurnId: null,
          lastRuntimeEvent: "provider.startupCrashRecovery",
          lastRuntimeEventAt: options.lastRuntimeEventAt ?? "2026-07-20T12:01:00.000Z",
          ...(options.includeArmMarker
            ? { desktopPersistenceSmokeArm: DESKTOP_PERSISTENCE_SMOKE_ARM_MARKER }
            : {}),
        },
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

describe("desktop persistence smoke fixture", () => {
  it("requires an explicit absolute caller-owned home", async () => {
    await expect(seedDesktopPersistenceSmokeFixture("relative-home")).rejects.toThrow(
      "--home-dir must be absolute",
    );
  });

  it("requires a live external desktop database owner before arm", async () => {
    const synaraHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-desktop-arm-lock-"));
    try {
      await seedDesktopPersistenceSmokeFixture(synaraHome);
      await persistCrashRecoveryOutcome(synaraHome);

      const armResult = runFixtureCli("arm", synaraHome);
      expect(armResult.status).toBe(1);
      expect(armResult.stderr).toContain(
        "arm requires launch A to be running and holding the desktop database lifecycle lock",
      );
    } finally {
      FS.rmSync(synaraHome, { recursive: true, force: true });
    }
  });

  it("rejects a parseable but non-ISO crash-recovery timestamp", async () => {
    const synaraHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-desktop-timestamp-"));
    const nonIsoTimestamp = new Date("2026-07-20T12:01:00.000Z").toUTCString();
    try {
      expect(Number.isNaN(Date.parse(nonIsoTimestamp))).toBe(false);
      await seedDesktopPersistenceSmokeFixture(synaraHome);
      await persistCrashRecoveryOutcome(synaraHome, {
        includeArmMarker: true,
        lastRuntimeEventAt: nonIsoTimestamp,
      });

      await expect(assertDesktopPersistenceSmokeFixture(synaraHome)).rejects.toThrow(
        "provider startup crash-recovery timestamp must be an ISO date-time",
      );
    } finally {
      FS.rmSync(synaraHome, { recursive: true, force: true });
    }
  });

  it("proves seed -> launch-A arm -> launch-B crash recovery -> assert", async () => {
    const synaraHome = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-desktop-persistence-"));
    try {
      await seedDesktopPersistenceSmokeFixture(synaraHome);
      await persistCrashRecoveryOutcome(synaraHome);

      const launchA = await openProviderDirectory(synaraHome);
      try {
        await expect(assertDesktopPersistenceSmokeFixture(synaraHome)).rejects.toThrow(
          "Database lifecycle is locked",
        );

        const armResult = runFixtureCli("arm", synaraHome);
        expect(armResult.error).toBeUndefined();
        expect(armResult.status).toBe(0);
        expect(armResult.stdout).toContain("desktop persistence smoke fixture: arm passed");

        const armedBindingOption = await launchA.runtime.runPromise(
          launchA.directory.getBinding(DESKTOP_PERSISTENCE_SMOKE_THREAD_ID),
        );
        assert(Option.isSome(armedBindingOption), "armed binding must remain readable");
        const armedBinding = armedBindingOption.value;
        const armedPayload = armedBinding.runtimePayload as Record<string, unknown>;
        expect(armedBinding.status).toBe("running");
        expect(armedPayload.activeTurnId).toBe(DESKTOP_PERSISTENCE_SMOKE_ACTIVE_TURN_ID);
        expect(armedPayload.desktopPersistenceSmokeArm).toEqual(
          DESKTOP_PERSISTENCE_SMOKE_ARM_MARKER,
        );
        expect(armedPayload.lastRuntimeEvent).toBe(DESKTOP_PERSISTENCE_SMOKE_ARM_EVENT);
      } finally {
        await launchA.runtime.dispose();
      }

      await persistCrashRecoveryOutcome(synaraHome);
      const result = await assertDesktopPersistenceSmokeFixture(synaraHome);
      expect(Path.relative(result.synaraHome, result.dbPath)).toBe(
        Path.join("userdata", "state.sqlite"),
      );
      expect(Path.relative(result.synaraHome, result.workspaceDir)).toBe(
        "desktop-persistence-smoke-workspace",
      );
    } finally {
      FS.rmSync(synaraHome, { recursive: true, force: true });
    }
  });
});
