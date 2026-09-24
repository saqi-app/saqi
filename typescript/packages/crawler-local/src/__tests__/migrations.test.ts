import { hash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { Ledger } from "../persistence/ledger.js";
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
} from "../persistence/migrations.js";
import { currentSource } from "../source-adapter/index.js";
import { migrateHistoricalFixture } from "./support/historical-migration-engine.js";
import { initializeLegacyLedgerSchema } from "./support/legacy-ledger-schema.js";
import { trackedMkdtempSync as mkdtempSync } from "./support/tracked-test-root.js";

const migrate = (database: Database.Database): number =>
  migrateHistoricalFixture(database);

describe("ledger schema migrations", () => {
  test("schema 42 preserves published translation lineage and removes its one-to-one table", () => {
    const database = new Database(":memory:");
    try {
      initializeLegacyLedgerSchema(database, 41);
      database.pragma("foreign_keys = ON");
      const translation = "a".repeat(64);
      const publication = "b".repeat(64);
      const bindingId = "c".repeat(64);
      const artifact = "d".repeat(64);
      const insertWork = database.prepare(`INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version,
        implementation_version, state, available_at, created_at, updated_at
      ) VALUES(?, ?, '{}', ?, 'input@1', 'crawler@1', 'succeeded', 1, 1, 1)`);
      insertWork.run(translation, "poem-enrichment-sol", "e".repeat(64));
      insertWork.run(
        publication,
        "corpus-publication-enrichment-v2",
        "f".repeat(64),
      );
      database
        .prepare(
          `INSERT INTO canonical_translation_binding(
        translation_work_key, binding_id, binding_json, poem_id,
        source_revision_id, line_nfc_hash, prompt_material_hash, created_at
      ) VALUES(?, ?, '{}', 'poem-1', 'revision-1', ?, ?, 2)`,
        )
        .run(translation, bindingId, "1".repeat(64), "2".repeat(64));
      database
        .prepare(
          `INSERT INTO publication_derivation(
        translation_work_key, binding_id, publication_work_key,
        approved_artifact_hash, created_at
      ) VALUES(?, ?, ?, ?, 3)`,
        )
        .run(translation, bindingId, publication, artifact);

      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        database
          .prepare(
            `SELECT translation_work_key, binding_id,
        publication_work_key, approved_artifact_hash, publication_created_at
        FROM canonical_translation_binding`,
          )
          .get(),
      ).toEqual({
        translation_work_key: translation,
        binding_id: bindingId,
        publication_work_key: publication,
        approved_artifact_hash: artifact,
        publication_created_at: 3,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'publication_derivation'`,
          )
          .get(),
      ).toBeUndefined();
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(() =>
        database
          .prepare(
            `UPDATE canonical_translation_binding
        SET approved_artifact_hash = ? WHERE translation_work_key = ?`,
          )
          .run("3".repeat(64), translation),
      ).toThrow("CANONICAL_TRANSLATION_BINDING_IMMUTABLE");
      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  test("schema 41 preserves populated fanout priority order and removes its table", () => {
    const database = new Database(":memory:");
    try {
      initializeLegacyLedgerSchema(database, 40);
      const insertWork = database.prepare(`INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version,
        implementation_version, state, available_at, created_at, updated_at
      ) VALUES(?, 'fanout-succeeded-sol', '{}', ?, 'input@1',
        'crawler@1', 'pending', 5, 1, 1)`);
      const first = "a".repeat(64);
      const second = "b".repeat(64);
      insertWork.run(first, "c".repeat(64));
      insertWork.run(second, "d".repeat(64));
      database
        .prepare(
          `INSERT INTO fanout_priority_hint(
          work_key, kind, state, available_at, created_at, updated_at
        ) VALUES(?, 'fanout-succeeded-sol', 'pending', 5, ?, ?)`,
        )
        .run(first, 2, 3);
      database
        .prepare(
          `INSERT INTO fanout_priority_hint(
          work_key, kind, state, available_at, created_at, updated_at
        ) VALUES(?, 'fanout-succeeded-sol', 'pending', 5, ?, ?)`,
        )
        .run(second, 4, 4);

      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        database
          .prepare(
            `SELECT work_key, priority_hint_created_at AS created_at,
                   priority_hint_updated_at AS updated_at
            FROM work_item WHERE priority_hint_created_at IS NOT NULL
            ORDER BY priority_hint_created_at, work_key`,
          )
          .all(),
      ).toEqual([
        { work_key: first, created_at: 2, updated_at: 3 },
        { work_key: second, created_at: 4, updated_at: 4 },
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'fanout_priority_hint'",
          )
          .get(),
      ).toBeUndefined();
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  test("schema 38 retires obsolete scheduler archive without touching active state", () => {
    const database = new Database(":memory:");
    try {
      initializeLegacyLedgerSchema(database, 37);
      database
        .prepare(
          `INSERT INTO retired_scheduler_state(
            state_key, state_json, state_digest, updated_at, retired_at,
            authority_state_digest
          ) VALUES(?, '{}', ?, 1, 2, ?)`,
        )
        .run("provider:agy", "a".repeat(64), "b".repeat(64));
      database
        .prepare(
          "INSERT INTO monitor_progress_history(singleton, payload, updated_at) VALUES(1, ?, 1)",
        )
        .run(Buffer.from('{"schemaVersion":1,"samples":[]}'));
      database
        .prepare(
          `INSERT INTO scheduler_state(
            state_key, state_json, state_digest, updated_at
          ) VALUES('provider-v10:sol', '{}', ?, 3)`,
        )
        .run("c".repeat(64));

      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'retired_scheduler_state'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'monitor_progress_history'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT state_key FROM scheduler_state").all(),
      ).toEqual([{ state_key: "provider-v10:sol" }]);
      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  test("schema 37 removes redundant counters and retains work state accounting", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT; INSERT INTO local_schema VALUES(1, 0);`);
      for (const migration of MIGRATIONS) {
        if (migration.version > 36) continue;
        database.exec(migration.statements);
        database
          .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
          .run(migration.version);
      }
      const configured = currentSource();
      database
        .prepare(
          "INSERT INTO local_source_identity(singleton, source_name, source_origin) VALUES(1, ?, ?)",
        )
        .run(configured.name, configured.origin);
      const insert = database.prepare(`INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version,
        implementation_version, state, available_at, created_at, updated_at
      ) VALUES(?, ?, '{}', ?, 'input@1', 'crawler@1', ?, 1, 1, 1)`);
      insert.run("a".repeat(64), "kind-a", "b".repeat(64), "pending");
      insert.run("c".repeat(64), "kind-b", "d".repeat(64), "pending");
      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table'
             AND name IN ('ledger_state_count','ledger_kind_state_count',
                          'ledger_error_count','ledger_kind_error_count',
                          'ledger_kind_success_clock')`,
          )
          .all(),
      ).toEqual([]);
      const counts = () =>
        database
          .prepare(
            `SELECT state, SUM(item_count) AS item_count
             FROM ledger_profile_state_count GROUP BY state ORDER BY state`,
          )
          .all();
      expect(counts()).toEqual([{ item_count: 2, state: "pending" }]);
      insert.run("e".repeat(64), "kind-a", "f".repeat(64), "pending");
      database
        .prepare("UPDATE work_item SET state = 'succeeded' WHERE work_key = ?")
        .run("c".repeat(64));
      expect(counts()).toEqual([
        { item_count: 2, state: "pending" },
        { item_count: 1, state: "succeeded" },
      ]);
      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  test("reconciliation due lookup uses the unknown-state time index", () => {
    const database = new Database(":memory:");
    try {
      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
      const plan = database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT operation_key FROM paid_operation_reconciliation WHERE state = 'unknown' AND next_reconcile_at <= ?",
        )
        .all(100) as { detail: string }[];
      expect(
        plan.some((step) =>
          step.detail.includes("paid_operation_reconciliation_due"),
        ),
      ).toBe(true);
      expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });
  test("schema 32 adds a ready range index and preserves priority paging on upgrade", () => {
    const database = new Database(":memory:");
    database.exec(
      "CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT; INSERT INTO local_schema VALUES(1, 0)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.version > 31) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    const configured = currentSource();
    database
      .prepare(
        "INSERT INTO local_source_identity(singleton, source_name, source_origin) VALUES(1, ?, ?)",
      )
      .run(configured.name, configured.origin);
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('work_item_fanout_resolution_ready', 'work_item_fanout_resolution_pending') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "work_item_fanout_resolution_pending" },
      { name: "work_item_fanout_resolution_ready" },
    ]);
    database.close();
  });
  test("seeds and advances the author metadata revision from schema 21", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 21) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    database
      .prepare(
        `INSERT INTO source_author_metadata(
           source_name, author_href, author_name_arabic,
           refresh_generation, observed_at
         ) VALUES('source', ?, ?, ?, ?)`,
      )
      .run("https://source.invalid/cat-test", "شاعر", "generation-a", 1);
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'fanout_priority_hint'`,
        )
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index' AND name = 'work_item_fanout_priority_schedule'`,
        )
        .get(),
    ).toEqual({ name: "work_item_fanout_priority_schedule" });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index'
             AND name = 'work_item_fanout_resolution_pending'`,
        )
        .get(),
    ).toEqual({ name: "work_item_fanout_resolution_pending" });
    expect(
      database
        .prepare(
          "SELECT metadata_revision AS revision FROM local_source_identity WHERE singleton = 1",
        )
        .get(),
    ).toEqual({ revision: 1 });
    database
      .prepare(
        `UPDATE source_author_metadata SET author_name_arabic = ?
         WHERE source_name = 'source' AND author_href = ?`,
      )
      .run("شاعر محدث", "https://source.invalid/cat-test");
    expect(
      database
        .prepare(
          "SELECT metadata_revision AS revision FROM local_source_identity WHERE singleton = 1",
        )
        .get(),
    ).toEqual({ revision: 2 });
    database.close();
  });

  test("adds version-nineteen binding metadata without rebuilding work items", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 18) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    database
      .prepare(
        `INSERT INTO work_item(
           work_key, kind, input_json, input_hash, schema_version,
           implementation_version, state, available_at, created_at, updated_at
         ) VALUES(?, 'poem-enrichment-sol', '{}', ?, 'input@1', 'sol-5.6',
                  'succeeded', 1, 1, 1)`,
      )
      .run("a".repeat(64), "b".repeat(64));

    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database.prepare(`SELECT work_key, kind FROM work_item`).get(),
    ).toEqual({ kind: "poem-enrichment-sol", work_key: "a".repeat(64) });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table'
             AND name IN ('canonical_translation_binding', 'publication_derivation')
           ORDER BY name`,
        )
        .all(),
    ).toEqual([{ name: "canonical_translation_binding" }]);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'fanout_detail_material'`,
        )
        .get(),
    ).toEqual({ name: "fanout_detail_material" });
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  test("initialization and repeated migration are idempotent", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "saqi-migrate-")),
      "ledger.sqlite3",
    );
    const ledger = Ledger.open(path);
    ledger.close();
    const database = new Database(path);
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    const row = database.prepare("SELECT version FROM local_schema").get() as {
      version: number;
    };
    expect(row.version).toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  test("retires obsolete provider scheduler keys only behind valid Sol authority", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 27) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    const authority = schedulerState(10);
    const authorityDigest = hash("sha256", authority, "hex");
    const obsolete = schedulerState(9);
    const obsoleteDigest = hash("sha256", obsolete, "hex");
    const insert = database.prepare(
      `INSERT INTO scheduler_state(
         state_key, state_json, state_digest, updated_at
       ) VALUES(?, ?, ?, ?)`,
    );
    insert.run("provider-v10:sol", authority, authorityDigest, 10);
    for (const key of [
      "provider-v10:agy",
      "provider-v10:claude",
      "provider:agy",
      "provider:claude",
    ])
      insert.run(key, obsolete, obsoleteDigest, 5);
    insert.run("unrelated-state", "{}", "f".repeat(64), 1);

    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare(
          `SELECT state_key FROM scheduler_state
           ORDER BY state_key`,
        )
        .all(),
    ).toEqual([
      { state_key: "provider-v10:sol" },
      { state_key: "unrelated-state" },
    ]);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'retired_scheduler_state'`,
        )
        .get(),
    ).toBeUndefined();
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  test("preserves obsolete scheduler keys when Sol authority is invalid", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 27) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    const serialized = schedulerState(10);
    const insert = database.prepare(
      `INSERT INTO scheduler_state(
         state_key, state_json, state_digest, updated_at
       ) VALUES(?, ?, ?, 1)`,
    );
    insert.run("provider-v10:sol", serialized, "0".repeat(64));
    insert.run("provider-v10:agy", serialized, "1".repeat(64));

    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM scheduler_state").get(),
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'retired_scheduler_state'`,
        )
        .get(),
    ).toBeUndefined();
    database.close();
  });

  test("keeps historical Sol milestone coverage partial without a startup backfill", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 26) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    const historicalKey = "a".repeat(64);
    const liveKey = "c".repeat(64);
    const insertWork = database.prepare(
      `INSERT INTO work_item(
          work_key, kind, input_json, input_hash, schema_version,
          implementation_version, state, available_at, created_at, updated_at
        ) VALUES(?, 'poem-enrichment-sol', '{}', ?, 'input@1', 'sol-v1',
                 'succeeded', 1, 1, 1)`,
    );
    insertWork.run(historicalKey, "b".repeat(64));
    insertWork.run(liveKey, "d".repeat(64));
    database
      .prepare(
        `INSERT INTO work_event(
          event_id, work_key, event_type, payload_json, created_at
        ) VALUES(?, ?, ?, ?, ?)`,
      )
      .run("old-success", historicalKey, "succeeded", "{}", 10);
    database
      .prepare(
        `INSERT INTO work_event(
          event_id, work_key, event_type, payload_json, created_at
        ) VALUES(?, ?, ?, ?, ?)`,
      )
      .run("old-bad-import", liveKey, "imported", '{"unexpected":true}', 12);

    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM sol_poem_milestone")
        .get(),
    ).toEqual({
      count: 0,
    });
    expect(
      database
        .prepare(
          "SELECT sol_milestone_history_complete, sol_milestone_high_watermark FROM local_schema WHERE singleton = 1",
        )
        .get(),
    ).toEqual({
      sol_milestone_history_complete: 0,
      sol_milestone_high_watermark: 2,
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sol_poem_milestone_backfill'",
        )
        .get(),
    ).toBeUndefined();
    const insertEvent = database.prepare(
      `INSERT INTO work_event(
        event_id, work_key, event_type, payload_json, created_at
      ) VALUES(?, ?, ?, ?, ?)`,
    );
    insertEvent.run("new-success", liveKey, "succeeded", "{}", 20);
    insertEvent.run(
      "bad-import",
      liveKey,
      "imported",
      '{"unexpected":true}',
      30,
    );
    insertEvent.run(
      "good-import",
      liveKey,
      "imported",
      JSON.stringify({ artifactHash: "c".repeat(64) }),
      40,
    );
    expect(
      database
        .prepare(
          `SELECT milestone, completed_at FROM sol_poem_milestone ORDER BY milestone`,
        )
        .all(),
    ).toEqual([
      { completed_at: 20, milestone: "generated" },
      { completed_at: 40, milestone: "published" },
    ]);
    const ledger = new Ledger(database);
    expect(
      ledger.poemThroughput(
        {
          implementationVersion: "sol-v1",
          schemaVersion: "input@1",
        },
        50,
      ).coverage,
    ).toEqual({
      backfillComplete: false,
      highWatermark: 2,
    });
    expect(
      database
        .prepare(
          `SELECT work_key, milestone, completed_at
             FROM sol_poem_milestone ORDER BY completed_at`,
        )
        .all(),
    ).toEqual([
      { completed_at: 20, milestone: "generated", work_key: liveKey },
      { completed_at: 40, milestone: "published", work_key: liveKey },
    ]);
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM sol_poem_milestone
          WHERE implementation_version = ? AND schema_version = ?
            AND milestone = ? AND completed_at > ? AND completed_at <= ?`,
      )
      .all("sol-v1", "input@1", "generated", 0, 100);
    expect(JSON.stringify(plan)).toContain("sol_poem_milestone_profile_time");
    ledger.close();
  });

  test("preserves completed Sol milestone coverage while dropping its backfill table", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      INSERT INTO local_schema VALUES(1, 39);
      CREATE TABLE sol_poem_milestone_backfill(
        event_type TEXT PRIMARY KEY,
        cursor_sequence INTEGER NOT NULL,
        high_watermark INTEGER NOT NULL,
        completed_at INTEGER
      ) STRICT;
      INSERT INTO sol_poem_milestone_backfill VALUES
        ('succeeded', 7, 7, 100), ('imported', 7, 7, 101);
    `);
    const migration = MIGRATIONS.find(({ version }) => version === 40);
    if (!migration) throw new Error("Expected schema 40 migration");
    database.exec(migration.statements);
    expect(
      database
        .prepare(
          `SELECT sol_milestone_history_complete, sol_milestone_high_watermark
             FROM local_schema WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({
      sol_milestone_history_complete: 1,
      sol_milestone_high_watermark: 7,
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sol_poem_milestone_backfill'",
        )
        .get(),
    ).toBeUndefined();
    database.close();
  });

  test("backfills version-eighteen status aggregates and maintains them", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 17) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    const insertWork = database.prepare(`INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version,
        implementation_version, state, available_at, last_error_code,
        created_at, updated_at
      ) VALUES(?, 'poem-enrichment-sol', '{}', ?, 'input@1', 'sol-v1',
               ?, ?, ?, 1, ?)`);
    insertWork.run("a".repeat(64), "b".repeat(64), "succeeded", 1, null, 2);
    insertWork.run(
      "c".repeat(64),
      "d".repeat(64),
      "retry_wait",
      100,
      "SOURCE_TIMEOUT",
      3,
    );
    const insertEvent = database.prepare(`INSERT INTO work_event(
        event_id, work_key, event_type, payload_json, created_at
      ) VALUES(?, ?, ?, ?, ?)`);
    insertEvent.run("success", "a".repeat(64), "succeeded", "{}", 2);
    insertEvent.run(
      "failure",
      "c".repeat(64),
      "retry_wait",
      JSON.stringify({ errorCode: "SOURCE_TIMEOUT" }),
      3,
    );
    database
      .prepare(
        `INSERT INTO paid_operation_reconciliation(
        operation_key, work_key, attempt_id, state, next_reconcile_at,
        first_observed_at, updated_at
      ) VALUES(?, ?, 'attempt-1', 'unknown', 10, 4, 4)`,
      )
      .run("e".repeat(64), "c".repeat(64));

    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare(
          `SELECT state, SUM(item_count) AS item_count
           FROM ledger_profile_state_count GROUP BY state ORDER BY state`,
        )
        .all(),
    ).toEqual([
      { item_count: 1, state: "retry_wait" },
      { item_count: 1, state: "succeeded" },
    ]);
    expect(
      database
        .prepare(
          `SELECT error_code, item_count FROM ledger_profile_error_count`,
        )
        .get(),
    ).toEqual({ error_code: "SOURCE_TIMEOUT", item_count: 1 });
    expect(
      database
        .prepare(
          `SELECT available_at, item_count FROM ledger_profile_availability_count`,
        )
        .get(),
    ).toEqual({ available_at: 100, item_count: 1 });

    database
      .prepare(
        `UPDATE work_item SET state = 'succeeded', last_error_code = NULL,
          updated_at = 5 WHERE work_key = ?`,
      )
      .run("c".repeat(64));
    database
      .prepare(
        `UPDATE paid_operation_reconciliation
         SET state = 'reconciled', last_reconciled_at = 5, updated_at = 5
         WHERE operation_key = ?`,
      )
      .run("e".repeat(64));
    expect(
      database.prepare(`SELECT * FROM ledger_profile_error_count`).all(),
    ).toEqual([]);
    expect(
      database.prepare(`SELECT * FROM ledger_profile_availability_count`).all(),
    ).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT state, COUNT(*) AS item_count
                  FROM paid_operation_reconciliation GROUP BY state`,
        )
        .all(),
    ).toEqual([{ item_count: 1, state: "reconciled" }]);
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  test("upgrades a mixed-profile version-twelve ledger with a targeted recovery index", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 12) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    const insert = database.prepare(`INSERT INTO work_item(
      work_key, kind, input_json, input_hash, schema_version,
      implementation_version, state, available_at, last_error_code,
      created_at, updated_at
    ) VALUES(?, 'poem-enrichment-sol', ?, ?, 'input@1', ?, 'pending', 1, ?, 1, ?)`);
    for (const [digit, implementationVersion, errorCode, updatedAt] of [
      ["1", "sol-current", "CODEX_OPERATION_OUTCOME_UNKNOWN", 10],
      ["2", "sol-obsolete", "CODEX_OPERATION_OUTCOME_UNKNOWN", 9],
      ["3", "sol-current", "CODEX_RATE_LIMITED", 8],
    ] as const) {
      insert.run(
        digit.repeat(64),
        JSON.stringify({ digit }),
        digit.repeat(64),
        implementationVersion,
        errorCode,
        updatedAt,
      );
    }

    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare(
          `SELECT work_key FROM work_item INDEXED BY work_item_unknown_recovery
           WHERE state IN ('pending','retry_wait','quota_wait','dead_letter')
             AND kind = 'poem-enrichment-sol'
             AND implementation_version = 'sol-current'
             AND schema_version = 'input@1'
             AND last_error_code = 'CODEX_OPERATION_OUTCOME_UNKNOWN'
             AND updated_at <= 20
             AND (state = 'dead_letter' OR available_at <= 20)
           ORDER BY updated_at, created_at, work_key`,
        )
        .all(),
    ).toEqual([{ work_key: "1".repeat(64) }]);
    const sql = database
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'work_item_unknown_recovery'",
      )
      .get()?.sql;
    expect(sql).toContain(
      "last_error_code = 'CODEX_OPERATION_OUTCOME_UNKNOWN'",
    );
    expect(sql).not.toContain("last_error_code IS NOT NULL");
    database.close();
  });

  test("converges two pre-opened migration connections after one advances the schema", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "saqi-migrate-concurrent-")),
      "ledger.sqlite3",
    );
    const bootstrap = new Database(path);
    bootstrap.exec(`
      CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 12) continue;
      bootstrap.exec(migration.statements);
      bootstrap
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    bootstrap.close();

    const first = new Database(path);
    const second = new Database(path);
    first.pragma("busy_timeout = 5000");
    second.pragma("busy_timeout = 5000");
    expect(migrate(first)).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrate(second)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      second
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'work_item_unknown_recovery'",
        )
        .get(),
    ).toEqual({ count: 1 });
    first.close();
    second.close();
  });

  test("rolls back version thirteen when its index cannot be installed", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 12) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ? WHERE singleton = 1")
        .run(migration.version);
    }
    database.exec(
      "CREATE INDEX work_item_unknown_recovery ON work_item(work_key)",
    );

    expect(() => migrate(database)).toThrow(/already exists/u);
    expect(
      database
        .prepare("SELECT version FROM local_schema WHERE singleton = 1")
        .get(),
    ).toEqual({ version: 12 });
    expect(
      database
        .prepare<[], { sql: string }>(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'work_item_unknown_recovery'",
        )
        .get()?.sql,
    ).toBe("CREATE INDEX work_item_unknown_recovery ON work_item(work_key)");
    database.close();
  });

  test("upgrades a version-one database without losing work", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "saqi-migrate-")),
      "ledger.sqlite3",
    );
    const database = new Database(path);
    database.exec(`
      CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    database.exec(MIGRATIONS[0]!.statements);
    database.prepare("UPDATE local_schema SET version = 1").run();
    database
      .prepare(
        `INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version, implementation_version,
        available_at, created_at, updated_at
      ) VALUES(?, 'test', '{}', ?, 'v1', 'v1', 1, 1, 1)`,
      )
      .run("a".repeat(64), "b".repeat(64));
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM work_item").get(),
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM checkpoint").get(),
    ).toEqual({ count: 0 });
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];
    expect(indexes.map(({ name }) => name)).toContain("checkpoint_latest_kind");
    expect(indexes.map(({ name }) => name)).toContain(
      "work_item_expired_lease",
    );
    expect(indexes.map(({ name }) => name)).toContain(
      "work_event_completed_scan",
    );
    expect(indexes.map(({ name }) => name)).toContain("work_item_error_code");
    expect(indexes.map(({ name }) => name)).toContain(
      "work_item_ready_priority",
    );
    expect(indexes.map(({ name }) => name)).toContain(
      "work_item_unknown_recovery",
    );
    expect(indexes.map(({ name }) => name)).toContain(
      "work_item_profile_state",
    );
    expect(indexes.map(({ name }) => name)).toContain(
      "work_item_kind_error_code",
    );
    expect(
      database
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'poem_identity'",
        )
        .get()?.name,
    ).toBe("poem_identity");
    const claimPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT work_key FROM work_item INDEXED BY work_item_ready_priority
         WHERE state IN ('pending','retry_wait','quota_wait') AND available_at <= ?
           AND kind IN (?) AND implementation_version = ? AND schema_version = ?
         ORDER BY priority DESC, created_at, work_key LIMIT 1`,
      )
      .all(1, "test", "v1", "v1") as { detail: string }[];
    expect(
      claimPlan.some(({ detail }) =>
        detail.includes("work_item_ready_priority"),
      ),
    ).toBe(true);
    expect(
      claimPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")),
    ).toBe(false);
    const recoveryPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT work_key FROM work_item INDEXED BY work_item_unknown_recovery
         WHERE state IN ('pending','retry_wait','quota_wait','dead_letter')
           AND kind = ?
           AND implementation_version = ? AND schema_version = ?
           AND last_error_code = 'CODEX_OPERATION_OUTCOME_UNKNOWN'
           AND updated_at <= ?
           AND (state = 'dead_letter' OR available_at <= ?)
         ORDER BY updated_at, created_at, work_key LIMIT 1`,
      )
      .all("test", "v1", "v1", 1, 1) as {
      detail: string;
    }[];
    expect(
      recoveryPlan.some(({ detail }) =>
        detail.includes("work_item_unknown_recovery"),
      ),
    ).toBe(true);
    expect(
      recoveryPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")),
    ).toBe(false);
    const profilePlan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT state, COUNT(*) AS count
         FROM work_item INDEXED BY work_item_profile_state
         WHERE kind = ? AND implementation_version = ? AND schema_version = ?
         GROUP BY state`,
      )
      .all("test", "v1", "v1") as { detail: string }[];
    expect(
      profilePlan.some(({ detail }) =>
        detail.includes("work_item_profile_state"),
      ),
    ).toBe(true);
    expect(
      profilePlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")),
    ).toBe(false);
    const kindErrorPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT kind, last_error_code, COUNT(*) AS count
         FROM work_item INDEXED BY work_item_kind_error_code
         WHERE last_error_code IS NOT NULL
         GROUP BY kind, last_error_code`,
      )
      .all() as { detail: string }[];
    expect(
      kindErrorPlan.some(({ detail }) =>
        detail.includes("work_item_kind_error_code"),
      ),
    ).toBe(true);
    expect(
      kindErrorPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")),
    ).toBe(false);
    database
      .prepare(
        `INSERT INTO work_event(event_id, work_key, event_type, payload_json, created_at)
         VALUES('completed-a', ?, 'succeeded', '{}', 2)`,
      )
      .run("a".repeat(64));
    const queryPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT work_event.sequence
         FROM work_event
         JOIN work_item ON work_item.work_key = work_event.work_key
         WHERE work_event.sequence > ? AND work_event.sequence <= ?
           AND work_event.event_type = 'succeeded'
           AND work_item.kind IN (?)
         ORDER BY work_event.sequence LIMIT ?`,
      )
      .all(0, 10, "test", 250) as { detail: string }[];
    expect(
      queryPlan.some(({ detail }) =>
        detail.includes("work_event_completed_scan"),
      ),
    ).toBe(true);
    database.close();
  });

  test("keeps work definitions immutable while allowing lifecycle updates", () => {
    const database = new Database(":memory:");
    migrate(database);
    database
      .prepare(
        `INSERT INTO work_item(
          work_key, kind, input_json, input_hash, schema_version,
          implementation_version, available_at, created_at, updated_at
        ) VALUES (?, 'test', '{}', ?, 'v1', 'v1', 1, 1, 1)`,
      )
      .run("a".repeat(64), "b".repeat(64));

    expect(() =>
      database
        .prepare("UPDATE work_item SET input_json = ? WHERE work_key = ?")
        .run('{"changed":true}', "a".repeat(64)),
    ).toThrow(/WORK_ITEM_DEFINITION_IMMUTABLE/u);
    expect(() =>
      database
        .prepare("UPDATE work_item SET priority = 10 WHERE work_key = ?")
        .run("a".repeat(64)),
    ).not.toThrow();
    expect(() =>
      database
        .prepare("UPDATE work_item SET priority = 1000001 WHERE work_key = ?")
        .run("a".repeat(64)),
    ).toThrow(/WORK_ITEM_DEFINITION_INVALID/u);
    expect(
      database
        .prepare("SELECT priority FROM work_item WHERE work_key = ?")
        .pluck()
        .get("a".repeat(64)),
    ).toBe(10);
    database.close();
  });

  test("rejects raw SQL work definitions with malformed JSON or hashes", () => {
    const database = new Database(":memory:");
    migrate(database);
    const insert = database.prepare(
      `INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version,
        implementation_version, available_at, created_at, updated_at
      ) VALUES (?, 'test', ?, ?, 'v1', 'v1', 1, 1, 1)`,
    );

    expect(() => insert.run("a".repeat(64), "{", "b".repeat(64))).toThrow(
      /WORK_ITEM_DEFINITION_INVALID/u,
    );
    expect(() => insert.run("a".repeat(64), "[]", "b".repeat(64))).toThrow(
      /WORK_ITEM_DEFINITION_INVALID/u,
    );
    expect(() => insert.run("A".repeat(64), "{}", "b".repeat(64))).toThrow(
      /WORK_ITEM_DEFINITION_INVALID/u,
    );
    expect(() => insert.run("a".repeat(64), "{}", "z".repeat(64))).toThrow(
      /WORK_ITEM_DEFINITION_INVALID/u,
    );
    expect(() =>
      database
        .prepare(
          `INSERT INTO work_item(
            work_key, kind, input_json, input_hash, schema_version,
            implementation_version, priority, available_at, created_at,
            updated_at
          ) VALUES (?, '', '{}', ?, 'v1', 'v1', 0, 1, 1, 1)`,
        )
        .run("a".repeat(64), "b".repeat(64)),
    ).toThrow(/WORK_ITEM_DEFINITION_INVALID/u);
    expect(() =>
      insert.run("a".repeat(64), "{}", "b".repeat(64)),
    ).not.toThrow();
    database.close();
  });

  test("keeps invalid v8 work repairable before installing definition guards", () => {
    const database = new Database(":memory:");
    const migrationsThroughVersionEight = MIGRATIONS.filter(
      ({ version }) => version <= 8,
    );
    for (const migration of migrationsThroughVersionEight) {
      database.exec(migration.statements);
    }
    database.exec(`
      CREATE TABLE local_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL CHECK(version >= 0)
      ) STRICT;
      INSERT INTO local_schema(singleton, version) VALUES(1, 8);
    `);
    database
      .prepare(
        `INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version,
        implementation_version, available_at, created_at, updated_at
      ) VALUES(?, 'test', '{', ?, 'v1', 'v1', 1, 1, 1)`,
      )
      .run("a".repeat(64), "b".repeat(64));

    expect(() => migrate(database)).toThrow(
      /WORK_ITEM_DEFINITION_INVALID_MIGRATION: 1 work item/u,
    );
    expect(
      database
        .prepare("SELECT version FROM local_schema WHERE singleton = 1")
        .pluck()
        .get(),
    ).toBe(8);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) FROM sqlite_schema
           WHERE type = 'trigger'
             AND name = 'work_item_definition_reject_update'`,
        )
        .pluck()
        .get(),
    ).toBe(0);

    database
      .prepare("UPDATE work_item SET input_json = '{}' WHERE work_key = ?")
      .run("a".repeat(64));
    expect(migrate(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      database
        .prepare("SELECT version FROM local_schema WHERE singleton = 1")
        .pluck()
        .get(),
    ).toBe(CURRENT_SCHEMA_VERSION);
    database.close();
  });

  test("rejects conflicting ownership of one canonical poem in SQL", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "saqi-poem-identity-")),
      "ledger.sqlite3",
    );
    const ledger = Ledger.open(path);
    ledger.close();
    const database = new Database(path);
    const insert = database.prepare(`INSERT INTO poem_identity(
      source_name, poem_href, author_href, first_work_key, created_at
    ) VALUES('source', ?, ?, ?, 1)
    ON CONFLICT(source_name, poem_href) DO NOTHING`);
    insert.run(
      "https://source.invalid/poem42.html",
      "https://source.invalid/cat-poet-one",
      "a".repeat(64),
    );
    expect(() =>
      insert.run(
        "https://source.invalid/poem42.html",
        "https://source.invalid/cat-poet-two",
        "b".repeat(64),
      ),
    ).toThrow(/SOURCE_POEM_DUPLICATE/u);
    expect(() =>
      insert.run(
        "https://source.invalid/poem42.html",
        "https://source.invalid/cat-poet-one",
        "c".repeat(64),
      ),
    ).not.toThrow();
    expect(() =>
      insert.run(
        "https://source.invalid/poem42/",
        "https://source.invalid/cat-poet-one",
        "d".repeat(64),
      ),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      insert.run(
        "https://source.invalid/poem0.html",
        "https://source.invalid/cat-poet-one",
        "d".repeat(64),
      ),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      insert.run(
        "https://source.invalid/poem042.html",
        "https://source.invalid/cat-poet-one",
        "d".repeat(64),
      ),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      insert.run(
        "https://source.invalid/poem9007199254740992.html",
        "https://source.invalid/cat-poet-one",
        "d".repeat(64),
      ),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      database
        .prepare(
          "UPDATE poem_identity SET author_href = ? WHERE source_name = 'source' AND poem_href = ?",
        )
        .run(
          "https://source.invalid/cat-poet-two",
          "https://source.invalid/poem42.html",
        ),
    ).toThrow(/SOURCE_POEM_IDENTITY_IMMUTABLE/u);
    expect(() =>
      database
        .prepare(
          "UPDATE poem_identity SET first_work_key = ? WHERE source_name = 'source' AND poem_href = ?",
        )
        .run("e".repeat(64), "https://source.invalid/poem42.html"),
    ).toThrow(/SOURCE_POEM_IDENTITY_IMMUTABLE/u);
    expect(() =>
      database
        .prepare(
          "DELETE FROM poem_identity WHERE source_name = 'source' AND poem_href = ?",
        )
        .run("https://source.invalid/poem42.html"),
    ).toThrow(/SOURCE_POEM_IDENTITY_IMMUTABLE/u);
    const directWork = database.prepare(
      `INSERT INTO work_item(
        work_key, kind, input_json, input_hash, schema_version,
        implementation_version, available_at, created_at, updated_at
      ) VALUES(?, 'source_poem_detail', ?, ?, 'projection-v1', 'collector-v1', 1, 1, 1)`,
    );
    const registeredInput = JSON.stringify({
      authorHref: "https://source.invalid/cat-poet-one",
      poemHref: "https://source.invalid/poem42.html",
    });
    directWork.run("1".repeat(64), registeredInput, "2".repeat(64));
    expect(() =>
      directWork.run("3".repeat(64), registeredInput, "2".repeat(64)),
    ).toThrow(/SOURCE_POEM_WORK_DUPLICATE/u);
    expect(() =>
      directWork.run(
        "f".repeat(64),
        JSON.stringify({
          authorHref: "https://source.invalid/cat-poet-one",
          poemHref: "https://source.invalid/poem43.html",
        }),
        "f".repeat(64),
      ),
    ).toThrow(/SOURCE_POEM_IDENTITY_REQUIRED/u);
    database.close();
  });

  test("fails a conflicting version-seven backfill with a stable diagnostic", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO local_schema VALUES(1, 0);
    `);
    for (const migration of MIGRATIONS) {
      if (migration.version > 7) continue;
      database.exec(migration.statements);
      database
        .prepare("UPDATE local_schema SET version = ?")
        .run(migration.version);
    }
    const insert = database.prepare(`INSERT INTO work_item(
      work_key, kind, input_json, input_hash, schema_version,
      implementation_version, available_at, created_at, updated_at
    ) VALUES(?, 'source_poem_detail', ?, ?, 'projection-v1', 'collector-v1', 1, 1, 1)`);
    for (const [key, author] of [
      ["a".repeat(64), "https://source.invalid/cat-poet-one"],
      ["b".repeat(64), "https://source.invalid/cat-poet-two"],
    ] as const) {
      const input = JSON.stringify({
        authorHref: author,
        poemHref: "https://source.invalid/poem42.html",
      });
      insert.run(key, input, key);
    }
    expect(() => migrate(database)).toThrow(
      /SOURCE_POEM_DUPLICATE_MIGRATION.*poem42\.html.*2 authors/u,
    );
    expect(database.prepare("SELECT version FROM local_schema").get()).toEqual({
      version: 7,
    });
    database.close();
  });

  test("refuses to open a schema newer than this binary", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE local_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      INSERT INTO local_schema VALUES(1, ${String(CURRENT_SCHEMA_VERSION + 1)});
    `);
    expect(() => migrate(database)).toThrow("newer than supported");
    database.close();
  });
});

function schedulerState(schemaVersion: 10 | 9): string {
  return `${JSON.stringify({
    ambiguousOutcomeCount: 0,
    ambiguousWindowStartedAt: 0,
    configDigest: "a".repeat(64),
    consecutiveErrors: 0,
    consecutiveProviderFailures: 0,
    consecutiveRateLimits: 0,
    errorDampenerUntil: 0,
    ewmaLatencyMs: null,
    pressureEpoch: 0,
    providerCredentialGeneration: null,
    providerErrorCode: null,
    providerUntil: 0,
    quotaProbeAt: 0,
    quotaUntil: 0,
    rateLimitedUntil: 0,
    recoveryLease: null,
    samples: 0,
    schemaVersion,
    selectedConcurrency: 2,
    successStreak: 0,
    updatedAt: 1,
  })}\n`;
}
