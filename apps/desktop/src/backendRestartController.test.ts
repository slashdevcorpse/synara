import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKEND_RESTART_POLICY,
  BackendRestartController,
  type BackendRestartAdmission,
  type BackendRestartGeneration,
  type BackendRestartRequest,
} from "./backendRestartController";

const desktopMainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function expectAdmitted(admission: BackendRestartAdmission): BackendRestartGeneration {
  expect(admission.type).toBe("admitted");
  if (admission.type !== "admitted") {
    throw new Error(`Expected admission, received ${admission.reason}.`);
  }
  return admission.generation;
}

// Fake time keeps every signed admission, cooldown, and stability boundary deterministic.
describe("BackendRestartController", () => {
  let restartRequests: BackendRestartRequest[];
  let stableGenerations: BackendRestartGeneration[];
  let controller: BackendRestartController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    restartRequests = [];
    stableGenerations = [];
    controller = new BackendRestartController({
      onRestartDue: (request) => restartRequests.push(request),
      onGenerationStable: (generation) => stableGenerations.push(generation),
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  function admit(reason = "automatic start"): BackendRestartGeneration {
    return expectAdmitted(controller.admitAutomatic(reason));
  }

  function takeRestartRequest(): BackendRestartRequest {
    const request = restartRequests.shift();
    expect(request).toBeDefined();
    if (!request) throw new Error("Expected a restart request.");
    return request;
  }

  it("publishes the exact signed finite policy", () => {
    expect(BACKEND_RESTART_POLICY).toEqual({
      stableUptimeMs: 60_000,
      failureWindowMs: 300_000,
      failureThreshold: 5,
      lifetimeAdmissionLimit: 6,
      cooldownMs: 60_000,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
    });
  });

  it("issues immutable generation identities and consumes admission immediately", () => {
    const generation = admit("bootstrap");

    expect(Object.isFrozen(generation)).toBe(true);
    expect(generation).toMatchObject({
      id: 1,
      kind: "closed",
      admittedAtMs: Date.now(),
      reason: "bootstrap",
    });
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "closed",
      lifetimeAdmissions: 1,
      activeGenerationId: 1,
      activeGenerationPhase: "starting",
    });
    expect(controller.admitAutomatic("duplicate")).toEqual({
      type: "denied",
      reason: "generation-active",
    });
  });

  it("does not reset failure history until current-generation readiness stays stable for 60 seconds", () => {
    const first = admit();
    expect(controller.recordFailure(first, "first failure")).toEqual({
      type: "restart-scheduled",
      delayMs: 500,
    });

    vi.advanceTimersByTime(500);
    const second = takeRestartRequest().generation;
    expect(controller.markStartupReady(second)).toBe(true);

    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.stableUptimeMs - 1);
    expect(controller.getSnapshot()).toMatchObject({
      activeGenerationId: second.id,
      activeGenerationPhase: "ready",
      recentFailures: 1,
      restartAttempt: 1,
    });
    expect(stableGenerations).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(controller.getSnapshot()).toMatchObject({
      activeGenerationId: second.id,
      activeGenerationPhase: "stable",
      recentFailures: 0,
      restartAttempt: 0,
    });
    expect(stableGenerations).toEqual([second]);

    expect(controller.recordFailure(second, "later unrelated failure")).toEqual({
      type: "restart-scheduled",
      delayMs: 500,
    });
  });

  it("treats readiness, failure, and duplicate events from stale generations as no-ops", () => {
    const first = admit();
    expect(controller.recordFailure(first, "first failure").type).toBe("restart-scheduled");
    expect(controller.recordFailure(first, "duplicate exit")).toEqual({ type: "ignored" });

    vi.advanceTimersByTime(500);
    const second = takeRestartRequest().generation;

    expect(controller.markStartupReady(first)).toBe(false);
    expect(controller.recordFailure(first, "stale error")).toEqual({ type: "ignored" });
    expect(controller.markStartupReady(second)).toBe(true);
    expect(controller.markStartupReady(second)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      activeGenerationId: second.id,
      activeGenerationPhase: "ready",
      lifetimeAdmissions: 2,
      pendingTimer: "stability",
    });
  });

  it("cancels the stability reset when the generation exits during the stable-uptime interval", () => {
    const generation = admit();
    expect(controller.markStartupReady(generation)).toBe(true);
    vi.advanceTimersByTime(59_999);

    expect(controller.recordFailure(generation, "exit during stability")).toEqual({
      type: "restart-scheduled",
      delayMs: 500,
    });
    vi.advanceTimersByTime(1);
    expect(stableGenerations).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      activeGenerationId: null,
      recentFailures: 1,
      restartAttempt: 1,
      pendingTimer: "restart",
    });
  });

  it("preserves the 500 ms exponential schedule within the 10 second cap", () => {
    let generation = admit();
    const expectedDelays = [500, 1_000, 2_000, 4_000, 8_000];

    for (const delayMs of expectedDelays) {
      expect(controller.recordFailure(generation, `failure before ${delayMs}`)).toEqual({
        type: "restart-scheduled",
        delayMs,
      });
      vi.advanceTimersByTime(delayMs);
      generation = takeRestartRequest().generation;
      vi.advanceTimersByTime(BACKEND_RESTART_POLICY.failureWindowMs + 1);
    }

    expect(controller.getSnapshot()).toMatchObject({
      lifetimeAdmissions: 6,
      restartAttempt: expectedDelays.length,
      recentFailures: 0,
    });
    expect(Math.max(...expectedDelays)).toBeLessThanOrEqual(BACKEND_RESTART_POLICY.maxDelayMs);
  });

  it("opens after five failures in five minutes and admits exactly one half-open probe", () => {
    let generation = admit();
    const closedDelays = [500, 1_000, 2_000, 4_000];

    for (const delayMs of closedDelays) {
      expect(controller.recordFailure(generation, `rapid failure ${delayMs}`).type).toBe(
        "restart-scheduled",
      );
      vi.advanceTimersByTime(delayMs);
      generation = takeRestartRequest().generation;
    }

    expect(controller.recordFailure(generation, "fifth rapid failure")).toEqual({
      type: "circuit-open",
      cooldownMs: 60_000,
    });
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "open",
      lifetimeAdmissions: 5,
      recentFailures: 5,
      pendingTimer: "cooldown",
    });
    expect(controller.admitAutomatic("bypass open circuit")).toEqual({
      type: "denied",
      reason: "circuit-open",
    });

    vi.advanceTimersByTime(59_999);
    expect(restartRequests).toEqual([]);
    vi.advanceTimersByTime(1);

    const halfOpen = takeRestartRequest().generation;
    expect(halfOpen.kind).toBe("half-open");
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "half-open",
      lifetimeAdmissions: 6,
      activeGenerationId: halfOpen.id,
      pendingTimer: null,
    });
    expect(controller.admitAutomatic("second probe")).toEqual({
      type: "denied",
      reason: "half-open-active",
    });
  });

  it("latches after a failed half-open probe and never schedules another cooldown", () => {
    let generation = admit();
    for (const delayMs of [500, 1_000, 2_000, 4_000]) {
      controller.recordFailure(generation, "rapid failure");
      vi.advanceTimersByTime(delayMs);
      generation = takeRestartRequest().generation;
    }
    controller.recordFailure(generation, "open circuit");
    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.cooldownMs);
    const halfOpen = takeRestartRequest().generation;

    expect(controller.recordFailure(halfOpen, "half-open failed")).toEqual({
      type: "latched",
      reason: "half-open-failed",
    });
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "latched",
      activeGenerationId: null,
      pendingTimer: null,
    });
    vi.advanceTimersByTime(10 * BACKEND_RESTART_POLICY.cooldownMs);
    expect(restartRequests).toEqual([]);
    expect(controller.admitAutomatic("latched retry")).toEqual({
      type: "denied",
      reason: "latched",
    });
  });

  it("closes after a stable half-open probe without replenishing lifetime admissions", () => {
    let generation = admit();
    for (const delayMs of [500, 1_000, 2_000, 4_000]) {
      controller.recordFailure(generation, "rapid failure");
      vi.advanceTimersByTime(delayMs);
      generation = takeRestartRequest().generation;
    }
    controller.recordFailure(generation, "open circuit");
    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.cooldownMs);
    const halfOpen = takeRestartRequest().generation;

    expect(controller.markStartupReady(halfOpen)).toBe(true);
    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.stableUptimeMs);
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "closed",
      lifetimeAdmissions: 6,
      recentFailures: 0,
      restartAttempt: 0,
      activeGenerationPhase: "stable",
    });

    expect(controller.recordFailure(halfOpen, "failure after stable recovery")).toEqual({
      type: "latched",
      reason: "lifetime-exhausted",
    });
    expect(controller.getSnapshot().circuitState).toBe("latched");
  });

  it("latches when the sixth lifetime admission fails even if failures are outside the window", () => {
    let generation = admit();

    for (const delayMs of [500, 1_000, 2_000, 4_000, 8_000]) {
      vi.advanceTimersByTime(BACKEND_RESTART_POLICY.failureWindowMs + 1);
      expect(controller.recordFailure(generation, "isolated failure")).toEqual({
        type: "restart-scheduled",
        delayMs,
      });
      vi.advanceTimersByTime(delayMs);
      generation = takeRestartRequest().generation;
    }

    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.failureWindowMs + 1);
    expect(controller.recordFailure(generation, "sixth lifetime failure")).toEqual({
      type: "latched",
      reason: "lifetime-exhausted",
    });
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "latched",
      lifetimeAdmissions: 6,
      pendingTimer: null,
    });
    vi.advanceTimersByTime(600_000);
    expect(restartRequests).toEqual([]);
  });

  it("denies an immediate admission while a backoff restart is already scheduled", () => {
    const generation = admit();
    controller.recordFailure(generation, "schedule retry");

    expect(controller.admitAutomatic("bypass timer")).toEqual({
      type: "denied",
      reason: "restart-scheduled",
    });
    vi.advanceTimersByTime(500);
    expect(restartRequests).toHaveLength(1);
  });

  it.each(["Windows timed-out shutdown", "POSIX exit deadline"])(
    "retains ownership after %s and records exactly one failure only on later exit",
    (shutdownDisposition) => {
      const generation = admit("readiness probe");

      // An unconfirmed shutdown disposition must not be translated into a
      // controller failure: the still-owned generation remains the admission lock.
      vi.advanceTimersByTime(10_000);
      expect(controller.getSnapshot()).toMatchObject({
        activeGenerationId: generation.id,
        activeGenerationPhase: "starting",
        recentFailures: 0,
        pendingTimer: null,
      });
      expect(restartRequests).toEqual([]);
      expect(controller.admitAutomatic("update recovery")).toEqual({
        type: "denied",
        reason: "generation-active",
      });

      expect(
        controller.recordFailure(generation, `late exit after ${shutdownDisposition}`),
      ).toEqual({
        type: "restart-scheduled",
        delayMs: 500,
      });
      expect(controller.recordFailure(generation, "duplicate exit")).toEqual({ type: "ignored" });
      expect(controller.getSnapshot()).toMatchObject({
        activeGenerationId: null,
        recentFailures: 1,
        restartAttempt: 1,
        pendingTimer: "restart",
      });

      vi.advanceTimersByTime(499);
      expect(restartRequests).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(restartRequests).toHaveLength(1);
      expect(restartRequests[0]?.generation.id).toBe(2);
    },
  );

  it("retires an intentional generation without recording failure or firing its stability timer", () => {
    const first = admit();
    controller.markStartupReady(first);

    expect(controller.retireGeneration(first)).toBe(true);
    expect(controller.retireGeneration(first)).toBe(false);
    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.stableUptimeMs);
    expect(stableGenerations).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "closed",
      lifetimeAdmissions: 1,
      recentFailures: 0,
      activeGenerationId: null,
      pendingTimer: null,
    });

    const second = admit("updater recovery");
    expect(second.id).toBe(2);
    expect(controller.getSnapshot().lifetimeAdmissions).toBe(2);
  });

  it("disposes every timer and rejects all later lifecycle events", () => {
    const generation = admit();
    controller.markStartupReady(generation);
    controller.dispose();

    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.stableUptimeMs);
    expect(stableGenerations).toEqual([]);
    expect(restartRequests).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      circuitState: "disposed",
      activeGenerationId: null,
      pendingTimer: null,
    });
    expect(controller.markStartupReady(generation)).toBe(false);
    expect(controller.recordFailure(generation, "late exit")).toEqual({ type: "ignored" });
    expect(controller.admitAutomatic("late restart")).toEqual({
      type: "denied",
      reason: "disposed",
    });
  });

  it("cancels a pending restart and an open-circuit cooldown on quit", () => {
    const restartController = new BackendRestartController({
      onRestartDue: (request) => restartRequests.push(request),
    });
    const first = expectAdmitted(restartController.admitAutomatic("bootstrap"));
    restartController.recordFailure(first, "failure");
    restartController.dispose();
    vi.advanceTimersByTime(500);
    expect(restartRequests).toEqual([]);

    const cooldownController = new BackendRestartController({
      onRestartDue: (request) => restartRequests.push(request),
    });
    let generation = expectAdmitted(cooldownController.admitAutomatic("bootstrap"));
    for (const delayMs of [500, 1_000, 2_000, 4_000]) {
      cooldownController.recordFailure(generation, "rapid failure");
      vi.advanceTimersByTime(delayMs);
      generation = takeRestartRequest().generation;
    }
    cooldownController.recordFailure(generation, "open circuit");
    cooldownController.dispose();
    vi.advanceTimersByTime(BACKEND_RESTART_POLICY.cooldownMs);
    expect(restartRequests).toEqual([]);
  });
});

describe("desktop backend restart integration", () => {
  it("uses generation-specific semantic health readiness for stability", () => {
    const readinessMonitor = sourceBetween(
      desktopMainSource,
      "function monitorBackendGenerationReadiness(",
      "async function reserveBackendEndpoint(",
    );

    expect(readinessMonitor).toContain('path: "/health"');
    expect(readinessMonitor).toContain("isReady: isBackendStartupReadyResponse");
    expect(readinessMonitor).toContain("backendRestartController.markStartupReady(generation)");
    expect(readinessMonitor).not.toContain("backendListeningDetector");
    expect(readinessMonitor).not.toContain("waitForBackendWindowReady");

    const readinessPredicate = sourceBetween(
      desktopMainSource,
      "async function isBackendStartupReadyResponse(",
      "function cancelBackendGenerationReadinessWait(",
    );
    expect(readinessPredicate).toContain("payload.startupReady === true");
  });

  it("admits every automatic start before endpoint reservation and backend spawn", () => {
    const automaticAdmission = sourceBetween(
      desktopMainSource,
      "async function beginAutomaticBackendStart(",
      "async function launchAdmittedBackendGeneration(",
    );
    expect(automaticAdmission.indexOf("admitAutomatic(reason)")).toBeLessThan(
      automaticAdmission.indexOf("launchAdmittedBackendGeneration"),
    );

    const admittedLaunch = sourceBetween(
      desktopMainSource,
      "async function launchAdmittedBackendGeneration(",
      "async function settleBackendGenerationAfterReadinessFailure(",
    );
    expect(admittedLaunch.indexOf("reserveBackendEndpoint(options.reason)")).toBeLessThan(
      admittedLaunch.indexOf("ChildProcess.spawn(process.execPath"),
    );
    expect(desktopMainSource).not.toContain("function startBackend(");
    expect(desktopMainSource.match(/beginAutomaticBackendStart\(/g)).toHaveLength(6);
  });

  it("keeps all restart ownership until bounded shutdown confirms the child exited", () => {
    const readinessFailure = sourceBetween(
      desktopMainSource,
      "async function settleBackendGenerationAfterReadinessFailure(",
      "function takeBackendProcessForShutdown(",
    );
    const unconfirmedBranch = readinessFailure.indexOf("if (!shutdownDisposition.exitConfirmed)");
    const failureRecording = readinessFailure.indexOf("recordBackendGenerationFailure(");

    expect(readinessFailure.indexOf("await stopBackendAndWaitForExit(")).toBeLessThan(
      unconfirmedBranch,
    );
    expect(unconfirmedBranch).toBeLessThan(failureRecording);
    expect(readinessFailure).toContain("preserveRestartGeneration: generation");
    expect(readinessFailure).toContain("shutdownHttpUrl: baseUrl");
    expect(readinessFailure).toContain("replacement-blocked=true");
    expect(readinessFailure).toContain("return;");
    expect(readinessFailure).not.toContain("backendGeneration = null");
    expect(readinessFailure.indexOf("settlingBackendGenerations.delete")).toBeLessThan(
      unconfirmedBranch,
    );
  });

  it("returns and consumes cross-platform exit proof without eager ownership release", () => {
    const stopBackendAndWait = sourceBetween(
      desktopMainSource,
      "async function stopBackendAndWaitForExit(",
      "async function disposeBrowserUsePipeServerForShutdown(",
    );
    const mismatch = stopBackendAndWait.indexOf(
      "options.expectedChild && child !== options.expectedChild",
    );
    const readinessCancellation = stopBackendAndWait.indexOf("cancelBackendReadinessWait()");

    expect(mismatch).toBeGreaterThanOrEqual(0);
    expect(mismatch).toBeLessThan(readinessCancellation);
    expect(stopBackendAndWait).toContain("Promise<BackendStopDisposition>");
    expect(stopBackendAndWait).toMatch(
      /fromWindowsBackendShutdownResult\(\s*await stopWindowsBackendAndWait\(\{/,
    );
    expect(stopBackendAndWait).toContain("if (!disposition.exitConfirmed");
    expect(stopBackendAndWait).toContain("if (disposition.exitConfirmed)");
    expect(stopBackendAndWait).toContain("settleConfirmedBackendStop(");
    expect(stopBackendAndWait).not.toContain("backendProcess = null");
    expect(stopBackendAndWait).not.toContain("backendGeneration = null");

    expect(desktopMainSource).toMatch(
      /import\s*\{\s*stopPosixBackendAndWait,\s*type PosixBackendShutdownDisposition,\s*\}\s*from "\.\/posixBackendShutdown";/,
    );
    expect(stopBackendAndWait).toMatch(
      /disposition = await stopPosixBackendAndWait\(\{\s*child,\s*forceKillDelayMs,\s*timeoutMs,\s*\}\);/,
    );

    const admittedLaunch = sourceBetween(
      desktopMainSource,
      "async function launchAdmittedBackendGeneration(",
      "async function settleBackendGenerationAfterReadinessFailure(",
    );
    expect(admittedLaunch).toContain("child.pid !== undefined && !hasBackendProcessExited(child)");
    expect(admittedLaunch).toContain("settleGenerationAfterConfirmedExit(");
  });

  it("fails update preparation closed when backend exit remains unconfirmed", () => {
    const updateInstall = sourceBetween(
      desktopMainSource,
      "async function runDownloadedUpdateInstall(",
      "async function installDownloadedUpdate(",
    );
    const stop = updateInstall.indexOf(
      "const shutdownDisposition = await stopBackendAndWaitForExit()",
    );
    const rejectUnconfirmed = updateInstall.indexOf("if (!shutdownDisposition.exitConfirmed)");
    const installHandoff = updateInstall.indexOf("autoUpdater.quitAndInstall()");

    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(rejectUnconfirmed);
    expect(rejectUnconfirmed).toBeLessThan(installHandoff);
    expect(updateInstall).toContain(
      "The desktop backend did not confirm shutdown. Update installation was not started.",
    );
    expect(
      updateInstall.indexOf("updateInstallPreparation.requireActive(preparationAttempt)"),
    ).toBeLessThan(installHandoff);
  });

  it("cancels in-flight updater preparation without double-running recovery", () => {
    const installEntry = sourceBetween(
      desktopMainSource,
      "async function installDownloadedUpdate(",
      "async function recordDownloadedUpdateIdentity(",
    );
    expect(installEntry.indexOf("updateInstallPreparation.begin()")).toBeLessThan(
      installEntry.indexOf("runDownloadedUpdateInstall(preparationAttempt)"),
    );
    expect(installEntry).toContain("updateInstallPreparation.release(preparationAttempt)");

    const clearInstall = sourceBetween(
      desktopMainSource,
      "function clearUpdaterInstallInFlightAfterError(",
      "function clearUpdateInstallWatchdogTimer(",
    );
    expect(clearInstall).toContain("updateInstallPreparation.cancel()");
    expect(clearInstall).toContain("input?.preservePendingPreparation");

    const updaterConfiguration = sourceBetween(
      desktopMainSource,
      "function configureAutoUpdater(",
      "async function launchScheduledBackendRestart(",
    );
    expect(updaterConfiguration).toContain("preservePendingPreparation: true");
    expect(updaterConfiguration).toContain(
      'if (errorContext === "install" && !installPreparationPending)',
    );
  });

  it("requires backend exit proof before cleanup or app quit and resets failed shutdowns for retry", () => {
    const shutdown = sourceBetween(
      desktopMainSource,
      "async function shutdownDesktopRuntime(",
      "function requestGracefulAppQuit(",
    );
    expect(shutdown.indexOf("backendRestartController.dispose()")).toBeLessThan(
      shutdown.indexOf("stopBackendAndWaitForExit()"),
    );
    expect(shutdown.indexOf("cancelBackendGenerationReadinessWait()")).toBeLessThan(
      shutdown.indexOf("stopBackendAndWaitForExit()"),
    );
    expect(shutdown).toContain("shutdown incomplete disposition=");
    expect(shutdown).toContain("backend-exit-unconfirmed=true");
    expect(shutdown).toContain("if (!disposition.exitConfirmed)");
    expect(shutdown.indexOf("if (!disposition.exitConfirmed)")).toBeLessThan(
      shutdown.indexOf("browserManager.dispose()"),
    );
    expect(shutdown).toContain("desktopShutdownPromise = null");
    expect(shutdown).toContain("isQuitting = false");

    const requestQuit = sourceBetween(
      desktopMainSource,
      "function requestGracefulAppQuit(",
      "function registerIpcHandlers(",
    );
    expect(requestQuit).toContain(
      "runAfterDesktopShutdown(shutdownDesktopRuntime(reason), () => app.quit())",
    );
    expect(requestQuit).not.toContain(".finally(");
  });
});
