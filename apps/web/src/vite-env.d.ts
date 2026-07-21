/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge, ServerProviderStatus } from "@synara/contracts";

interface SynaraE2eRendererReadiness {
  readonly sessionVersion: number;
  readonly snapshotSequence: number;
  readonly providers: ReadonlyArray<ServerProviderStatus>;
}

interface SynaraE2eRendererHarness {
  probeReadiness: () => Promise<SynaraE2eRendererReadiness>;
}

interface ImportMetaEnv {
  readonly APP_VERSION: string;
  readonly VITE_FEEDBACK_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
    __synaraE2e?: SynaraE2eRendererHarness;
  }
}
