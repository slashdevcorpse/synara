// Pure restart supervision: process spawning and shutdown remain owned by desktop main.
export const BACKEND_RESTART_POLICY = Object.freeze({
  stableUptimeMs: 60_000,
  failureWindowMs: 5 * 60_000,
  failureThreshold: 5,
  lifetimeAdmissionLimit: 6,
  cooldownMs: 60_000,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
} as const);

const backendRestartGenerationBrand: unique symbol = Symbol("BackendRestartGeneration");

export type BackendRestartGenerationKind = "closed" | "half-open";

export interface BackendRestartGeneration {
  readonly [backendRestartGenerationBrand]: true;
  readonly id: number;
  readonly kind: BackendRestartGenerationKind;
  readonly admittedAtMs: number;
  readonly reason: string;
}

export type BackendRestartCircuitState = "closed" | "open" | "half-open" | "latched" | "disposed";

export type BackendRestartGenerationPhase = "starting" | "ready" | "stable";

export type BackendRestartAdmissionDenialReason =
  | "disposed"
  | "generation-active"
  | "restart-scheduled"
  | "circuit-open"
  | "half-open-active"
  | "latched"
  | "lifetime-exhausted";

export type BackendRestartAdmission =
  | { readonly type: "admitted"; readonly generation: BackendRestartGeneration }
  | { readonly type: "denied"; readonly reason: BackendRestartAdmissionDenialReason };

export interface BackendRestartRequest {
  readonly generation: BackendRestartGeneration;
  readonly reason: string;
}

export type BackendRestartFailureOutcome =
  | { readonly type: "ignored" }
  | { readonly type: "restart-scheduled"; readonly delayMs: number }
  | { readonly type: "circuit-open"; readonly cooldownMs: number }
  | { readonly type: "latched"; readonly reason: "half-open-failed" | "lifetime-exhausted" };

export interface BackendRestartControllerSnapshot {
  readonly circuitState: BackendRestartCircuitState;
  readonly lifetimeAdmissions: number;
  readonly restartAttempt: number;
  readonly recentFailures: number;
  readonly activeGenerationId: number | null;
  readonly activeGenerationKind: BackendRestartGenerationKind | null;
  readonly activeGenerationPhase: BackendRestartGenerationPhase | null;
  readonly pendingTimer: "restart" | "cooldown" | "stability" | null;
}

export interface BackendRestartControllerOptions {
  readonly onRestartDue: (request: BackendRestartRequest) => void;
  readonly onGenerationStable?: (generation: BackendRestartGeneration) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ActiveGeneration {
  readonly generation: BackendRestartGeneration;
  phase: BackendRestartGenerationPhase;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

export class BackendRestartController {
  private readonly onRestartDue: BackendRestartControllerOptions["onRestartDue"];
  private readonly onGenerationStable:
    | BackendRestartControllerOptions["onGenerationStable"]
    | undefined;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<BackendRestartControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<BackendRestartControllerOptions["clearTimer"]>;

  private circuitState: BackendRestartCircuitState = "closed";
  private activeGeneration: ActiveGeneration | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private nextGenerationId = 1;
  private lifetimeAdmissions = 0;
  private restartAttempt = 0;
  private failureTimestamps: number[] = [];

  constructor(options: BackendRestartControllerOptions) {
    this.onRestartDue = options.onRestartDue;
    this.onGenerationStable = options.onGenerationStable;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  admitAutomatic(reason: string): BackendRestartAdmission {
    if (this.circuitState === "disposed") {
      return { type: "denied", reason: "disposed" };
    }
    if (this.activeGeneration) {
      return {
        type: "denied",
        reason: this.circuitState === "half-open" ? "half-open-active" : "generation-active",
      };
    }
    if (this.retryTimer || this.cooldownTimer) {
      return {
        type: "denied",
        reason: this.circuitState === "open" ? "circuit-open" : "restart-scheduled",
      };
    }
    if (this.circuitState === "open") {
      return { type: "denied", reason: "circuit-open" };
    }
    if (this.circuitState === "half-open") {
      return { type: "denied", reason: "half-open-active" };
    }
    if (this.circuitState === "latched") {
      return { type: "denied", reason: "latched" };
    }
    return this.createAdmission("closed", reason);
  }

  markStartupReady(generation: BackendRestartGeneration): boolean {
    if (
      this.circuitState === "disposed" ||
      !this.isActiveGeneration(generation) ||
      this.activeGeneration?.phase !== "starting"
    ) {
      return false;
    }

    this.activeGeneration.phase = "ready";
    this.clearStabilityTimer();
    this.stabilityTimer = this.setTimer(() => {
      this.stabilityTimer = null;
      if (
        this.circuitState === "disposed" ||
        !this.isActiveGeneration(generation) ||
        this.activeGeneration?.phase !== "ready"
      ) {
        return;
      }

      this.activeGeneration.phase = "stable";
      this.circuitState = "closed";
      this.restartAttempt = 0;
      this.failureTimestamps = [];
      this.onGenerationStable?.(generation);
    }, BACKEND_RESTART_POLICY.stableUptimeMs);
    unrefTimer(this.stabilityTimer);
    return true;
  }

  recordFailure(
    generation: BackendRestartGeneration,
    reason: string,
  ): BackendRestartFailureOutcome {
    if (this.circuitState === "disposed" || !this.isActiveGeneration(generation)) {
      return { type: "ignored" };
    }

    const failedPhase = this.activeGeneration.phase;
    this.clearStabilityTimer();
    this.activeGeneration = null;
    const now = this.now();
    const windowStart = now - BACKEND_RESTART_POLICY.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((timestamp) => timestamp >= windowStart);
    this.failureTimestamps.push(now);

    if (generation.kind === "half-open" && failedPhase !== "stable") {
      this.latchCircuit();
      return { type: "latched", reason: "half-open-failed" };
    }

    if (this.lifetimeAdmissions >= BACKEND_RESTART_POLICY.lifetimeAdmissionLimit) {
      this.latchCircuit();
      return { type: "latched", reason: "lifetime-exhausted" };
    }

    if (this.failureTimestamps.length >= BACKEND_RESTART_POLICY.failureThreshold) {
      this.circuitState = "open";
      this.scheduleCooldown(reason);
      return {
        type: "circuit-open",
        cooldownMs: BACKEND_RESTART_POLICY.cooldownMs,
      };
    }

    this.circuitState = "closed";
    const delayMs = Math.min(
      BACKEND_RESTART_POLICY.baseDelayMs * 2 ** this.restartAttempt,
      BACKEND_RESTART_POLICY.maxDelayMs,
    );
    this.restartAttempt += 1;
    this.scheduleRestart(reason, delayMs);
    return { type: "restart-scheduled", delayMs };
  }

  retireGeneration(generation: BackendRestartGeneration): boolean {
    if (this.circuitState === "disposed" || !this.isActiveGeneration(generation)) {
      return false;
    }
    this.clearStabilityTimer();
    this.activeGeneration = null;
    if (this.circuitState === "half-open") {
      this.circuitState = "closed";
    }
    return true;
  }

  isCurrentGeneration(generation: BackendRestartGeneration): boolean {
    return this.circuitState !== "disposed" && this.isActiveGeneration(generation);
  }

  getSnapshot(): BackendRestartControllerSnapshot {
    this.pruneFailureWindow();
    return {
      circuitState: this.circuitState,
      lifetimeAdmissions: this.lifetimeAdmissions,
      restartAttempt: this.restartAttempt,
      recentFailures: this.failureTimestamps.length,
      activeGenerationId: this.activeGeneration?.generation.id ?? null,
      activeGenerationKind: this.activeGeneration?.generation.kind ?? null,
      activeGenerationPhase: this.activeGeneration?.phase ?? null,
      pendingTimer: this.retryTimer
        ? "restart"
        : this.cooldownTimer
          ? "cooldown"
          : this.stabilityTimer
            ? "stability"
            : null,
    };
  }

  dispose(): void {
    if (this.circuitState === "disposed") return;
    this.clearRetryTimer();
    this.clearCooldownTimer();
    this.clearStabilityTimer();
    this.activeGeneration = null;
    this.circuitState = "disposed";
  }

  private createAdmission(
    kind: BackendRestartGenerationKind,
    reason: string,
  ): BackendRestartAdmission {
    if (this.lifetimeAdmissions >= BACKEND_RESTART_POLICY.lifetimeAdmissionLimit) {
      this.latchCircuit();
      return { type: "denied", reason: "lifetime-exhausted" };
    }

    const generation: BackendRestartGeneration = Object.freeze({
      [backendRestartGenerationBrand]: true,
      id: this.nextGenerationId,
      kind,
      admittedAtMs: this.now(),
      reason,
    });
    this.nextGenerationId += 1;
    this.lifetimeAdmissions += 1;
    this.activeGeneration = { generation, phase: "starting" };
    this.circuitState = kind === "half-open" ? "half-open" : "closed";
    return { type: "admitted", generation };
  }

  private scheduleRestart(reason: string, delayMs: number): void {
    this.clearRetryTimer();
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.circuitState !== "closed" || this.activeGeneration) return;
      const admission = this.createAdmission("closed", `restart after ${reason}`);
      if (admission.type === "admitted") {
        this.onRestartDue({ generation: admission.generation, reason });
      }
    }, delayMs);
    unrefTimer(this.retryTimer);
  }

  private scheduleCooldown(reason: string): void {
    this.clearRetryTimer();
    this.clearCooldownTimer();
    this.cooldownTimer = this.setTimer(() => {
      this.cooldownTimer = null;
      if (this.circuitState !== "open" || this.activeGeneration) return;
      const admission = this.createAdmission("half-open", `half-open after ${reason}`);
      if (admission.type === "admitted") {
        this.onRestartDue({ generation: admission.generation, reason });
      }
    }, BACKEND_RESTART_POLICY.cooldownMs);
    unrefTimer(this.cooldownTimer);
  }

  private latchCircuit(): void {
    this.clearRetryTimer();
    this.clearCooldownTimer();
    this.clearStabilityTimer();
    this.activeGeneration = null;
    this.circuitState = "latched";
  }

  private isActiveGeneration(generation: BackendRestartGeneration): boolean {
    return this.activeGeneration?.generation === generation;
  }

  private pruneFailureWindow(): void {
    const windowStart = this.now() - BACKEND_RESTART_POLICY.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((timestamp) => timestamp >= windowStart);
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  private clearCooldownTimer(): void {
    if (!this.cooldownTimer) return;
    this.clearTimer(this.cooldownTimer);
    this.cooldownTimer = null;
  }

  private clearStabilityTimer(): void {
    if (!this.stabilityTimer) return;
    this.clearTimer(this.stabilityTimer);
    this.stabilityTimer = null;
  }
}
