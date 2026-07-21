import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationShellStreamEvent,
} from "./orchestration";

const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeProject = Schema.decodeUnknownEffect(OrchestrationProject);
const decodeShellEvent = Schema.decodeUnknownEffect(OrchestrationShellStreamEvent);

it.effect("decodes project archive and unarchive commands/events", () =>
  Effect.gen(function* () {
    const archive = yield* decodeCommand({
      type: "project.archive",
      commandId: "command-archive",
      projectId: "project-archive",
      createdAt: "2026-07-20T12:00:00.000Z",
    });
    const unarchive = yield* decodeCommand({
      type: "project.unarchive",
      commandId: "command-unarchive",
      projectId: "project-archive",
      createdAt: "2026-07-20T13:00:00.000Z",
    });
    assert.equal(archive.type, "project.archive");
    assert.equal(unarchive.type, "project.unarchive");

    const archivedEvent = yield* decodeEvent({
      sequence: 10,
      eventId: "event-archive",
      aggregateKind: "project",
      aggregateId: "project-archive",
      type: "project.archived",
      occurredAt: "2026-07-20T12:00:00.000Z",
      commandId: "command-archive",
      causationEventId: null,
      correlationId: "command-archive",
      metadata: {},
      payload: {
        projectId: "project-archive",
        archivedAt: "2026-07-20T12:00:00.000Z",
      },
    });
    const unarchivedEvent = yield* decodeEvent({
      sequence: 11,
      eventId: "event-unarchive",
      aggregateKind: "project",
      aggregateId: "project-archive",
      type: "project.unarchived",
      occurredAt: "2026-07-20T13:00:00.000Z",
      commandId: "command-unarchive",
      causationEventId: null,
      correlationId: "command-unarchive",
      metadata: {},
      payload: {
        projectId: "project-archive",
        unarchivedAt: "2026-07-20T13:00:00.000Z",
      },
    });
    assert.equal(archivedEvent.type, "project.archived");
    assert.equal(unarchivedEvent.type, "project.unarchived");
  }),
);

it.effect("defaults archivedAt for historical project snapshots", () =>
  Effect.gen(function* () {
    const project = yield* decodeProject({
      id: "legacy-project",
      title: "Legacy project",
      workspaceRoot: "C:\\work\\legacy",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    assert.equal(project.archivedAt, null);
  }),
);

it.effect("decodes archive visibility as snapshot invalidation, not a deletion tombstone", () =>
  Effect.gen(function* () {
    const event = yield* decodeShellEvent({
      kind: "snapshot-invalidated",
      sequence: 12,
      reason: "project-visibility-changed",
    });
    assert.equal(event.kind, "snapshot-invalidated");
    assert.notEqual(event.kind, "project-removed");
  }),
);
