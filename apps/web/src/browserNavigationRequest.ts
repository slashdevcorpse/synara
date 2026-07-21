// FILE: browserNavigationRequest.ts
// Purpose: One-shot browser navigation requests shared by dock and split-pane state.
// Layer: UI state contract

export interface BrowserNavigationRequest {
  id: string;
  url: string;
  localFilePath: string | null;
}
