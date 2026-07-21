// FILE: turnReasoning.ts
// Purpose: Derives durable, user-visible response summaries for the chat timeline.
// Layer: Web chat presentation helpers
// Exports: summary contracts, response aggregation, clipboard formatting

import type {
  AssistantDeliveryMode,
  MessageId,
  ModelSelection,
  OrchestrationThreadActivity,
  OrchestrationTurnSummary,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
  ThreadEnvironmentMode,
  TurnId,
} from "@synara/contracts";
import { normalizeCompactToolLabel } from "../../lib/toolCallLabel";
import type { TimelineEntry, WorkLogEntry } from "../../workLog";
import type { ChatMessage, TurnDiffSummary } from "../../types";

export const MAX_TURN_REASONING_TOOL_NAMES = 5;

export interface TurnReasoningToolCount {
  readonly name: string;
  readonly count: number;
}

/**
 * The durable contract is deliberately compatible with the shared projection
 * while allowing server-side aggregates to arrive independently. Derivation
 * prefers these durable counts when present and falls back to activity replay.
 */
export type TurnReasoningDurableTurn = Omit<
  OrchestrationTurnSummary,
  "toolCallCount" | "toolNames" | "toolNameCounts" | "approvalCount" | "rejectionCount"
> & {
  readonly toolCallCount?: number | null;
  readonly toolNames?: ReadonlyArray<string> | null;
  readonly toolNameCounts?: ReadonlyArray<TurnReasoningToolCount> | null;
  readonly approvalCount?: number | null;
  readonly rejectionCount?: number | null;
};

export type TurnReasoningStatus = "completed" | "failed" | "interrupted";

export interface TurnReasoningSummary {
  readonly turnNumber: number;
  readonly turnIds: ReadonlyArray<TurnId>;
  readonly terminalAssistantMessageId: MessageId;
  readonly status: TurnReasoningStatus;
  readonly isLatestCompleted: boolean;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly provider: ProviderKind | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly assistantDeliveryMode: AssistantDeliveryMode | null;
  readonly contextUsedTokens: number | null;
  readonly contextWindowTokens: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly totalTokens: number | null;
  readonly tokenUsageProvider: ProviderKind | null;
  readonly toolCallCount: number;
  readonly distinctToolCount: number;
  /** First-seen unique tool counts, capped at MAX_TURN_REASONING_TOOL_NAMES. */
  readonly toolNameCounts: ReadonlyArray<TurnReasoningToolCount>;
  /** First-seen unique tool names, capped at MAX_TURN_REASONING_TOOL_NAMES. */
  readonly distinctToolNames: ReadonlyArray<string>;
  readonly toolNameOverflowCount: number;
  readonly approvalCount: number;
  readonly rejectionCount: number;
  readonly filesChangedCount: number;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
  readonly envMode: ThreadEnvironmentMode | null;
}

export interface BuildTurnReasoningSummaryInput {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly timelineEntries?: ReadonlyArray<TimelineEntry>;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turnDiffSummaries?: ReadonlyArray<TurnDiffSummary>;
  readonly turns?: ReadonlyArray<TurnReasoningDurableTurn>;
}

interface ResponseSegment {
  readonly turnNumber: number;
  readonly userMessage: ChatMessage | null;
  readonly assistantMessages: ReadonlyArray<ChatMessage>;
  readonly terminalAssistantMessage: ChatMessage;
  readonly turnIds: ReadonlyArray<TurnId>;
}

interface ToolAggregate {
  readonly count: number;
  readonly nameCounts: ReadonlyArray<TurnReasoningToolCount>;
}

interface ApprovalAggregate {
  readonly approvals: number;
  readonly rejections: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function earliest(values: ReadonlyArray<string | null | undefined>): string | null {
  let selected: string | null = null;
  let selectedTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const parsed = timestamp(value);
    if (value && parsed !== null && parsed < selectedTime) {
      selected = value;
      selectedTime = parsed;
    }
  }
  return selected;
}

function latest(values: ReadonlyArray<string | null | undefined>): string | null {
  let selected: string | null = null;
  let selectedTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = timestamp(value);
    if (value && parsed !== null && parsed >= selectedTime) {
      selected = value;
      selectedTime = parsed;
    }
  }
  return selected;
}

function lastNonNull<T>(values: ReadonlyArray<T | null | undefined>): T | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function sumKnown(values: ReadonlyArray<number | null | undefined>): number | null {
  let found = false;
  let total = 0;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) continue;
    found = true;
    total += value;
  }
  return found ? total : null;
}

function countToolNames(
  values: ReadonlyArray<string | null | undefined>,
): TurnReasoningToolCount[] {
  const counts = new Map<string, TurnReasoningToolCount>();
  for (const value of values) {
    const name = asTrimmedString(value);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const existing = counts.get(key);
    counts.set(
      key,
      existing ? { name: existing.name, count: existing.count + 1 } : { name, count: 1 },
    );
  }
  return [...counts.values()];
}

function mergeToolNameCounts(
  groups: ReadonlyArray<ReadonlyArray<TurnReasoningToolCount>>,
): TurnReasoningToolCount[] {
  const counts = new Map<string, TurnReasoningToolCount>();
  for (const group of groups) {
    for (const entry of group) {
      const name = asTrimmedString(entry.name);
      const count = asNonNegativeNumber(entry.count);
      if (!name || count === null || count === 0) continue;
      const key = name.toLocaleLowerCase();
      const existing = counts.get(key);
      counts.set(key, {
        name: existing?.name ?? name,
        count: (existing?.count ?? 0) + count,
      });
    }
  }
  return [...counts.values()];
}

function deriveResponseSegments(messages: ReadonlyArray<ChatMessage>): ResponseSegment[] {
  const segments: ResponseSegment[] = [];
  let turnNumber = 0;
  let userMessage: ChatMessage | null = null;
  let assistants: ChatMessage[] = [];

  const flush = () => {
    const terminalAssistantMessage = assistants.at(-1);
    if (!terminalAssistantMessage || terminalAssistantMessage.streaming) {
      assistants = [];
      return;
    }
    const turnIds = [
      ...new Set(assistants.flatMap((message) => (message.turnId ? [message.turnId] : []))),
    ];
    segments.push({
      turnNumber: Math.max(1, turnNumber),
      userMessage,
      assistantMessages: assistants,
      terminalAssistantMessage,
      turnIds,
    });
    assistants = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      flush();
      turnNumber += 1;
      userMessage = message;
      continue;
    }
    if (message.role === "assistant") {
      if (turnNumber === 0) turnNumber = 1;
      assistants.push(message);
      continue;
    }
    // System messages are transcript annotations, not response boundaries. In
    // particular, provider notices can arrive after the prompt but before the
    // first assistant message and must not detach that response from its user.
  }
  flush();
  return segments;
}

function compareDurableTurns(
  left: TurnReasoningDurableTurn,
  right: TurnReasoningDurableTurn,
): number {
  const requestedDelta = (timestamp(left.requestedAt) ?? 0) - (timestamp(right.requestedAt) ?? 0);
  return requestedDelta !== 0
    ? requestedDelta
    : String(left.turnId).localeCompare(String(right.turnId));
}

function appendSegmentIndex<Key>(index: Map<Key, number[]>, key: Key, segmentIndex: number): void {
  const existing = index.get(key);
  if (existing) {
    existing.push(segmentIndex);
  } else {
    index.set(key, [segmentIndex]);
  }
}

function indexDurableTurnsBySegment(
  segments: ReadonlyArray<ResponseSegment>,
  turns: ReadonlyArray<TurnReasoningDurableTurn>,
): TurnReasoningDurableTurn[][] {
  if (segments.length === 0) return [];
  const segmentIndexesByTurnId = new Map<TurnId, number[]>();
  const segmentIndexesByAssistantId = new Map<MessageId, number[]>();
  for (const [segmentIndex, segment] of segments.entries()) {
    for (const turnId of segment.turnIds) {
      appendSegmentIndex(segmentIndexesByTurnId, turnId, segmentIndex);
    }
    for (const assistantMessage of segment.assistantMessages) {
      appendSegmentIndex(segmentIndexesByAssistantId, assistantMessage.id, segmentIndex);
    }
  }

  const turnsBySegment: TurnReasoningDurableTurn[][] = Array.from(
    { length: segments.length },
    () => [],
  );
  for (const turn of turns.toSorted(compareDurableTurns)) {
    const matchingSegmentIndexes = new Set<number>();
    for (const segmentIndex of segmentIndexesByTurnId.get(turn.turnId) ?? []) {
      matchingSegmentIndexes.add(segmentIndex);
    }
    if (turn.assistantMessageId !== null) {
      for (const segmentIndex of segmentIndexesByAssistantId.get(turn.assistantMessageId) ?? []) {
        matchingSegmentIndexes.add(segmentIndex);
      }
    }
    for (const segmentIndex of matchingSegmentIndexes) {
      turnsBySegment[segmentIndex]?.push(turn);
    }
  }
  return turnsBySegment;
}

function activitySequence(activity: OrchestrationThreadActivity): number {
  return activity.sequence ?? Number.MAX_SAFE_INTEGER;
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const sequenceDelta = activitySequence(left) - activitySequence(right);
  if (sequenceDelta !== 0) return sequenceDelta;
  return (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0);
}

interface TimestampedActivity {
  readonly activity: OrchestrationThreadActivity;
  readonly createdAt: number;
  readonly order: number;
}

interface SegmentActivityWindow {
  readonly segmentIndex: number;
  readonly start: number;
  readonly end: number;
}

interface SegmentActivities {
  readonly all: OrchestrationThreadActivity[];
  /** Time-window matches whose turn ID was unknown to every response. */
  readonly unmatched: OrchestrationThreadActivity[];
}

function indexActivitiesBySegment(
  segments: ReadonlyArray<ResponseSegment>,
  durableTurnsBySegment: ReadonlyArray<ReadonlyArray<TurnReasoningDurableTurn>>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): SegmentActivities[] {
  if (segments.length === 0) return [];
  const segmentIndexesByTurnId = new Map<TurnId, number[]>();
  for (const [segmentIndex, segment] of segments.entries()) {
    const knownTurnIds = new Set([
      ...segment.turnIds,
      ...(durableTurnsBySegment[segmentIndex] ?? []).map((turn) => turn.turnId),
    ]);
    for (const turnId of knownTurnIds) {
      appendSegmentIndex(segmentIndexesByTurnId, turnId, segmentIndex);
    }
  }

  const activitiesBySegment: SegmentActivities[] = Array.from({ length: segments.length }, () => ({
    all: [],
    unmatched: [],
  }));
  const unmatchedActivities: TimestampedActivity[] = [];
  const orderedActivities = activities.toSorted(compareActivities);
  for (const [order, activity] of orderedActivities.entries()) {
    const matchingSegmentIndexes =
      activity.turnId === null ? [] : (segmentIndexesByTurnId.get(activity.turnId) ?? []);
    if (matchingSegmentIndexes.length > 0) {
      for (const segmentIndex of matchingSegmentIndexes) {
        activitiesBySegment[segmentIndex]?.all.push(activity);
      }
      continue;
    }
    const createdAt = timestamp(activity.createdAt);
    if (createdAt !== null) unmatchedActivities.push({ activity, createdAt, order });
  }

  // Assistant messages can expose only some provider mini-turn IDs. Assign
  // activities for unknown IDs by response time window instead of dropping
  // them. The active-window sweep is linear after sorting and selects only one
  // segment, so exact matches are never replayed and overlapping windows cannot
  // double-count an unmatched activity.
  const windows: SegmentActivityWindow[] = segments
    .map((segment, segmentIndex) => ({
      segmentIndex,
      start:
        timestamp(segment.userMessage?.createdAt ?? segment.assistantMessages[0]?.createdAt) ??
        Number.NEGATIVE_INFINITY,
      end:
        timestamp(
          segment.terminalAssistantMessage.completedAt ??
            segment.terminalAssistantMessage.createdAt,
        ) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.start - right.start || left.segmentIndex - right.segmentIndex);
  unmatchedActivities.sort(
    (left, right) => left.createdAt - right.createdAt || left.order - right.order,
  );
  const activeWindows: SegmentActivityWindow[] = [];
  let nextWindowIndex = 0;
  for (const match of unmatchedActivities) {
    while ((windows[nextWindowIndex]?.start ?? Number.POSITIVE_INFINITY) <= match.createdAt) {
      const window = windows[nextWindowIndex];
      if (window) activeWindows.push(window);
      nextWindowIndex += 1;
    }
    while (
      activeWindows.length > 0 &&
      (activeWindows.at(-1)?.end ?? Number.NEGATIVE_INFINITY) < match.createdAt
    ) {
      activeWindows.pop();
    }
    const window = activeWindows.at(-1);
    if (window && match.createdAt <= window.end) {
      const segmentActivities = activitiesBySegment[window.segmentIndex];
      segmentActivities?.all.push(match.activity);
      segmentActivities?.unmatched.push(match.activity);
    }
  }

  for (const segmentActivities of activitiesBySegment) {
    segmentActivities.all.sort(compareActivities);
    segmentActivities.unmatched.sort(compareActivities);
  }

  return activitiesBySegment;
}

function nestedActivityData(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return asRecord(asRecord(activity.payload)?.data);
}

function activityToolCallId(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  const data = nestedActivityData(activity);
  const item = asRecord(payload?.item);
  return asTrimmedString(
    data?.toolCallId ??
      data?.callID ??
      data?.callId ??
      payload?.toolCallId ??
      payload?.providerItemId ??
      item?.id,
  );
}

const NON_TOOL_ITEM_TYPES = new Set([
  "agent_message",
  "analysis",
  "context_compaction",
  "reasoning",
  "thinking",
]);

function activityToolName(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  const data = nestedActivityData(activity);
  const itemType = asTrimmedString(payload?.itemType ?? data?.itemType)?.toLocaleLowerCase();
  if (itemType && NON_TOOL_ITEM_TYPES.has(itemType)) return null;
  const value = asTrimmedString(
    data?.toolName ?? payload?.toolName ?? payload?.title ?? data?.title ?? activity.summary,
  );
  if (!value) return null;
  const normalized = normalizeCompactToolLabel(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function deriveActivityTools(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ToolAggregate {
  const invocationNames = new Map<string, string>();
  const openFallbackByName = new Map<string, string>();
  let fallbackOrdinal = 0;

  for (const activity of activities) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const name = activityToolName(activity);
    if (!name) continue;
    const stableId = activityToolCallId(activity);
    let key: string;
    if (stableId) {
      key = `id:${stableId}`;
    } else {
      const normalizedName = name.toLocaleLowerCase();
      const open = openFallbackByName.get(normalizedName);
      if (activity.kind === "tool.started" || !open) {
        fallbackOrdinal += 1;
        key = `fallback:${normalizedName}:${fallbackOrdinal}`;
        openFallbackByName.set(normalizedName, key);
      } else {
        key = open;
      }
      if (activity.kind === "tool.completed") openFallbackByName.delete(normalizedName);
    }
    invocationNames.set(key, name);
  }

  return { count: invocationNames.size, nameCounts: countToolNames([...invocationNames.values()]) };
}

function isTimelineToolEntry(entry: WorkLogEntry): boolean {
  return (
    entry.activityKind === "tool.started" ||
    entry.activityKind === "tool.updated" ||
    entry.activityKind === "tool.completed"
  );
}

function deriveTimelineTools(
  segment: ResponseSegment,
  entries: ReadonlyArray<TimelineEntry>,
): ToolAggregate {
  const turnIds = new Set(segment.turnIds);
  const start = timestamp(
    segment.userMessage?.createdAt ?? segment.assistantMessages[0]?.createdAt,
  );
  const end = timestamp(
    segment.terminalAssistantMessage.completedAt ?? segment.terminalAssistantMessage.createdAt,
  );
  const invocations = new Map<string, string>();
  for (const timelineEntry of entries) {
    if (timelineEntry.kind !== "work" || !isTimelineToolEntry(timelineEntry.entry)) continue;
    const work = timelineEntry.entry;
    const belongs =
      turnIds.size > 0
        ? work.turnId !== null && work.turnId !== undefined && turnIds.has(work.turnId)
        : (() => {
            const createdAt = timestamp(work.createdAt);
            return (
              createdAt !== null &&
              (start === null || createdAt >= start) &&
              (end === null || createdAt <= end)
            );
          })();
    if (!belongs) continue;
    const name = asTrimmedString(work.toolName ?? work.toolTitle ?? work.label);
    if (!name) continue;
    invocations.set(work.toolCallId ? `id:${work.toolCallId}` : `entry:${work.id}`, name);
  }
  return { count: invocations.size, nameCounts: countToolNames([...invocations.values()]) };
}

function deriveTools(
  segment: ResponseSegment,
  turns: ReadonlyArray<TurnReasoningDurableTurn>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  unmatchedActivities: ReadonlyArray<OrchestrationThreadActivity>,
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ToolAggregate {
  const durableCount = sumKnown(turns.map((turn) => turn.toolCallCount));
  const durableNameCounts = turns.some((turn) => turn.toolNameCounts !== undefined)
    ? mergeToolNameCounts(turns.map((turn) => turn.toolNameCounts ?? []))
    : countToolNames(turns.flatMap((turn) => turn.toolNames ?? []));
  if (durableCount !== null || durableNameCounts.length > 0) {
    const unmatchedTools = deriveActivityTools(unmatchedActivities);
    return {
      count:
        (durableCount ??
          durableNameCounts.reduce((total, toolCount) => total + toolCount.count, 0)) +
        unmatchedTools.count,
      nameCounts:
        durableNameCounts.length > 0
          ? mergeToolNameCounts([durableNameCounts, unmatchedTools.nameCounts])
          : deriveActivityTools(activities).nameCounts,
    };
  }
  const activityTools = deriveActivityTools(activities);
  return activityTools.count > 0 ? activityTools : deriveTimelineTools(segment, timelineEntries);
}

function activityRequestId(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  const data = nestedActivityData(activity);
  return asTrimmedString(payload?.requestId ?? data?.requestId);
}

function deriveActivityApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ApprovalAggregate {
  const approvalIds = new Set<string>();
  const rejectionIds = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "approval.requested" && activity.kind !== "approval.resolved") continue;
    const requestId = activityRequestId(activity);
    if (!requestId) continue;
    approvalIds.add(requestId);
    if (activity.kind !== "approval.resolved") continue;
    const payload = asRecord(activity.payload);
    const data = nestedActivityData(activity);
    const decision = asTrimmedString(payload?.decision ?? data?.decision);
    if (decision === "decline" || decision === "cancel") rejectionIds.add(requestId);
  }
  return { approvals: approvalIds.size, rejections: rejectionIds.size };
}

function deriveApprovals(
  turns: ReadonlyArray<TurnReasoningDurableTurn>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  unmatchedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): ApprovalAggregate {
  const activityAggregate = deriveActivityApprovals(activities);
  const unmatchedAggregate = deriveActivityApprovals(unmatchedActivities);
  const durableApprovals = sumKnown(turns.map((turn) => turn.approvalCount));
  const durableRejections = sumKnown(turns.map((turn) => turn.rejectionCount));
  return {
    approvals:
      durableApprovals === null
        ? activityAggregate.approvals
        : durableApprovals + unmatchedAggregate.approvals,
    rejections:
      durableRejections === null
        ? activityAggregate.rejections
        : durableRejections + unmatchedAggregate.rejections,
  };
}

function explicitReasoningEffort(selection: ModelSelection | null): string | null {
  if (!selection?.options) return null;
  switch (selection.provider) {
    case "codex":
    case "cursor":
    case "antigravity":
    case "grok":
    case "droid":
      return asTrimmedString(selection.options.reasoningEffort);
    case "claudeAgent":
      return asTrimmedString(selection.options.effort);
    case "kilo":
    case "opencode":
      return asTrimmedString(selection.options.variant);
    case "pi":
      return asTrimmedString(selection.options.thinkingLevel);
    case "commandCode":
      return null;
  }
}

function deriveStatus(
  turns: ReadonlyArray<TurnReasoningDurableTurn>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnReasoningStatus {
  const states = [
    ...turns.map((turn) => turn.state),
    ...activities.flatMap((activity) => {
      if (activity.kind !== "turn.completed") return [];
      const state = asTrimmedString(asRecord(activity.payload)?.state);
      return state ? [state] : [];
    }),
  ];
  if (states.some((state) => state === "error" || state === "failed")) return "failed";
  if (states.some((state) => state === "interrupted" || state === "cancelled")) {
    return "interrupted";
  }
  return "completed";
}

function deriveFilesChangedCount(
  segment: ResponseSegment,
  summaries: ReadonlyArray<TurnDiffSummary>,
): number {
  const turnIds = new Set(segment.turnIds);
  const files = new Set<string>();
  for (const summary of summaries) {
    if (
      !turnIds.has(summary.turnId) &&
      summary.assistantMessageId !== segment.terminalAssistantMessage.id
    ) {
      continue;
    }
    for (const file of summary.files) files.add(file.path);
  }
  return files.size;
}

function buildSegmentSummary(
  segment: ResponseSegment,
  input: BuildTurnReasoningSummaryInput,
  durableTurns: ReadonlyArray<TurnReasoningDurableTurn>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  unmatchedActivities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnReasoningSummary {
  const tools = deriveTools(
    segment,
    durableTurns,
    activities,
    unmatchedActivities,
    input.timelineEntries ?? [],
  );
  const approvals = deriveApprovals(durableTurns, activities, unmatchedActivities);
  const startedAt =
    earliest(durableTurns.map((turn) => turn.startedAt)) ?? segment.userMessage?.createdAt ?? null;
  const completedAt =
    latest(durableTurns.map((turn) => turn.completedAt)) ??
    segment.terminalAssistantMessage.completedAt ??
    null;
  const startMs = timestamp(startedAt);
  const completedMs = timestamp(completedAt);
  const tokenUsages = durableTurns.flatMap((turn) => (turn.tokenUsage ? [turn.tokenUsage] : []));
  const latestContextUsage = tokenUsages
    .filter((usage) => usage.contextUsedTokens !== null || usage.contextWindowTokens !== null)
    .toSorted((left, right) => (timestamp(left.updatedAt) ?? 0) - (timestamp(right.updatedAt) ?? 0))
    .at(-1);
  const inputTokens = sumKnown(tokenUsages.map((usage) => usage.inputTokens));
  const outputTokens = sumKnown(tokenUsages.map((usage) => usage.outputTokens));
  const explicitTotalTokens = sumKnown(tokenUsages.map((usage) => usage.totalTokens));
  const tokenUsageProvider = lastNonNull(tokenUsages.map((usage) => usage.provider));
  const modelSelection = lastNonNull(durableTurns.map((turn) => turn.modelSelection));
  const provider =
    lastNonNull(durableTurns.map((turn) => turn.provider)) ??
    modelSelection?.provider ??
    tokenUsageProvider;
  const model =
    lastNonNull(durableTurns.map((turn) => turn.model)) ?? modelSelection?.model ?? null;
  const allToolNameCounts = tools.nameCounts;

  return {
    turnNumber: segment.turnNumber,
    turnIds: segment.turnIds,
    terminalAssistantMessageId: segment.terminalAssistantMessage.id,
    status: deriveStatus(durableTurns, activities),
    isLatestCompleted: false,
    startedAt,
    completedAt,
    durationMs:
      startMs !== null && completedMs !== null && completedMs >= startMs
        ? completedMs - startMs
        : null,
    provider,
    model,
    reasoningEffort:
      lastNonNull(durableTurns.map((turn) => turn.reasoningEffort)) ??
      explicitReasoningEffort(modelSelection),
    assistantDeliveryMode: lastNonNull(durableTurns.map((turn) => turn.assistantDeliveryMode)),
    contextUsedTokens: latestContextUsage?.contextUsedTokens ?? null,
    contextWindowTokens: latestContextUsage?.contextWindowTokens ?? null,
    inputTokens,
    cachedInputTokens: sumKnown(tokenUsages.map((usage) => usage.cachedInputTokens)),
    outputTokens,
    reasoningOutputTokens: sumKnown(tokenUsages.map((usage) => usage.reasoningOutputTokens)),
    totalTokens:
      explicitTotalTokens ??
      (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    tokenUsageProvider,
    toolCallCount: tools.count,
    distinctToolCount: allToolNameCounts.length,
    toolNameCounts: allToolNameCounts.slice(0, MAX_TURN_REASONING_TOOL_NAMES),
    distinctToolNames: allToolNameCounts
      .slice(0, MAX_TURN_REASONING_TOOL_NAMES)
      .map((entry) => entry.name),
    toolNameOverflowCount: Math.max(0, allToolNameCounts.length - MAX_TURN_REASONING_TOOL_NAMES),
    approvalCount: approvals.approvals,
    rejectionCount: approvals.rejections,
    filesChangedCount: deriveFilesChangedCount(segment, input.turnDiffSummaries ?? []),
    runtimeMode: lastNonNull(durableTurns.map((turn) => turn.runtimeMode)),
    interactionMode: lastNonNull(durableTurns.map((turn) => turn.interactionMode)),
    envMode: lastNonNull(durableTurns.map((turn) => turn.envMode)),
  };
}

/** Builds one summary per settled user-visible response, keyed by its terminal assistant message. */
export function buildTurnReasoningSummaryByAssistantMessageId(
  input: BuildTurnReasoningSummaryInput,
): Map<MessageId, TurnReasoningSummary> {
  const segments = deriveResponseSegments(input.messages);
  const durableTurnsBySegment = indexDurableTurnsBySegment(segments, input.turns ?? []);
  const activitiesBySegment = indexActivitiesBySegment(
    segments,
    durableTurnsBySegment,
    input.activities ?? [],
  );
  const summaries = segments.map((segment, index) =>
    buildSegmentSummary(
      segment,
      input,
      durableTurnsBySegment[index] ?? [],
      activitiesBySegment[index]?.all ?? [],
      activitiesBySegment[index]?.unmatched ?? [],
    ),
  );
  const latestIndex = summaries.length - 1;
  return new Map(
    summaries.map((summary, index) => [
      summary.terminalAssistantMessageId,
      index === latestIndex ? { ...summary, isLatestCompleted: true } : summary,
    ]),
  );
}

const numberFormatter = new Intl.NumberFormat("en-US");

function formatNullableNumber(value: number | null): string {
  return value === null ? "—" : numberFormatter.format(value);
}

export function formatTurnReasoningDuration(
  durationMs: number | null,
  style: "compact" | "precise" = "precise",
): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (style === "compact" && durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (style === "compact" && durationMs < 10_000) {
    return `${(durationMs / 1_000).toFixed(1).replace(/\.0$/u, "")}s`;
  }
  if (style === "precise" && durationMs < 60_000) {
    const seconds = Math.round(durationMs / 100) / 10;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function statusLabel(status: TurnReasoningStatus): string {
  return status.charAt(0).toLocaleUpperCase() + status.slice(1);
}

/** Formats the card's auditable fields as plain text for the Copy summary action. */
export function formatTurnReasoningSummaryForClipboard(summary: TurnReasoningSummary): string {
  const toolNames = summary.toolNameCounts
    .map((entry) => `${entry.name}${entry.count > 1 ? ` ×${entry.count}` : ""}`)
    .join(", ");
  const overflow = summary.toolNameOverflowCount > 0 ? `, +${summary.toolNameOverflowCount}` : "";
  const lines = [
    `Turn #${summary.turnNumber} · ${statusLabel(summary.status)} · ${formatTurnReasoningDuration(summary.durationMs)}`,
    `Model: ${summary.provider ?? "—"} · ${summary.model ?? "—"}`,
    `Context: ${formatNullableNumber(summary.contextUsedTokens)} / ${formatNullableNumber(summary.contextWindowTokens)} used`,
    `Tokens: input ${formatNullableNumber(summary.inputTokens)} · output ${formatNullableNumber(summary.outputTokens)} · cached ${formatNullableNumber(summary.cachedInputTokens)} · total ${formatNullableNumber(summary.totalTokens)}`,
    `Reasoning: ${summary.reasoningEffort ?? "—"} · ${summary.assistantDeliveryMode ?? "—"}`,
    `Tools: ${summary.toolCallCount} total · ${summary.distinctToolCount} distinct${toolNames ? ` · ${toolNames}${overflow}` : ""}`,
    `Approvals: ${summary.approvalCount} · Rejections: ${summary.rejectionCount}`,
    `Completion: ${summary.filesChangedCount} file${summary.filesChangedCount === 1 ? "" : "s"} changed`,
    `Access: ${summary.runtimeMode ?? "—"} · ${summary.envMode ?? "—"}`,
  ];
  if (summary.contextUsedTokens === null && summary.contextWindowTokens === null) {
    lines.splice(3, 0, "Token tracking requires provider support.");
  }
  return lines.join("\n");
}
