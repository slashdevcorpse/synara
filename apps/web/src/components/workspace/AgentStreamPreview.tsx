// FILE: AgentStreamPreview.tsx
// Purpose: Truncated latest-response preview for a workspace agent row.
// Layer: Workspace agent sidebar presentation
// Exports: AgentStreamPreview

import { ChatBubbleIcon } from "~/lib/icons";

export function AgentStreamPreview({ preview }: { preview: string }) {
  return (
    <span
      data-testid="workspace-agent-stream-preview"
      className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/55"
      title={preview}
    >
      <ChatBubbleIcon className="size-3 shrink-0" />
      <span className="sr-only">Latest response: </span>
      <span className="min-w-0 truncate">{preview}</span>
    </span>
  );
}
