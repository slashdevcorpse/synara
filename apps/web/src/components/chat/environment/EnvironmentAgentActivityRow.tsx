// FILE: EnvironmentAgentActivityRow.tsx
// Purpose: Show the current provider's synchronized activity state in the Environment panel.
// Layer: Environment panel presentation

import type { ProviderKind } from "@synara/contracts";

import { AgentActivityPulse } from "~/components/chat/AgentActivityPulse";
import {
  isLiveAgentActivityPhase,
  type AgentActivityPhase,
  type AgentActivityState,
} from "~/components/chat/agentActivityPulse.logic";
import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
} from "./EnvironmentRow";

const AGENT_ACTIVITY_LABELS: Record<AgentActivityPhase, string> = {
  idle: "Idle",
  connecting: "Connecting",
  thinking: "Thinking",
  streaming: "Responding",
  "tool-running": "Running tools",
  interrupted: "Interrupted",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export function EnvironmentAgentActivityRow({
  provider,
  state,
}: {
  provider: ProviderKind;
  state: AgentActivityState;
}) {
  const active = isLiveAgentActivityPhase(state.phase);
  const phaseLabel = AGENT_ACTIVITY_LABELS[state.phase];

  return (
    <div
      className={cn(
        ENVIRONMENT_ROW_CLASS_NAME,
        "cursor-default hover:bg-transparent focus-visible:bg-transparent",
      )}
      role="group"
      aria-label={`Agent status: ${phaseLabel}`}
      data-environment-agent-activity={state.phase}
    >
      <EnvironmentRowBody
        icon={
          <ProviderIcon
            provider={provider}
            tone="header"
            className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
          />
        }
        label={active ? "Agent (active)" : "Agent"}
        trailing={
          <>
            <span className="text-[var(--color-text-foreground-secondary)]">{phaseLabel}</span>
            {state.phase === "idle" ? (
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-[var(--color-text-foreground-secondary)] opacity-35"
              />
            ) : (
              <AgentActivityPulse state={state} variant="dot" />
            )}
          </>
        }
      />
    </div>
  );
}
