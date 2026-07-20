import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { ServerConfigStreamEvent } from "./server";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts git.preparePullRequestThread requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-pr-1",
      body: {
        _tag: WS_METHODS.gitPreparePullRequestThread,
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.gitPreparePullRequestThread);
  }),
);

it.effect("accepts project script discovery requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-project-scripts-1",
      body: {
        _tag: WS_METHODS.projectsDiscoverScripts,
        cwd: "/repo",
        depth: 1,
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.projectsDiscoverScripts);
  }),
);

it.effect("accepts bounded workspace git-state requests and clone defaults", () =>
  Effect.gen(function* () {
    const list = yield* decode(WebSocketRequest, {
      id: "req-workspace-list",
      body: {
        _tag: WS_METHODS.workspaceListGitStates,
        projectIds: ["project-1", "project-1"],
      },
    });
    const clone = yield* decode(WebSocketRequest, {
      id: "req-workspace-clone",
      body: {
        _tag: WS_METHODS.workspaceCloneRepository,
        cloneId: "clone-1",
        url: "https://github.com/example/repo.git",
        targetPath: "/repos/repo",
      },
    });

    assert.strictEqual(list.body._tag, WS_METHODS.workspaceListGitStates);
    assert.strictEqual(clone.body._tag, WS_METHODS.workspaceCloneRepository);
    if (clone.body._tag === WS_METHODS.workspaceCloneRepository) {
      assert.strictEqual(clone.body.createProject, true);
      assert.strictEqual(clone.body.createParentDirectories, true);
    }
  }),
);

it.effect("accepts the zero-input archived-project summary request", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-workspace-archived",
      body: {
        _tag: WS_METHODS.workspaceListArchivedProjects,
      },
    });

    assert.strictEqual(parsed.body._tag, WS_METHODS.workspaceListArchivedProjects);
  }),
);

it.effect("accepts automation create requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-automation-create-1",
      body: {
        _tag: WS_METHODS.automationCreate,
        name: "Nightly maintenance",
        projectId: "project-1",
        prompt: "Check stale dependencies.",
        schedule: { type: "manual" },
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.automationCreate);
  }),
);

it.effect("accepts automation run action requests", () =>
  Effect.gen(function* () {
    const markRead = yield* decode(WebSocketRequest, {
      id: "req-automation-read-1",
      body: {
        _tag: WS_METHODS.automationMarkRunRead,
        runId: "run-1",
        unread: false,
      },
    });
    const archive = yield* decode(WebSocketRequest, {
      id: "req-automation-archive-1",
      body: {
        _tag: WS_METHODS.automationArchiveRun,
        runId: "run-1",
        archived: true,
      },
    });

    assert.strictEqual(markRead.body._tag, WS_METHODS.automationMarkRunRead);
    assert.strictEqual(archive.body._tag, WS_METHODS.automationArchiveRun);
  }),
);

it.effect("accepts typed websocket push envelopes with sequence", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.type, "push");
    assert.strictEqual(parsed.sequence, 1);
    assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
  }),
);

it.effect("accepts git.actionProgress push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.gitActionProgress,
      data: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        kind: "phase_started",
        phase: "commit",
        label: "Committing...",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.gitActionProgress);
  }),
);

it.effect("accepts workspace.cloneProgress push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 5,
      channel: WS_CHANNELS.workspaceCloneProgress,
      data: {
        _tag: "clone_progress",
        snapshot: {
          cloneId: "clone-1",
          status: "running",
          stage: "cloning",
          percent: 50,
          message: "Receiving objects: 50%",
          result: null,
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
        phase: "Receiving objects",
        completed: 5,
        total: 10,
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }
    assert.strictEqual(parsed.channel, WS_CHANNELS.workspaceCloneProgress);
  }),
);

it.effect("accepts automation.event push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.automationEvent,
      data: {
        type: "definition-deleted",
        automationId: "automation-1",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.automationEvent);
  }),
);

it.effect("rejects push envelopes when channel payload does not match the channel schema", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WsResponse, {
        type: "push",
        sequence: 2,
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: {
          cwd: "/tmp/workspace",
          projectName: "workspace",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts optional editor availability on server config update events", () =>
  Effect.gen(function* () {
    const withEditors = yield* decode(ServerConfigStreamEvent, {
      type: "configUpdated",
      payload: {
        issues: [],
        providers: [],
        availableEditors: ["vscode", "cursor"],
      },
    });
    const legacy = yield* decode(ServerConfigStreamEvent, {
      type: "configUpdated",
      payload: { issues: [], providers: [] },
    });

    assert.strictEqual(withEditors.type, "configUpdated");
    assert.strictEqual(legacy.type, "configUpdated");
  }),
);

it.effect("rejects unknown editor ids on server config update events", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(ServerConfigStreamEvent, {
        type: "configUpdated",
        payload: {
          issues: [],
          providers: [],
          availableEditors: ["not-an-editor"],
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
