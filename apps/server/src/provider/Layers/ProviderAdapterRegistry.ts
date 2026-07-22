/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/claudeAgent/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import { Effect, Layer } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { CommandCodeAdapter } from "../Services/CommandCodeAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { DroidAdapter } from "../Services/DroidAdapter.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { KiloAdapter } from "../Services/KiloAdapter.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { AntigravityAdapter } from "../Services/AntigravityAdapter.ts";
import type { ProviderMaintenanceGate } from "../providerMaintenanceGate.ts";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
  readonly maintenanceGate?: ProviderMaintenanceGate;
}

const MAINTENANCE_CONTROL_METHODS = new Set<PropertyKey>([
  "hasSession",
  "interruptTurn",
  "listSessions",
  "stopAll",
  "stopSession",
  "stopTask",
]);

function gateProviderAdapter(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  maintenanceGate: ProviderMaintenanceGate | undefined,
): ProviderAdapterShape<ProviderAdapterError> {
  if (!maintenanceGate) {
    return adapter;
  }

  const wrappedMethods = new Map<PropertyKey, unknown>();
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || MAINTENANCE_CONTROL_METHODS.has(property)) {
        return value;
      }

      const cached = wrappedMethods.get(property);
      if (cached) {
        return cached;
      }

      const operation = `ProviderAdapter.${String(property)}`;
      const wrapped = (...args: ReadonlyArray<unknown>) =>
        maintenanceGate
          .withOperation({
            provider: target.provider,
            operation,
            run: Effect.suspend(() =>
              (
                value as (
                  this: ProviderAdapterShape<ProviderAdapterError>,
                  ...methodArgs: ReadonlyArray<unknown>
                ) => Effect.Effect<unknown>
              ).apply(target, [...args]),
            ),
          })
          .pipe(
            Effect.catchTag("ProviderMaintenanceBusyError", (error) =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: target.provider,
                  method: operation,
                  detail: error.message,
                  cause: error,
                }),
              ),
            ),
          );
      wrappedMethods.set(property, wrapped);
      return wrapped;
    },
  }) as ProviderAdapterShape<ProviderAdapterError>;
}

const makeProviderAdapterRegistry = (options?: ProviderAdapterRegistryLiveOptions) =>
  Effect.gen(function* () {
    const adapters =
      options?.adapters !== undefined
        ? options.adapters
        : [
            yield* CodexAdapter,
            yield* CommandCodeAdapter,
            yield* ClaudeAdapter,
            yield* CursorAdapter,
            yield* AntigravityAdapter,
            yield* GrokAdapter,
            yield* DroidAdapter,
            yield* KiloAdapter,
            yield* OpenCodeAdapter,
            yield* PiAdapter,
          ];
    const byProvider = new Map(
      adapters.map((adapter) => [
        adapter.provider,
        gateProviderAdapter(adapter, options?.maintenanceGate),
      ]),
    );

    const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) => {
      const adapter = byProvider.get(provider);
      if (!adapter) {
        return Effect.fail(new ProviderUnsupportedError({ provider }));
      }
      return Effect.succeed(adapter);
    };

    const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
      Effect.sync(() => Array.from(byProvider.keys()));

    return {
      getByProvider,
      listProviders,
    } satisfies ProviderAdapterRegistryShape;
  });

export function makeProviderAdapterRegistryLive(options?: ProviderAdapterRegistryLiveOptions) {
  return Layer.effect(ProviderAdapterRegistry, makeProviderAdapterRegistry(options));
}

export const ProviderAdapterRegistryLive = makeProviderAdapterRegistryLive();
