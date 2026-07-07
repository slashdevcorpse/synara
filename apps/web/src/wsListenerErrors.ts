// FILE: wsListenerErrors.ts
// Purpose: Reports WebSocket listener failures without coupling transport fan-out to UI state.
// Used by: wsTransport and wsNativeApi listener-isolation boundaries.

// Keeps listener isolation observable while the caller continues fan-out.
export function reportWsListenerError(channel: string, error: unknown): void {
  console.error(`[ws:${channel}] listener threw`, error);
}
