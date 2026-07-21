import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("073_ProjectionProjectsArchivedAt", (it) => {
  it.effect("adds nullable archive state without changing pre-073 project data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root,
          default_model_selection_json, scripts_json, is_pinned,
          created_at, updated_at, deleted_at
        ) VALUES (
          'pre-073-project', 'project', 'Pre-073 project', 'C:\\work\\pre-073',
          NULL, '[]', 1,
          '2026-07-20T10:00:00.000Z', '2026-07-20T10:00:00.000Z', NULL
        )
      `;

      const beforeColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_projects')
      `;
      assert.notInclude(
        beforeColumns.map((row) => row.name),
        "archived_at",
      );

      yield* runMigrations();
      const rows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly archivedAt: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          archived_at AS "archivedAt"
        FROM projection_projects
        WHERE project_id = 'pre-073-project'
      `;
      assert.deepEqual(rows, [
        { projectId: "pre-073-project", title: "Pre-073 project", archivedAt: null },
      ]);

      yield* sql`
        UPDATE projection_projects
        SET archived_at = '2026-07-20T11:00:00.000Z'
        WHERE project_id = 'pre-073-project'
      `;
      yield* runMigrations();
      const archivedRows = yield* sql<{ readonly archivedAt: string | null }>`
        SELECT archived_at AS "archivedAt"
        FROM projection_projects
        WHERE project_id = 'pre-073-project'
      `;
      assert.equal(archivedRows[0]?.archivedAt, "2026-07-20T11:00:00.000Z");
    }),
  );
});
