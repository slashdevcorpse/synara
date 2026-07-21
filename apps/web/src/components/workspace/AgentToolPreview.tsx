// FILE: AgentToolPreview.tsx
// Purpose: Compact, non-announcing progress treatment for the latest agent tool.
// Layer: Workspace agent sidebar presentation
// Exports: AgentToolPreview

import { HammerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import type { AgentToolActivity } from "../../hooks/useWorkspaceAgentActivity";

export function AgentToolPreview({ tool }: { tool: AgentToolActivity }) {
  const running = tool.state === "running";
  const progressLabel = running ? `${tool.name} running` : `${tool.name} finished`;

  return (
    <span
      aria-hidden="true"
      data-testid="workspace-agent-tool-preview"
      className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/65"
      title={progressLabel}
    >
      <HammerIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{tool.name}</span>
      <span className="relative h-1 w-7 shrink-0 overflow-hidden rounded-full bg-muted-foreground/15">
        <span
          aria-hidden="true"
          className={cn(
            "block h-full rounded-full bg-sky-300/75",
            running ? "w-1/2 animate-pulse motion-reduce:animate-none" : "w-full bg-emerald-300/70",
          )}
        />
      </span>
    </span>
  );
}
