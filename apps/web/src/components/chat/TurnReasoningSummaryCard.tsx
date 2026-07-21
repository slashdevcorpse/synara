// FILE: TurnReasoningSummaryCard.tsx
// Purpose: Renders the controlled, expandable summary for one completed reasoning turn.
// Layer: Chat transcript UI

import type { FeedbackThreadContext } from "~/feedback";
import type { ReactNode } from "react";
import { useFeedbackDialogStore } from "~/feedbackDialogStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { disclosureContentClassName } from "~/lib/disclosureMotion";
import { CheckIcon, CopyIcon, MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { ProviderIcon } from "../ProviderIcon";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { APP_TOOLTIP_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { formatTurnReasoningSummaryForClipboard, type TurnReasoningSummary } from "./turnReasoning";

const UNSUPPORTED_VALUE = "—";

const STATUS_STYLES: Record<
  TurnReasoningSummary["status"],
  { label: string; completionLabel: string; textClassName: string; dotClassName: string }
> = {
  completed: {
    label: "completed",
    completionLabel: "success",
    textClassName: "text-emerald-700 dark:text-emerald-400",
    dotClassName: "bg-emerald-600 dark:bg-emerald-400",
  },
  failed: {
    label: "failed",
    completionLabel: "failed",
    textClassName: "text-rose-700 dark:text-rose-400",
    dotClassName: "bg-rose-600 dark:bg-rose-400",
  },
  interrupted: {
    label: "interrupted",
    completionLabel: "interrupted",
    textClassName: "text-amber-700 dark:text-amber-400",
    dotClassName: "bg-amber-600 dark:bg-amber-400",
  },
};

export interface TurnReasoningSummaryCardProps {
  summary: TurnReasoningSummary;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  feedbackContext: FeedbackThreadContext;
  className?: string;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return UNSUPPORTED_VALUE;
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 10_000) {
    return `${(durationMs / 1_000).toFixed(1).replace(/\.0$/u, "")}s`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return UNSUPPORTED_VALUE;
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}K`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}

function pluralizedCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatCollapsedAccess(summary: TurnReasoningSummary): string {
  return summary.runtimeMode ?? UNSUPPORTED_VALUE;
}

function formatExpandedAccess(summary: TurnReasoningSummary): string {
  const environment = summary.envMode === "local" ? "local workspace" : summary.envMode;
  const values = [summary.runtimeMode, environment].filter(
    (value): value is NonNullable<typeof value> => value !== null && value.trim() !== "",
  );
  return values.length > 0 ? values.join(" · ") : UNSUPPORTED_VALUE;
}

function formatContext(summary: TurnReasoningSummary): string {
  if (summary.contextUsedTokens === null && summary.contextWindowTokens === null) {
    return `${UNSUPPORTED_VALUE} Token tracking requires provider support.`;
  }
  return `${formatTokenCount(summary.contextWindowTokens)} tokens · ${formatTokenCount(summary.contextUsedTokens)} used`;
}

function formatReasoning(summary: TurnReasoningSummary): string {
  const values = [summary.reasoningEffort, summary.assistantDeliveryMode].filter(
    (value): value is NonNullable<typeof value> => value !== null && value.trim() !== "",
  );
  return values.length > 0 ? values.join(" · ") : UNSUPPORTED_VALUE;
}

function buildTurnFeedbackContext(
  summary: TurnReasoningSummary,
  feedbackContext: FeedbackThreadContext,
): FeedbackThreadContext {
  return {
    ...feedbackContext,
    provider: summary.provider ?? summary.tokenUsageProvider,
    model: summary.model,
    environmentMode: summary.envMode,
    runtimeMode: summary.runtimeMode,
    interactionMode: summary.interactionMode,
    latestTurnState: summary.status,
    hasThreadError: feedbackContext.hasThreadError || summary.status === "failed",
  };
}

function SummaryDetail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

export function TurnReasoningSummaryCard({
  summary,
  expanded,
  onExpandedChange,
  feedbackContext,
  className,
}: TurnReasoningSummaryCardProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const openFeedbackDialog = useFeedbackDialogStore((state) => state.openDialog);
  const status = STATUS_STYLES[summary.status];
  const duration = formatDuration(summary.durationMs);
  const collapsedAccess = formatCollapsedAccess(summary);
  const expandedAccess = formatExpandedAccess(summary);
  const filesChanged = pluralizedCount(summary.filesChangedCount, "file changed", "files changed");
  const toolsInvoked = pluralizedCount(summary.toolCallCount, "tool");
  const distinctTools = pluralizedCount(summary.distinctToolCount, "distinct tool");
  const summaryLabel = `Turn ${summary.turnNumber} execution summary`;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={onExpandedChange}
      className={cn(
        APP_TOOLTIP_SURFACE_CLASS_NAME,
        "w-full font-system-ui text-[length:var(--app-font-size-ui-sm,11px)]",
        className,
      )}
      data-turn-reasoning-summary-card=""
      data-status={summary.status}
      data-expanded={expanded ? "true" : "false"}
    >
      <CollapsibleTrigger
        className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${summaryLabel}`}
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", status.dotClassName)}
        />
        {expanded ? (
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            Turn {summary.turnNumber} — <span className={status.textClassName}>{status.label}</span>{" "}
            <span className="font-normal text-muted-foreground">· {duration}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            <span className="font-medium text-foreground">Turn {summary.turnNumber}</span>
            {" · "}
            <span>{summary.model ?? UNSUPPORTED_VALUE}</span>
            {" · "}
            <span>{toolsInvoked}</span>
            {" · "}
            <span>{collapsedAccess}</span>
            {" · "}
            <span>{duration}</span>
            {" · "}
            <span>{filesChanged}</span>
          </span>
        )}
        <DisclosureChevron open={expanded} className="size-3" />
      </CollapsibleTrigger>

      <CollapsiblePanel>
        <div
          className={disclosureContentClassName(
            expanded,
            "border-t border-border/70 px-3 pb-2 pt-1.5",
          )}
        >
          <dl>
            <SummaryDetail label="Model">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <ProviderIcon
                  provider={summary.provider ?? summary.tokenUsageProvider}
                  className="size-4 shrink-0"
                />
                <span className="truncate">{summary.model ?? UNSUPPORTED_VALUE}</span>
              </span>
            </SummaryDetail>
            <SummaryDetail label="Context">{formatContext(summary)}</SummaryDetail>
            <SummaryDetail label="Reasoning">{formatReasoning(summary)}</SummaryDetail>
            <SummaryDetail label="Tools">
              <span>
                {toolsInvoked} invoked · {distinctTools}
              </span>
              {summary.toolNameCounts.length > 0 ? (
                <span className="mt-1 flex flex-wrap gap-1" aria-label="Tools used">
                  {summary.toolNameCounts.map((tool) => (
                    <code
                      key={tool.name}
                      className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground"
                    >
                      {tool.name}
                      {tool.count > 1 ? ` ×${tool.count}` : ""}
                    </code>
                  ))}
                  {summary.toolNameOverflowCount > 0 ? (
                    <span className="px-1 py-0.5 text-muted-foreground">
                      +{summary.toolNameOverflowCount} more
                    </span>
                  ) : null}
                </span>
              ) : null}
            </SummaryDetail>
            <SummaryDetail label="Verification">
              {pluralizedCount(summary.approvalCount, "approval")} ·{" "}
              {pluralizedCount(summary.rejectionCount, "rejection")}
            </SummaryDetail>
            <SummaryDetail label="Completion">
              <span className={status.textClassName}>{status.completionLabel}</span> ·{" "}
              {filesChanged}
            </SummaryDetail>
            <SummaryDetail label="Access">{expandedAccess}</SummaryDetail>
          </dl>

          <div className="mt-1.5 flex items-center gap-1 border-t border-border/60 pt-2">
            <button
              type="button"
              className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                copyToClipboard(formatTurnReasoningSummaryForClipboard(summary), undefined);
              }}
              aria-label={`Copy ${summaryLabel}`}
            >
              {isCopied ? (
                <CheckIcon aria-hidden="true" className="size-3.5 text-emerald-600" />
              ) : (
                <CopyIcon aria-hidden="true" className="size-3.5" />
              )}
              <span aria-live="polite">{isCopied ? "Copied" : "Copy summary"}</span>
            </button>
            <button
              type="button"
              className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                openFeedbackDialog(buildTurnFeedbackContext(summary, feedbackContext));
              }}
              aria-label={`Send feedback about Turn ${summary.turnNumber}`}
            >
              <MessageCircleIcon aria-hidden="true" className="size-3.5" />
              Feedback
            </button>
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
