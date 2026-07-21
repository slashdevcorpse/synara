// FILE: pinning.logic.ts
// Purpose: Shared immutable helpers for sidebar pin id order, pruning, and optimistic merges.
// Layer: UI state logic
// Exports: pinned id normalization, mutation helpers, and pinned item derivation.

export type PinLimitResult<TId extends string> = {
  pinnedIds: TId[];
  changed: boolean;
  rejected: boolean;
};

export function normalizePinnedIds<TId extends string>(
  ids: readonly TId[],
  options?: { maxCount?: number },
): TId[] {
  const seen = new Set<TId>();
  const normalized: TId[] = [];
  const maxCount = Math.max(0, options?.maxCount ?? Number.POSITIVE_INFINITY);

  for (const id of ids) {
    if (normalized.length >= maxCount) {
      break;
    }
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

export function pinId<TId extends string>(
  ids: readonly TId[],
  id: TId,
  options?: { maxCount?: number },
): PinLimitResult<TId> {
  const normalized = normalizePinnedIds(ids, options);
  if (id.length === 0) {
    return { pinnedIds: normalized, changed: normalized.length !== ids.length, rejected: true };
  }
  if (normalized.includes(id)) {
    return { pinnedIds: normalized, changed: normalized.length !== ids.length, rejected: false };
  }
  if (options?.maxCount !== undefined && normalized.length >= options.maxCount) {
    return { pinnedIds: normalized, changed: false, rejected: true };
  }
  return { pinnedIds: [id, ...normalized], changed: true, rejected: false };
}

export function unpinId<TId extends string>(ids: readonly TId[], id: TId): PinLimitResult<TId> {
  const normalized = normalizePinnedIds(ids);
  const pinnedIds = normalized.filter((candidate) => candidate !== id);
  return {
    pinnedIds,
    changed: pinnedIds.length !== normalized.length || normalized.length !== ids.length,
    rejected: false,
  };
}

export function prunePinnedIds<TId extends string>(
  ids: readonly TId[],
  allowedIds: readonly TId[],
): TId[] {
  const allowedIdSet = new Set(allowedIds);
  return normalizePinnedIds(ids).filter((id) => allowedIdSet.has(id));
}

// Persisted order wins when present; server-only pins are appended in current sidebar order.
export function derivePinnedIds<
  TId extends string,
  TItem extends { id: TId; isPinned?: boolean | undefined },
>(input: {
  readonly items: readonly TItem[];
  readonly persistedPinnedIds: readonly TId[];
  readonly optimisticPinnedStateById: ReadonlyMap<TId, boolean>;
  readonly maxCount?: number;
}): TId[] {
  const itemIds = new Set(input.items.map((item) => item.id));
  const pinnedIds: TId[] = [];
  const addPinnedId = (id: TId) => {
    if (input.maxCount !== undefined && pinnedIds.length >= input.maxCount) {
      return;
    }
    if (itemIds.has(id) && !pinnedIds.includes(id)) {
      pinnedIds.push(id);
    }
  };

  for (const id of input.persistedPinnedIds) {
    if (input.optimisticPinnedStateById.get(id) === false) {
      continue;
    }
    addPinnedId(id);
  }

  for (const item of input.items) {
    const optimisticPinned = input.optimisticPinnedStateById.get(item.id);
    const isPinned = optimisticPinned ?? item.isPinned === true;
    if (isPinned) {
      addPinnedId(item.id);
    }
  }

  return pinnedIds;
}

export function getPinnedItems<TId extends string, TItem extends { id: TId }>(
  items: readonly TItem[],
  pinnedIds: readonly TId[],
): TItem[] {
  const itemById = new Map(items.map((item) => [item.id, item] as const));
  const pinnedItems: TItem[] = [];
  const seen = new Set<TId>();

  for (const id of pinnedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = itemById.get(id);
    if (item) {
      pinnedItems.push(item);
    }
  }

  return pinnedItems;
}

export function orderPinnedItemsFirst<TId extends string, TItem extends { id: TId }>(
  items: readonly TItem[],
  pinnedIds: readonly TId[],
): TItem[] {
  if (pinnedIds.length === 0) {
    return [...items];
  }
  const pinnedIdSet = new Set(pinnedIds);
  return [
    ...getPinnedItems(items, pinnedIds),
    ...items.filter((item) => !pinnedIdSet.has(item.id)),
  ];
}

export function isLatestPinMutation<TId>(input: {
  readonly id: TId;
  readonly requestVersion: number;
  readonly latestMutationVersionById: ReadonlyMap<TId, number>;
}): boolean {
  return input.latestMutationVersionById.get(input.id) === input.requestVersion;
}

export interface PinMutationLifecycle {
  readonly appliedPinned: boolean;
  readonly appliedSequence: number | null;
  readonly desiredPinned: boolean;
  readonly latestRequestVersion: number;
  readonly inFlightRequestVersion: number | null;
  readonly inFlightPinned: boolean | null;
  readonly latestSettled: boolean;
  readonly settlementSequence: number | null;
}

export function observePinMutationLifecycle(input: {
  readonly lifecycle: PinMutationLifecycle;
  readonly serverPinned: boolean;
  readonly serverSequence?: number | undefined;
}): PinMutationLifecycle {
  const observedSequence = input.serverSequence ?? null;
  if (
    input.lifecycle.appliedSequence !== null &&
    (observedSequence === null || observedSequence < input.lifecycle.appliedSequence)
  ) {
    return input.lifecycle;
  }
  if (
    input.lifecycle.appliedPinned === input.serverPinned &&
    input.lifecycle.appliedSequence === observedSequence
  ) {
    return input.lifecycle;
  }
  if (input.lifecycle.inFlightRequestVersion !== null) {
    return {
      ...input.lifecycle,
      appliedPinned: input.serverPinned,
      appliedSequence: observedSequence,
    };
  }
  if (input.lifecycle.latestSettled) {
    return {
      ...input.lifecycle,
      appliedPinned: input.serverPinned,
      appliedSequence: observedSequence,
      desiredPinned: input.serverPinned,
      settlementSequence: observedSequence,
    };
  }
  const latestSettled = input.lifecycle.desiredPinned === input.serverPinned;
  return {
    ...input.lifecycle,
    appliedPinned: input.serverPinned,
    appliedSequence: observedSequence,
    latestSettled,
    settlementSequence: latestSettled ? observedSequence : null,
  };
}

export function beginPinMutationLifecycle(input: {
  readonly lifecycle: PinMutationLifecycle | undefined;
  readonly requestVersion: number;
  readonly desiredPinned: boolean;
  readonly serverPinned: boolean;
  readonly serverSequence?: number | undefined;
}): PinMutationLifecycle {
  const observedLifecycle = input.lifecycle
    ? observePinMutationLifecycle({
        lifecycle: input.lifecycle,
        serverPinned: input.serverPinned,
        serverSequence: input.serverSequence,
      })
    : undefined;
  const appliedPinned = observedLifecycle?.appliedPinned ?? input.serverPinned;
  const appliedSequence = observedLifecycle?.appliedSequence ?? input.serverSequence ?? null;
  const inFlightRequestVersion = observedLifecycle?.inFlightRequestVersion ?? null;
  const latestSettled = inFlightRequestVersion === null && input.desiredPinned === appliedPinned;
  return {
    appliedPinned,
    appliedSequence,
    desiredPinned: input.desiredPinned,
    latestRequestVersion: input.requestVersion,
    inFlightRequestVersion,
    inFlightPinned: observedLifecycle?.inFlightPinned ?? null,
    latestSettled,
    settlementSequence: latestSettled ? appliedSequence : null,
  };
}

export function startPinMutationLifecycle(lifecycle: PinMutationLifecycle): {
  readonly lifecycle: PinMutationLifecycle;
  readonly requestVersion: number;
  readonly isPinned: boolean;
} | null {
  if (
    lifecycle.inFlightRequestVersion !== null ||
    lifecycle.desiredPinned === lifecycle.appliedPinned
  ) {
    return null;
  }
  return {
    lifecycle: {
      ...lifecycle,
      inFlightRequestVersion: lifecycle.latestRequestVersion,
      inFlightPinned: lifecycle.desiredPinned,
      latestSettled: false,
      settlementSequence: null,
    },
    requestVersion: lifecycle.latestRequestVersion,
    isPinned: lifecycle.desiredPinned,
  };
}

export function succeedPinMutationLifecycle(input: {
  readonly lifecycle: PinMutationLifecycle;
  readonly requestVersion: number;
  readonly isPinned: boolean;
  readonly resultSequence: number;
}): PinMutationLifecycle | null {
  if (input.lifecycle.inFlightRequestVersion !== input.requestVersion) {
    return null;
  }
  if (input.lifecycle.inFlightPinned !== input.isPinned) {
    return null;
  }
  const resultSupersedesAppliedState =
    input.lifecycle.appliedSequence === null ||
    input.resultSequence > input.lifecycle.appliedSequence;
  const appliedPinned = resultSupersedesAppliedState
    ? input.isPinned
    : input.lifecycle.appliedPinned;
  const appliedSequence = resultSupersedesAppliedState
    ? input.resultSequence
    : input.lifecycle.appliedSequence;
  const observationSupersedesResult =
    input.lifecycle.appliedSequence !== null &&
    input.resultSequence <= input.lifecycle.appliedSequence;
  const hasNewerRequest = input.lifecycle.latestRequestVersion > input.requestVersion;
  const desiredPinned =
    observationSupersedesResult && !hasNewerRequest ? appliedPinned : input.lifecycle.desiredPinned;
  const latestSettled = desiredPinned === appliedPinned;
  return {
    ...input.lifecycle,
    appliedPinned,
    appliedSequence,
    desiredPinned,
    inFlightRequestVersion: null,
    inFlightPinned: null,
    latestSettled,
    settlementSequence: latestSettled ? appliedSequence : null,
  };
}

export function failPinMutationLifecycle(input: {
  readonly lifecycle: PinMutationLifecycle;
  readonly requestVersion: number;
}): {
  readonly lifecycle: PinMutationLifecycle;
  readonly isLatestFailure: boolean;
} | null {
  if (input.lifecycle.inFlightRequestVersion !== input.requestVersion) {
    return null;
  }
  const isLatestFailure = input.lifecycle.latestRequestVersion === input.requestVersion;
  const desiredPinned = isLatestFailure
    ? input.lifecycle.appliedPinned
    : input.lifecycle.desiredPinned;
  const latestSettled = desiredPinned === input.lifecycle.appliedPinned;
  return {
    lifecycle: {
      ...input.lifecycle,
      desiredPinned,
      inFlightRequestVersion: null,
      inFlightPinned: null,
      latestSettled,
      settlementSequence: latestSettled ? input.lifecycle.appliedSequence : null,
    },
    isLatestFailure,
  };
}

export function canSettlePinMutationLifecycle(input: {
  readonly lifecycle: PinMutationLifecycle;
  readonly serverPinned: boolean;
  readonly serverSequence?: number | undefined;
}): boolean {
  if (
    input.lifecycle.inFlightRequestVersion !== null ||
    !input.lifecycle.latestSettled ||
    input.serverPinned !== input.lifecycle.desiredPinned
  ) {
    return false;
  }
  if (input.lifecycle.settlementSequence === null) {
    return true;
  }
  return (
    input.serverSequence !== undefined && input.serverSequence >= input.lifecycle.settlementSequence
  );
}

// Drop optimistic entries once the server agrees or the item disappears. Entries whose
// server value still disagrees remain pending so the optimistic UI does not flicker backward.
export function reconcileOptimisticPinState<TId>(input: {
  readonly optimisticPinnedStateById: ReadonlyMap<TId, boolean>;
  readonly serverPinnedStateById: ReadonlyMap<TId, boolean>;
}): {
  readonly optimisticPinnedStateById: ReadonlyMap<TId, boolean>;
  readonly settledIds: readonly TId[];
} {
  let next: Map<TId, boolean> | null = null;
  const settledIds: TId[] = [];
  for (const [id, desiredPinned] of input.optimisticPinnedStateById) {
    const serverPinned = input.serverPinnedStateById.get(id);
    if (serverPinned !== undefined && serverPinned !== desiredPinned) {
      continue;
    }
    next ??= new Map(input.optimisticPinnedStateById);
    next.delete(id);
    settledIds.push(id);
  }
  return {
    optimisticPinnedStateById: next ?? input.optimisticPinnedStateById,
    settledIds,
  };
}
