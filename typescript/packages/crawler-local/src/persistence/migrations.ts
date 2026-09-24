import { hash } from "node:crypto";
// eslint-disable-next-line @sarj/prefer-node-fs-promises -- The legacy-owner guard executes inside the synchronous SQLite migration transaction; awaiting would break its atomic boundary.
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";
import { z } from "zod";

import { collectionWorkKinds } from "../collection/collection-scheduler.js";
import { schedulerStateSchemaVersion } from "../enrichment/sol-lane-scheduler.js";
import { currentSource } from "../source-adapter/index.js";
import { RUNTIME_OWNER_MIGRATION_SQL } from "./runtime-owner-schema.js";
import { SolOperationStore } from "./sol-operation-store.js";

interface Migration {
  readonly statements: string;
  readonly version: number;
}

interface LedgerMigrationPort {
  assertConfiguredSourceIdentity(): void;
  migrate(): number;
}
interface MigrationEnginePort {
  apply(migration: Migration): void;
  assertConfiguredSourceIdentity(): void;
}

export const CURRENT_SCHEMA_VERSION = 40;
const OwnerMigrationControlsSchema = z.strictObject({
  service: z.literal(0),
  global: z.literal(1),
  paid: z.literal(1),
  pauseImported: z.literal(1),
  serviceImported: z.literal(1),
  runningSol: z.literal(0),
});
const READ_LOCAL_SCHEMA_VERSION_SQL =
  "SELECT version FROM local_schema WHERE singleton = 1";
const LocalSchemaVersionRowSchema = z.strictObject({
  version: z.int().nonnegative(),
});
const SqliteSchemaSqlRowSchema = z.strictObject({
  sql: z.string(),
});
const ExistingSchemaObjectSchema = z.strictObject({
  name: z.string(),
});
const ExistingSchemaObjectsSchema = z.array(ExistingSchemaObjectSchema);
const READ_USER_SCHEMA_OBJECTS =
  "SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'";
const LocalSourceIdentityRowSchema = z.strictObject({
  source_name: z.string(),
  source_origin: z.string(),
});
const SchedulerStateAuthorityRowSchema = z.strictObject({
  state_digest: z.string().regex(/^[a-f\d]{64}$/),
  state_json: z.string(),
});

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: `
      CREATE TABLE work_item (
        work_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        schema_version TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry_wait','quota_wait','succeeded','dead_letter','imported')),
        available_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        lease_owner TEXT,
        lease_token TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
        lease_expires_at INTEGER,
        output_artifact_hash TEXT,
        last_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK((state = 'running') = (lease_token IS NOT NULL)),
        CHECK((lease_token IS NULL) = (lease_owner IS NULL)),
        CHECK((lease_token IS NULL) = (lease_expires_at IS NULL))
      ) STRICT;
      CREATE INDEX work_item_claimable ON work_item(state, available_at, priority DESC, created_at, work_key);
    `,
  },
  {
    version: 2,
    statements: `
      CREATE TABLE work_event (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        work_key TEXT NOT NULL REFERENCES work_item(work_key),
        attempt_id TEXT,
        lease_epoch INTEGER,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX work_event_work ON work_event(work_key, sequence);

      CREATE TABLE checkpoint (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        checkpoint_id TEXT NOT NULL UNIQUE,
        work_key TEXT NOT NULL REFERENCES work_item(work_key),
        attempt_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        artifact_hash TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX checkpoint_work ON checkpoint(work_key, sequence);

      CREATE TABLE origin_gate (
        origin TEXT PRIMARY KEY,
        active_token TEXT UNIQUE,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        next_allowed_at INTEGER NOT NULL DEFAULT 0,
        last_completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK((active_token IS NULL) = (lease_expires_at IS NULL))
      ) STRICT;
    `,
  },
  {
    version: 3,
    statements: `
      CREATE INDEX work_item_expired_lease
        ON work_item(lease_expires_at, work_key)
        WHERE state = 'running';
      CREATE INDEX work_item_worker_claim
        ON work_item(kind, implementation_version, schema_version, state,
                     available_at, priority DESC, created_at, work_key);
      CREATE INDEX checkpoint_latest_kind
        ON checkpoint(work_key, kind, sequence DESC);
      CREATE INDEX work_item_output_artifact
        ON work_item(output_artifact_hash)
        WHERE output_artifact_hash IS NOT NULL;
      CREATE INDEX checkpoint_artifact
        ON checkpoint(artifact_hash)
        WHERE artifact_hash IS NOT NULL;
    `,
  },
  {
    version: 4,
    statements: `
      ALTER TABLE origin_gate ADD COLUMN cooldown_until INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE origin_gate ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
        CHECK(consecutive_failures >= 0);
      ALTER TABLE origin_gate ADD COLUMN stop_reason TEXT;
      CREATE INDEX origin_gate_ready
        ON origin_gate(stop_reason, cooldown_until, next_allowed_at);
    `,
  },
  {
    version: 5,
    statements: `
      CREATE INDEX work_item_completed_input
        ON work_item(kind, schema_version, input_hash, updated_at DESC)
        WHERE state IN ('succeeded','imported') AND output_artifact_hash IS NOT NULL;
    `,
  },
  {
    version: 6,
    statements: `
      CREATE INDEX work_event_completed_scan
        ON work_event(event_type, sequence, work_key);
    `,
  },
  {
    version: 7,
    statements: `
      CREATE INDEX work_item_error_code
        ON work_item(last_error_code)
        WHERE last_error_code IS NOT NULL;
      CREATE INDEX work_item_ready_priority
        ON work_item(kind, implementation_version, schema_version,
                     priority DESC, created_at, work_key)
        WHERE state IN ('pending','retry_wait','quota_wait');
    `,
  },
  {
    version: 8,
    get statements() {
      const sourceName = sqlText(currentSource().name);
      const poemKind = sqlText(collectionWorkKinds().poemDetail);
      const poemUrlPrefix = sqlText(`${currentSource().origin}/poem`);
      return `
      CREATE TABLE poem_identity (
        source_name TEXT NOT NULL,
        poem_href TEXT NOT NULL CHECK(
          poem_href = ${poemUrlPrefix} || poem_numeric_id || '.html'
          AND poem_numeric_id GLOB '[1-9]*'
          AND poem_numeric_id NOT GLOB '*[^0-9]*'
          AND (
            length(poem_numeric_id) < 16
            OR (
              length(poem_numeric_id) = 16
              AND poem_numeric_id <= '9007199254740991'
            )
          )
        ),
        poem_numeric_id TEXT GENERATED ALWAYS AS (
          substr(
            poem_href,
            length(${poemUrlPrefix}) + 1,
            length(poem_href)
              - length(${poemUrlPrefix})
              - length('.html')
          )
        ) STORED NOT NULL,
        author_href TEXT NOT NULL CHECK(author_href <> '__CONFLICT__'),
        first_work_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(source_name, poem_href),
        UNIQUE(source_name, poem_numeric_id)
      ) STRICT;

      INSERT INTO poem_identity(
        source_name, poem_href, author_href, first_work_key, created_at
      )
      SELECT
        ${sourceName},
        json_extract(input_json, '$.poemHref'),
        CASE
          WHEN COUNT(DISTINCT json_extract(input_json, '$.authorHref')) = 1
            THEN MIN(json_extract(input_json, '$.authorHref'))
          ELSE '__CONFLICT__'
        END,
        MIN(work_key),
        MIN(created_at)
      FROM work_item
      WHERE kind = ${poemKind}
        AND json_type(input_json, '$.poemHref') = 'text'
        AND json_type(input_json, '$.authorHref') = 'text'
      GROUP BY json_extract(input_json, '$.poemHref')
      ON CONFLICT(source_name, poem_href) DO NOTHING;

      CREATE UNIQUE INDEX work_item_poem_definition_unique
        ON work_item(implementation_version, schema_version, input_hash)
        WHERE kind = ${poemKind};

      CREATE TRIGGER poem_identity_reject_conflicting_insert
      BEFORE INSERT ON poem_identity
      WHEN EXISTS (
        SELECT 1 FROM poem_identity
        WHERE source_name = NEW.source_name
          AND poem_numeric_id = NEW.poem_numeric_id
          AND author_href <> NEW.author_href
      )
      BEGIN
        SELECT RAISE(ABORT, 'SOURCE_POEM_DUPLICATE');
      END;

      CREATE TRIGGER poem_identity_reject_identity_update
      BEFORE UPDATE ON poem_identity
      BEGIN
        SELECT RAISE(ABORT, 'SOURCE_POEM_IDENTITY_IMMUTABLE');
      END;

      CREATE TRIGGER poem_identity_reject_delete
      BEFORE DELETE ON poem_identity
      BEGIN
        SELECT RAISE(ABORT, 'SOURCE_POEM_IDENTITY_IMMUTABLE');
      END;

      CREATE TRIGGER poem_work_requires_registered_identity_insert
      BEFORE INSERT ON work_item
      WHEN NEW.kind = ${poemKind}
        AND NOT EXISTS (
          SELECT 1 FROM poem_identity
          WHERE source_name = ${sourceName}
            AND poem_href = json_extract(NEW.input_json, '$.poemHref')
            AND author_href = json_extract(NEW.input_json, '$.authorHref')
        )
      BEGIN
        SELECT RAISE(ABORT, 'SOURCE_POEM_IDENTITY_REQUIRED');
      END;

      CREATE TRIGGER poem_work_reject_duplicate_definition_insert
      BEFORE INSERT ON work_item
      WHEN NEW.kind = ${poemKind}
        AND EXISTS (
          SELECT 1 FROM work_item
          WHERE kind = NEW.kind
            AND implementation_version = NEW.implementation_version
            AND schema_version = NEW.schema_version
            AND input_hash = NEW.input_hash
            AND work_key <> NEW.work_key
        )
      BEGIN
        SELECT RAISE(ABORT, 'SOURCE_POEM_WORK_DUPLICATE');
      END;

      CREATE TRIGGER poem_work_requires_registered_identity_update
      BEFORE UPDATE OF kind, input_json ON work_item
      WHEN NEW.kind = ${poemKind}
        AND NOT EXISTS (
          SELECT 1 FROM poem_identity
          WHERE source_name = ${sourceName}
            AND poem_href = json_extract(NEW.input_json, '$.poemHref')
            AND author_href = json_extract(NEW.input_json, '$.authorHref')
        )
      BEGIN
        SELECT RAISE(ABORT, 'SOURCE_POEM_IDENTITY_REQUIRED');
      END;
    `;
    },
  },
  {
    version: 9,
    statements: `
      CREATE TRIGGER work_item_definition_reject_update
      BEFORE UPDATE OF work_key, kind, input_json, input_hash,
        schema_version, implementation_version ON work_item
      WHEN NEW.work_key IS NOT OLD.work_key
        OR NEW.kind IS NOT OLD.kind
        OR NEW.input_json IS NOT OLD.input_json
        OR NEW.input_hash IS NOT OLD.input_hash
        OR NEW.schema_version IS NOT OLD.schema_version
        OR NEW.implementation_version IS NOT OLD.implementation_version
      BEGIN
        SELECT RAISE(ABORT, 'WORK_ITEM_DEFINITION_IMMUTABLE');
      END;
    `,
  },
  {
    version: 10,
    statements: `
      CREATE TRIGGER work_item_definition_reject_invalid_insert
      BEFORE INSERT ON work_item
      WHEN CASE
          WHEN json_valid(NEW.input_json)
            THEN json_type(NEW.input_json) IS NOT 'object'
          ELSE 1
        END
        OR length(NEW.work_key) <> 64
        OR NEW.work_key GLOB '*[^0-9a-f]*'
        OR length(NEW.input_hash) <> 64
        OR NEW.input_hash GLOB '*[^0-9a-f]*'
        OR length(trim(NEW.kind)) NOT BETWEEN 1 AND 100
        OR length(trim(NEW.schema_version)) NOT BETWEEN 1 AND 100
        OR length(trim(NEW.implementation_version)) NOT BETWEEN 1 AND 100
        OR NEW.priority NOT BETWEEN -1000000 AND 1000000
      BEGIN
        SELECT RAISE(ABORT, 'WORK_ITEM_DEFINITION_INVALID');
      END;

      CREATE TRIGGER work_item_priority_reject_invalid_update
      BEFORE UPDATE OF priority ON work_item
      WHEN NEW.priority NOT BETWEEN -1000000 AND 1000000
      BEGIN
        SELECT RAISE(ABORT, 'WORK_ITEM_DEFINITION_INVALID');
      END;
    `,
  },
  {
    version: 11,
    statements: `
      CREATE TRIGGER work_event_reject_update
      BEFORE UPDATE ON work_event
      BEGIN
        SELECT RAISE(ABORT, 'WORK_EVENT_IMMUTABLE');
      END;

      CREATE TRIGGER work_event_reject_delete
      BEFORE DELETE ON work_event
      BEGIN
        SELECT RAISE(ABORT, 'WORK_EVENT_IMMUTABLE');
      END;

      CREATE TRIGGER checkpoint_reject_update
      BEFORE UPDATE ON checkpoint
      BEGIN
        SELECT RAISE(ABORT, 'CHECKPOINT_IMMUTABLE');
      END;

      CREATE TRIGGER checkpoint_reject_delete
      BEFORE DELETE ON checkpoint
      BEGIN
        SELECT RAISE(ABORT, 'CHECKPOINT_IMMUTABLE');
      END;
    `,
  },
  {
    version: 12,
    get statements() {
      const sourceName = sqlText(currentSource().name);
      return `
      CREATE TABLE source_author_metadata (
        source_name TEXT NOT NULL CHECK(source_name = ${sourceName}),
        author_href TEXT NOT NULL CHECK(length(author_href) BETWEEN 1 AND 2048),
        author_name_arabic TEXT NOT NULL CHECK(length(trim(author_name_arabic)) BETWEEN 1 AND 512),
        refresh_generation TEXT NOT NULL CHECK(length(refresh_generation) BETWEEN 1 AND 64),
        observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
        PRIMARY KEY(source_name, author_href)
      ) STRICT;
    `;
    },
  },
  {
    version: 13,
    statements: `
      CREATE INDEX work_item_unknown_recovery
        ON work_item(kind, implementation_version, schema_version,
                     updated_at, created_at, work_key)
        WHERE state IN ('pending','retry_wait','quota_wait','dead_letter')
          AND last_error_code = 'CODEX_OPERATION_OUTCOME_UNKNOWN';
    `,
  },
  {
    version: 14,
    statements: `
      CREATE INDEX work_item_profile_state
        ON work_item(kind, implementation_version, schema_version, state);
    `,
  },
  {
    version: 15,
    statements: `
      CREATE INDEX work_item_kind_error_code
        ON work_item(kind, last_error_code)
        WHERE last_error_code IS NOT NULL;
    `,
  },
  {
    version: 16,
    statements: `
      CREATE TABLE scheduler_state (
        state_key TEXT PRIMARY KEY CHECK(length(trim(state_key)) BETWEEN 1 AND 128),
        state_json TEXT NOT NULL CHECK(json_valid(state_json)),
        state_digest TEXT NOT NULL CHECK(
          length(state_digest) = 64
          AND state_digest NOT GLOB '*[^0-9a-f]*'
        ),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
      ) STRICT;
    `,
  },
  {
    version: 17,
    statements: `
      CREATE TABLE paid_operation_reconciliation (
        operation_key TEXT PRIMARY KEY CHECK(
          length(operation_key) = 64
          AND operation_key NOT GLOB '*[^0-9a-f]*'
        ),
        work_key TEXT NOT NULL REFERENCES work_item(work_key),
        attempt_id TEXT NOT NULL CHECK(length(trim(attempt_id)) BETWEEN 1 AND 128),
        state TEXT NOT NULL CHECK(state IN ('unknown','reconciled','quarantined')),
        next_reconcile_at INTEGER NOT NULL CHECK(next_reconcile_at >= 0),
        reconciliation_count INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_count >= 0),
        first_observed_at INTEGER NOT NULL CHECK(first_observed_at >= 0),
        last_reconciled_at INTEGER,
        updated_at INTEGER NOT NULL CHECK(updated_at >= first_observed_at),
        CHECK((state = 'reconciled') = (last_reconciled_at IS NOT NULL)),
        UNIQUE(work_key, attempt_id)
      ) STRICT;
      CREATE INDEX paid_operation_reconciliation_due
        ON paid_operation_reconciliation(state, next_reconcile_at, updated_at)
        WHERE state IN ('unknown','quarantined');

      CREATE TRIGGER paid_operation_identity_reject_update
      BEFORE UPDATE OF operation_key, work_key, attempt_id
      ON paid_operation_reconciliation
      WHEN NEW.operation_key IS NOT OLD.operation_key
        OR NEW.work_key IS NOT OLD.work_key
        OR NEW.attempt_id IS NOT OLD.attempt_id
      BEGIN
        SELECT RAISE(ABORT, 'PAID_OPERATION_IDENTITY_IMMUTABLE');
      END;
    `,
  },
  {
    version: 18,
    statements: `
      CREATE TABLE ledger_state_count (
        state TEXT PRIMARY KEY CHECK(state IN ('pending','running','retry_wait','quota_wait','succeeded','dead_letter','imported')),
        item_count INTEGER NOT NULL CHECK(item_count >= 0)
      ) STRICT;
      CREATE TABLE ledger_kind_state_count (
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','running','retry_wait','quota_wait','succeeded','dead_letter','imported')),
        item_count INTEGER NOT NULL CHECK(item_count >= 0),
        PRIMARY KEY(kind, state)
      ) STRICT;
      CREATE TABLE ledger_profile_state_count (
        kind TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','running','retry_wait','quota_wait','succeeded','dead_letter','imported')),
        item_count INTEGER NOT NULL CHECK(item_count >= 0),
        PRIMARY KEY(kind, implementation_version, schema_version, state)
      ) STRICT;
      CREATE TABLE ledger_profile_availability_count (
        kind TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        available_at INTEGER NOT NULL,
        item_count INTEGER NOT NULL CHECK(item_count >= 0),
        PRIMARY KEY(kind, implementation_version, schema_version, available_at)
      ) STRICT;
      CREATE INDEX ledger_profile_availability_time
        ON ledger_profile_availability_count(available_at, kind);
      CREATE TABLE ledger_error_count (
        error_code TEXT PRIMARY KEY,
        item_count INTEGER NOT NULL CHECK(item_count >= 0)
      ) STRICT;
      CREATE TABLE ledger_kind_error_count (
        kind TEXT NOT NULL,
        error_code TEXT NOT NULL,
        item_count INTEGER NOT NULL CHECK(item_count >= 0),
        PRIMARY KEY(kind, error_code)
      ) STRICT;
      CREATE TABLE ledger_profile_error_count (
        kind TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        error_code TEXT NOT NULL,
        item_count INTEGER NOT NULL CHECK(item_count >= 0),
        PRIMARY KEY(
          kind, implementation_version, schema_version, error_code
        )
      ) STRICT;
      CREATE TABLE ledger_status_clock (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        last_success_at INTEGER,
        last_failure_at INTEGER
      ) STRICT;
      INSERT INTO ledger_status_clock(singleton) VALUES(1);
      CREATE TABLE ledger_kind_success_clock (
        kind TEXT PRIMARY KEY,
        last_success_at INTEGER NOT NULL CHECK(last_success_at >= 0)
      ) STRICT;
      CREATE TABLE ledger_profile_success_clock (
        kind TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        last_success_at INTEGER NOT NULL CHECK(last_success_at >= 0),
        PRIMARY KEY(kind, implementation_version, schema_version)
      ) STRICT;
      CREATE TABLE paid_operation_state_count (
        state TEXT PRIMARY KEY CHECK(state IN ('unknown','reconciled','quarantined')),
        item_count INTEGER NOT NULL CHECK(item_count >= 0)
      ) STRICT;

      INSERT INTO ledger_state_count(state, item_count)
        SELECT state, COUNT(*) FROM work_item GROUP BY state;
      INSERT INTO ledger_kind_state_count(kind, state, item_count)
        SELECT kind, state, COUNT(*) FROM work_item GROUP BY kind, state;
      INSERT INTO ledger_profile_state_count(
        kind, implementation_version, schema_version, state, item_count
      )
        SELECT kind, implementation_version, schema_version, state, COUNT(*)
        FROM work_item
        GROUP BY kind, implementation_version, schema_version, state;
      INSERT INTO ledger_profile_availability_count(
        kind, implementation_version, schema_version, available_at, item_count
      )
        SELECT kind, implementation_version, schema_version, available_at, COUNT(*)
        FROM work_item
        WHERE state IN ('pending','retry_wait','quota_wait')
        GROUP BY kind, implementation_version, schema_version, available_at;
      INSERT INTO ledger_error_count(error_code, item_count)
        SELECT last_error_code, COUNT(*) FROM work_item
        WHERE last_error_code IS NOT NULL GROUP BY last_error_code;
      INSERT INTO ledger_kind_error_count(kind, error_code, item_count)
        SELECT kind, last_error_code, COUNT(*) FROM work_item
        WHERE last_error_code IS NOT NULL GROUP BY kind, last_error_code;
      INSERT INTO ledger_profile_error_count(
        kind, implementation_version, schema_version, error_code, item_count
      )
        SELECT kind, implementation_version, schema_version,
               last_error_code, COUNT(*)
        FROM work_item WHERE last_error_code IS NOT NULL
        GROUP BY kind, implementation_version, schema_version, last_error_code;
      UPDATE ledger_status_clock SET
        last_success_at = (
          SELECT created_at FROM work_event
          WHERE event_type IN ('succeeded','imported')
          ORDER BY sequence DESC LIMIT 1
        ),
        last_failure_at = (
          SELECT created_at FROM work_event
          WHERE event_type IN ('retry_wait','quota_wait','dead_letter','lease_expired')
          ORDER BY sequence DESC LIMIT 1
        )
      WHERE singleton = 1;
      INSERT INTO ledger_kind_success_clock(kind, last_success_at)
        SELECT work_item.kind, MAX(work_event.created_at)
        FROM work_event
        INNER JOIN work_item ON work_item.work_key = work_event.work_key
        WHERE work_event.event_type IN ('succeeded','imported')
        GROUP BY work_item.kind;
      INSERT INTO ledger_profile_success_clock(
        kind, implementation_version, schema_version, last_success_at
      )
        SELECT work_item.kind, work_item.implementation_version,
               work_item.schema_version, MAX(work_event.created_at)
        FROM work_event
        INNER JOIN work_item ON work_item.work_key = work_event.work_key
        WHERE work_event.event_type IN ('succeeded','imported')
        GROUP BY work_item.kind, work_item.implementation_version,
                 work_item.schema_version;
      INSERT INTO paid_operation_state_count(state, item_count)
        SELECT state, COUNT(*) FROM paid_operation_reconciliation GROUP BY state;

      CREATE TRIGGER ledger_status_work_insert
      AFTER INSERT ON work_item
      BEGIN
        INSERT INTO ledger_state_count(state, item_count) VALUES(NEW.state, 1)
          ON CONFLICT(state) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_kind_state_count(kind, state, item_count)
          VALUES(NEW.kind, NEW.state, 1)
          ON CONFLICT(kind, state) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_state_count(
          kind, implementation_version, schema_version, state, item_count
        ) VALUES(NEW.kind, NEW.implementation_version, NEW.schema_version, NEW.state, 1)
          ON CONFLICT(kind, implementation_version, schema_version, state)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_availability_count(
          kind, implementation_version, schema_version, available_at, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.available_at, 1
          WHERE NEW.state IN ('pending','retry_wait','quota_wait')
          ON CONFLICT(kind, implementation_version, schema_version, available_at)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_error_count(error_code, item_count)
          SELECT NEW.last_error_code, 1 WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(error_code) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_kind_error_count(kind, error_code, item_count)
          SELECT NEW.kind, NEW.last_error_code, 1 WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(kind, error_code) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_error_count(
          kind, implementation_version, schema_version, error_code, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.last_error_code, 1
          WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(kind, implementation_version, schema_version, error_code)
          DO UPDATE SET item_count = item_count + 1;
      END;

      CREATE TRIGGER ledger_status_work_update
      AFTER UPDATE OF state, kind, implementation_version, schema_version,
                      available_at, last_error_code ON work_item
      BEGIN
        UPDATE ledger_state_count SET item_count = item_count - 1 WHERE state = OLD.state;
        DELETE FROM ledger_state_count WHERE state = OLD.state AND item_count = 0;
        UPDATE ledger_kind_state_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND state = OLD.state;
        DELETE FROM ledger_kind_state_count
          WHERE kind = OLD.kind AND state = OLD.state AND item_count = 0;
        UPDATE ledger_profile_state_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND state = OLD.state;
        DELETE FROM ledger_profile_state_count
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND state = OLD.state AND item_count = 0;
        UPDATE ledger_profile_availability_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND available_at = OLD.available_at
            AND OLD.state IN ('pending','retry_wait','quota_wait');
        DELETE FROM ledger_profile_availability_count
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND available_at = OLD.available_at
            AND item_count = 0;
        UPDATE ledger_error_count SET item_count = item_count - 1
          WHERE error_code = OLD.last_error_code;
        DELETE FROM ledger_error_count
          WHERE error_code = OLD.last_error_code AND item_count = 0;
        UPDATE ledger_kind_error_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND error_code = OLD.last_error_code;
        DELETE FROM ledger_kind_error_count
          WHERE kind = OLD.kind AND error_code = OLD.last_error_code AND item_count = 0;
        UPDATE ledger_profile_error_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version
            AND error_code = OLD.last_error_code;
        DELETE FROM ledger_profile_error_count
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version
            AND error_code = OLD.last_error_code AND item_count = 0;

        INSERT INTO ledger_state_count(state, item_count) VALUES(NEW.state, 1)
          ON CONFLICT(state) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_kind_state_count(kind, state, item_count)
          VALUES(NEW.kind, NEW.state, 1)
          ON CONFLICT(kind, state) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_state_count(
          kind, implementation_version, schema_version, state, item_count
        ) VALUES(NEW.kind, NEW.implementation_version, NEW.schema_version, NEW.state, 1)
          ON CONFLICT(kind, implementation_version, schema_version, state)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_availability_count(
          kind, implementation_version, schema_version, available_at, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.available_at, 1
          WHERE NEW.state IN ('pending','retry_wait','quota_wait')
          ON CONFLICT(kind, implementation_version, schema_version, available_at)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_error_count(error_code, item_count)
          SELECT NEW.last_error_code, 1 WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(error_code) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_kind_error_count(kind, error_code, item_count)
          SELECT NEW.kind, NEW.last_error_code, 1 WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(kind, error_code) DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_error_count(
          kind, implementation_version, schema_version, error_code, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.last_error_code, 1
          WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(kind, implementation_version, schema_version, error_code)
          DO UPDATE SET item_count = item_count + 1;
      END;

      CREATE TRIGGER ledger_status_event_insert
      AFTER INSERT ON work_event
      BEGIN
        UPDATE ledger_status_clock
          SET last_success_at = NEW.created_at
          WHERE singleton = 1 AND NEW.event_type IN ('succeeded','imported');
        UPDATE ledger_status_clock
          SET last_failure_at = NEW.created_at
          WHERE singleton = 1 AND NEW.event_type IN ('retry_wait','quota_wait','dead_letter','lease_expired');
        INSERT INTO ledger_kind_success_clock(kind, last_success_at)
          SELECT kind, NEW.created_at FROM work_item
          WHERE work_key = NEW.work_key AND NEW.event_type IN ('succeeded','imported')
          ON CONFLICT(kind) DO UPDATE SET last_success_at = excluded.last_success_at;
        INSERT INTO ledger_profile_success_clock(
          kind, implementation_version, schema_version, last_success_at
        )
          SELECT kind, implementation_version, schema_version, NEW.created_at
          FROM work_item
          WHERE work_key = NEW.work_key AND NEW.event_type IN ('succeeded','imported')
          ON CONFLICT(kind, implementation_version, schema_version)
          DO UPDATE SET last_success_at = excluded.last_success_at;
      END;

      CREATE TRIGGER ledger_status_paid_operation_insert
      AFTER INSERT ON paid_operation_reconciliation
      BEGIN
        INSERT INTO paid_operation_state_count(state, item_count) VALUES(NEW.state, 1)
          ON CONFLICT(state) DO UPDATE SET item_count = item_count + 1;
      END;

      CREATE TRIGGER ledger_status_paid_operation_update
      AFTER UPDATE OF state ON paid_operation_reconciliation
      WHEN NEW.state IS NOT OLD.state
      BEGIN
        UPDATE paid_operation_state_count SET item_count = item_count - 1
          WHERE state = OLD.state;
        DELETE FROM paid_operation_state_count
          WHERE state = OLD.state AND item_count = 0;
        INSERT INTO paid_operation_state_count(state, item_count) VALUES(NEW.state, 1)
          ON CONFLICT(state) DO UPDATE SET item_count = item_count + 1;
      END;
    `,
  },
  {
    version: 19,
    statements: `
      CREATE TABLE canonical_translation_binding (
        translation_work_key TEXT NOT NULL REFERENCES work_item(work_key),
        binding_id TEXT NOT NULL CHECK(
          length(binding_id) = 64 AND binding_id NOT GLOB '*[^0-9a-f]*'
        ),
        binding_json TEXT NOT NULL CHECK(
          json_valid(binding_json) AND json_type(binding_json) = 'object'
        ),
        poem_id TEXT NOT NULL CHECK(length(trim(poem_id)) BETWEEN 1 AND 200),
        source_revision_id TEXT NOT NULL CHECK(
          length(trim(source_revision_id)) BETWEEN 1 AND 200
        ),
        line_nfc_hash TEXT NOT NULL CHECK(
          length(line_nfc_hash) = 64 AND line_nfc_hash NOT GLOB '*[^0-9a-f]*'
        ),
        prompt_material_hash TEXT NOT NULL CHECK(
          length(prompt_material_hash) = 64
          AND prompt_material_hash NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        PRIMARY KEY(translation_work_key),
        UNIQUE(translation_work_key, binding_id)
      ) STRICT;
      CREATE INDEX canonical_translation_binding_identity
        ON canonical_translation_binding(binding_id, translation_work_key);
      CREATE INDEX canonical_translation_binding_poem_revision
        ON canonical_translation_binding(poem_id, source_revision_id);

      CREATE TABLE publication_derivation (
        translation_work_key TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        publication_work_key TEXT NOT NULL UNIQUE REFERENCES work_item(work_key),
        approved_artifact_hash TEXT NOT NULL CHECK(
          length(approved_artifact_hash) = 64
          AND approved_artifact_hash NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        PRIMARY KEY(translation_work_key),
        FOREIGN KEY(translation_work_key, binding_id)
          REFERENCES canonical_translation_binding(translation_work_key, binding_id)
      ) STRICT;
      CREATE INDEX publication_derivation_binding
        ON publication_derivation(binding_id, publication_work_key);

      CREATE TRIGGER canonical_translation_binding_reject_update
      BEFORE UPDATE ON canonical_translation_binding
      BEGIN
        SELECT RAISE(ABORT, 'CANONICAL_TRANSLATION_BINDING_IMMUTABLE');
      END;
      CREATE TRIGGER canonical_translation_binding_reject_delete
      BEFORE DELETE ON canonical_translation_binding
      BEGIN
        SELECT RAISE(ABORT, 'CANONICAL_TRANSLATION_BINDING_IMMUTABLE');
      END;
      CREATE TRIGGER publication_derivation_reject_update
      BEFORE UPDATE ON publication_derivation
      BEGIN
        SELECT RAISE(ABORT, 'PUBLICATION_DERIVATION_IMMUTABLE');
      END;
      CREATE TRIGGER publication_derivation_reject_delete
      BEFORE DELETE ON publication_derivation
      BEGIN
        SELECT RAISE(ABORT, 'PUBLICATION_DERIVATION_IMMUTABLE');
      END;
    `,
  },
  {
    version: 20,
    statements: `
      CREATE TABLE checkpoint_attempt_reference (
        attempt_id TEXT NOT NULL CHECK(
          length(attempt_id) = 36
          AND substr(attempt_id, 9, 1) = '-'
          AND substr(attempt_id, 14, 1) = '-'
          AND substr(attempt_id, 19, 1) = '-'
          AND substr(attempt_id, 24, 1) = '-'
          AND lower(attempt_id) NOT GLOB '*[^0-9a-f-]*'
          AND substr(lower(attempt_id), 15, 1) BETWEEN '1' AND '8'
          AND substr(lower(attempt_id), 20, 1) IN ('8','9','a','b')
        ),
        work_key TEXT NOT NULL REFERENCES work_item(work_key),
        checkpoint_sequence INTEGER NOT NULL REFERENCES checkpoint(sequence),
        PRIMARY KEY(attempt_id, work_key, checkpoint_sequence)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX checkpoint_attempt_reference_work
        ON checkpoint_attempt_reference(work_key, attempt_id);

      INSERT OR IGNORE INTO checkpoint_attempt_reference(
        attempt_id, work_key, checkpoint_sequence
      )
      SELECT DISTINCT attempt_reference.atom, checkpoint.work_key, checkpoint.sequence
        FROM checkpoint, json_tree(checkpoint.payload_json) AS attempt_reference
       WHERE attempt_reference.type = 'text'
         AND length(attempt_reference.atom) = 36
         AND substr(attempt_reference.atom, 9, 1) = '-'
         AND substr(attempt_reference.atom, 14, 1) = '-'
         AND substr(attempt_reference.atom, 19, 1) = '-'
         AND substr(attempt_reference.atom, 24, 1) = '-'
         AND lower(attempt_reference.atom) NOT GLOB '*[^0-9a-f-]*'
         AND substr(lower(attempt_reference.atom), 15, 1) BETWEEN '1' AND '8'
         AND substr(lower(attempt_reference.atom), 20, 1) IN ('8','9','a','b');

      CREATE TRIGGER checkpoint_attempt_reference_insert
      AFTER INSERT ON checkpoint
      BEGIN
        INSERT OR IGNORE INTO checkpoint_attempt_reference(
          attempt_id, work_key, checkpoint_sequence
        )
        SELECT DISTINCT attempt_reference.atom, NEW.work_key, NEW.sequence
          FROM json_tree(NEW.payload_json) AS attempt_reference
         WHERE attempt_reference.type = 'text'
           AND length(attempt_reference.atom) = 36
           AND substr(attempt_reference.atom, 9, 1) = '-'
           AND substr(attempt_reference.atom, 14, 1) = '-'
           AND substr(attempt_reference.atom, 19, 1) = '-'
           AND substr(attempt_reference.atom, 24, 1) = '-'
           AND lower(attempt_reference.atom) NOT GLOB '*[^0-9a-f-]*'
           AND substr(lower(attempt_reference.atom), 15, 1) BETWEEN '1' AND '8'
           AND substr(lower(attempt_reference.atom), 20, 1) IN ('8','9','a','b');
      END;

      CREATE TRIGGER checkpoint_attempt_reference_reject_update
      BEFORE UPDATE ON checkpoint_attempt_reference
      BEGIN
        SELECT RAISE(ABORT, 'CHECKPOINT_ATTEMPT_REFERENCE_IMMUTABLE');
      END;
      CREATE TRIGGER checkpoint_attempt_reference_reject_delete
      BEFORE DELETE ON checkpoint_attempt_reference
      BEGIN
        SELECT RAISE(ABORT, 'CHECKPOINT_ATTEMPT_REFERENCE_IMMUTABLE');
      END;
    `,
  },
  {
    version: 21,
    statements: `
      CREATE TABLE fanout_detail_material (
        detail_fanout_work_key TEXT PRIMARY KEY REFERENCES work_item(work_key),
        source_work_key TEXT NOT NULL REFERENCES work_item(work_key),
        prompt_material_hash TEXT NOT NULL CHECK(
          length(prompt_material_hash) = 64
          AND prompt_material_hash NOT GLOB '*[^0-9a-f]*'
        ),
        line_nfc_hash TEXT NOT NULL CHECK(
          length(line_nfc_hash) = 64
          AND line_nfc_hash NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK(created_at >= 0)
      ) STRICT;
      CREATE INDEX fanout_detail_material_prompt
        ON fanout_detail_material(prompt_material_hash, detail_fanout_work_key);

      CREATE TABLE fanout_reusable_enrichment (
        translation_work_key TEXT PRIMARY KEY REFERENCES work_item(work_key),
        fanout_work_key TEXT NOT NULL REFERENCES work_item(work_key),
        model_key TEXT NOT NULL CHECK(length(trim(model_key)) BETWEEN 1 AND 100),
        prompt_material_hash TEXT NOT NULL CHECK(
          length(prompt_material_hash) = 64
          AND prompt_material_hash NOT GLOB '*[^0-9a-f]*'
        ),
        output_artifact_hash TEXT NOT NULL CHECK(
          length(output_artifact_hash) = 64
          AND output_artifact_hash NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK(created_at >= 0)
      ) STRICT;
      CREATE INDEX fanout_reusable_enrichment_material
        ON fanout_reusable_enrichment(
          model_key, prompt_material_hash, fanout_work_key
        );

      CREATE TRIGGER fanout_detail_material_reject_update
      BEFORE UPDATE ON fanout_detail_material
      BEGIN
        SELECT RAISE(ABORT, 'FANOUT_DETAIL_MATERIAL_IMMUTABLE');
      END;
      CREATE TRIGGER fanout_detail_material_reject_delete
      BEFORE DELETE ON fanout_detail_material
      BEGIN
        SELECT RAISE(ABORT, 'FANOUT_DETAIL_MATERIAL_IMMUTABLE');
      END;
      CREATE TRIGGER fanout_reusable_enrichment_reject_update
      BEFORE UPDATE ON fanout_reusable_enrichment
      BEGIN
        SELECT RAISE(ABORT, 'FANOUT_REUSABLE_ENRICHMENT_IMMUTABLE');
      END;
      CREATE TRIGGER fanout_reusable_enrichment_reject_delete
      BEFORE DELETE ON fanout_reusable_enrichment
      BEGIN
        SELECT RAISE(ABORT, 'FANOUT_REUSABLE_ENRICHMENT_IMMUTABLE');
      END;
    `,
  },
  {
    version: 22,
    statements: `
      CREATE TABLE source_author_metadata_revision (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0)
      ) STRICT;
      INSERT INTO source_author_metadata_revision(singleton, revision)
      SELECT 1, CASE WHEN EXISTS(
        SELECT 1 FROM source_author_metadata
      ) THEN 1 ELSE 0 END
      ON CONFLICT(singleton) DO NOTHING;
      CREATE TRIGGER source_author_metadata_revision_insert
      AFTER INSERT ON source_author_metadata
      BEGIN
        UPDATE source_author_metadata_revision
        SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER source_author_metadata_revision_update
      AFTER UPDATE ON source_author_metadata
      BEGIN
        UPDATE source_author_metadata_revision
        SET revision = revision + 1 WHERE singleton = 1;
      END;
    `,
  },
  {
    version: 23,
    statements: `
      CREATE TABLE fanout_priority_hint (
        work_key TEXT PRIMARY KEY REFERENCES work_item(work_key),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX fanout_priority_hint_schedule
        ON fanout_priority_hint(created_at, work_key);
      CREATE TRIGGER fanout_priority_hint_limit_insert
      BEFORE INSERT ON fanout_priority_hint
      WHEN NOT EXISTS(
          SELECT 1 FROM fanout_priority_hint WHERE work_key = NEW.work_key
        ) AND (SELECT COUNT(*) FROM fanout_priority_hint) >= 1000
      BEGIN
        SELECT RAISE(ABORT, 'FANOUT_PRIORITY_HINT_LIMIT');
      END;
      CREATE TRIGGER fanout_priority_hint_terminal_cleanup
      AFTER UPDATE OF state ON work_item
      WHEN NEW.state IN ('succeeded', 'dead_letter', 'imported')
      BEGIN
        DELETE FROM fanout_priority_hint WHERE work_key = NEW.work_key;
      END;
    `,
  },
  {
    version: 24,
    statements: `
      CREATE INDEX work_item_fanout_resolution_pending
        ON work_item(priority DESC, available_at, created_at, work_key)
        WHERE state IN ('pending', 'retry_wait', 'quota_wait')
          AND last_error_code = 'FANOUT_RESOLUTION_PENDING';
    `,
  },
  {
    version: 25,
    statements: `
      DROP TRIGGER fanout_priority_hint_terminal_cleanup;
      DROP TRIGGER fanout_priority_hint_limit_insert;
      DROP INDEX fanout_priority_hint_schedule;
      ALTER TABLE fanout_priority_hint RENAME TO fanout_priority_hint_v23;
      CREATE TABLE fanout_priority_hint (
        work_key TEXT PRIMARY KEY REFERENCES work_item(work_key),
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','running','retry_wait','quota_wait')),
        available_at INTEGER NOT NULL CHECK(available_at >= 0),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO fanout_priority_hint(
        work_key, kind, state, available_at, created_at, updated_at
      )
      SELECT hint.work_key, work.kind, work.state, work.available_at,
             hint.created_at, hint.updated_at
        FROM fanout_priority_hint_v23 AS hint
        JOIN work_item AS work ON work.work_key = hint.work_key
       WHERE work.state IN ('pending','running','retry_wait','quota_wait')
      ON CONFLICT(work_key) DO NOTHING;
      DROP TABLE fanout_priority_hint_v23;
      CREATE INDEX fanout_priority_hint_schedule
        ON fanout_priority_hint(kind, created_at, work_key);
      CREATE TRIGGER fanout_priority_hint_limit_insert
      BEFORE INSERT ON fanout_priority_hint
      WHEN NOT EXISTS(
          SELECT 1 FROM fanout_priority_hint WHERE work_key = NEW.work_key
        ) AND (SELECT COUNT(*) FROM fanout_priority_hint) >= 1000
      BEGIN
        SELECT RAISE(ABORT, 'FANOUT_PRIORITY_HINT_LIMIT');
      END;
      CREATE TRIGGER fanout_priority_hint_work_sync
      AFTER UPDATE OF state, available_at ON work_item
      WHEN NEW.state IN ('pending','running','retry_wait','quota_wait')
      BEGIN
        UPDATE fanout_priority_hint
           SET state = NEW.state,
               available_at = NEW.available_at,
               updated_at = MAX(updated_at, NEW.updated_at)
         WHERE work_key = NEW.work_key;
      END;
      CREATE TRIGGER fanout_priority_hint_terminal_cleanup
      AFTER UPDATE OF state ON work_item
      WHEN NEW.state IN ('succeeded', 'dead_letter', 'imported')
      BEGIN
        DELETE FROM fanout_priority_hint WHERE work_key = NEW.work_key;
      END;
    `,
  },
  {
    version: 26,
    statements: `
      CREATE TABLE sol_paid_usage_budget (
        budget_id TEXT PRIMARY KEY,
        maximum_operations INTEGER NOT NULL CHECK(maximum_operations > 0),
        reserved_operations INTEGER NOT NULL DEFAULT 0
          CHECK(reserved_operations >= 0 AND reserved_operations <= maximum_operations),
        state TEXT NOT NULL CHECK(state IN ('active','exhausted','closed')),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
      ) STRICT;
      CREATE UNIQUE INDEX sol_paid_usage_budget_active
        ON sol_paid_usage_budget(state) WHERE state = 'active';
      CREATE TABLE sol_paid_usage_reservation (
        budget_id TEXT NOT NULL REFERENCES sol_paid_usage_budget(budget_id),
        attempt_id TEXT NOT NULL,
        work_key TEXT NOT NULL REFERENCES work_item(work_key),
        reserved_operations INTEGER NOT NULL CHECK(reserved_operations = 3),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        PRIMARY KEY(budget_id, attempt_id),
        UNIQUE(budget_id, work_key, attempt_id)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 27,
    statements: `
      CREATE TABLE sol_poem_milestone (
        work_key TEXT NOT NULL REFERENCES work_item(work_key),
        milestone TEXT NOT NULL CHECK(milestone IN ('generated','published')),
        implementation_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        completed_at INTEGER NOT NULL CHECK(completed_at >= 0),
        PRIMARY KEY(work_key, milestone)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX sol_poem_milestone_profile_time
        ON sol_poem_milestone(
          implementation_version, schema_version, milestone, completed_at, work_key
        );

      CREATE TABLE sol_poem_milestone_backfill (
        event_type TEXT PRIMARY KEY CHECK(event_type IN ('succeeded','imported')),
        cursor_sequence INTEGER NOT NULL CHECK(cursor_sequence >= 0),
        high_watermark INTEGER NOT NULL CHECK(high_watermark >= cursor_sequence),
        completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0)
      ) STRICT, WITHOUT ROWID;
      INSERT INTO sol_poem_milestone_backfill(
        event_type, cursor_sequence, high_watermark, completed_at
      )
      WITH high_watermark(value) AS (
        SELECT COALESCE(MAX(sequence), 0) FROM work_event
      )
      SELECT 'succeeded', 0, value, NULL FROM high_watermark
      UNION ALL
      SELECT 'imported', 0, value, NULL FROM high_watermark;

      CREATE TRIGGER sol_poem_milestone_event_insert
      AFTER INSERT ON work_event
      WHEN NEW.event_type IN ('succeeded','imported')
      BEGIN
        INSERT INTO sol_poem_milestone(
          work_key, milestone, implementation_version, schema_version, completed_at
        )
        SELECT work_key,
               CASE NEW.event_type WHEN 'succeeded' THEN 'generated' ELSE 'published' END,
               implementation_version, schema_version, NEW.created_at
          FROM work_item
         WHERE work_key = NEW.work_key AND kind = 'poem-enrichment-sol'
           AND (
             NEW.event_type = 'succeeded'
             OR CASE WHEN json_valid(NEW.payload_json) THEN (
               (
                 json_type(NEW.payload_json, '$.artifactHash') = 'text'
                 AND length(json_extract(NEW.payload_json, '$.artifactHash')) = 64
                 AND json_extract(NEW.payload_json, '$.artifactHash') NOT GLOB '*[^0-9a-f]*'
                 AND (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 1
               ) OR (
                 json_type(NEW.payload_json, '$.publicationWorkKey') = 'text'
                 AND length(json_extract(NEW.payload_json, '$.publicationWorkKey')) = 64
                 AND json_extract(NEW.payload_json, '$.publicationWorkKey') NOT GLOB '*[^0-9a-f]*'
                 AND json_type(NEW.payload_json, '$.receiptArtifactHash') = 'text'
                 AND length(json_extract(NEW.payload_json, '$.receiptArtifactHash')) = 64
                 AND json_extract(NEW.payload_json, '$.receiptArtifactHash') NOT GLOB '*[^0-9a-f]*'
                 AND (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 2
               )
             ) ELSE 0 END
           )
        ON CONFLICT(work_key, milestone) DO NOTHING;
      END;
      CREATE TRIGGER sol_poem_milestone_reject_update
      BEFORE UPDATE ON sol_poem_milestone
      BEGIN SELECT RAISE(ABORT, 'SOL_POEM_MILESTONE_IMMUTABLE'); END;
      CREATE TRIGGER sol_poem_milestone_reject_delete
      BEFORE DELETE ON sol_poem_milestone
      BEGIN SELECT RAISE(ABORT, 'SOL_POEM_MILESTONE_IMMUTABLE'); END;
    `,
  },
  {
    version: 28,
    statements: `
      CREATE TABLE retired_scheduler_state (
        state_key TEXT PRIMARY KEY CHECK(state_key IN (
          'provider-v10:agy', 'provider-v10:claude',
          'provider:agy', 'provider:claude'
        )),
        state_json TEXT NOT NULL CHECK(json_valid(state_json)),
        state_digest TEXT NOT NULL CHECK(
          length(state_digest) = 64
          AND state_digest NOT GLOB '*[^0-9a-f]*'
        ),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
        retired_at INTEGER NOT NULL CHECK(retired_at >= 0),
        authority_state_digest TEXT NOT NULL CHECK(
          length(authority_state_digest) = 64
          AND authority_state_digest NOT GLOB '*[^0-9a-f]*'
        )
      ) STRICT, WITHOUT ROWID;
      CREATE TRIGGER retired_scheduler_state_reject_update
      BEFORE UPDATE ON retired_scheduler_state
      BEGIN SELECT RAISE(ABORT, 'RETIRED_SCHEDULER_STATE_IMMUTABLE'); END;
      CREATE TRIGGER retired_scheduler_state_reject_delete
      BEFORE DELETE ON retired_scheduler_state
      BEGIN SELECT RAISE(ABORT, 'RETIRED_SCHEDULER_STATE_IMMUTABLE'); END;
    `,
  },
  {
    version: 29,
    statements: `
      CREATE TABLE local_source_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        source_name TEXT NOT NULL CHECK(
          length(source_name) BETWEEN 2 AND 64
          AND source_name GLOB '[a-z]*'
          AND source_name NOT GLOB '*[^a-z0-9_-]*'
        ),
        source_origin TEXT NOT NULL CHECK(
          length(source_origin) BETWEEN 9 AND 2048
          AND source_origin GLOB 'https://*'
        )
      ) STRICT;

      CREATE TRIGGER local_source_identity_reject_update
      BEFORE UPDATE ON local_source_identity
      BEGIN SELECT RAISE(ABORT, 'LOCAL_SOURCE_IDENTITY_IMMUTABLE'); END;

      CREATE TRIGGER local_source_identity_reject_delete
      BEFORE DELETE ON local_source_identity
      BEGIN SELECT RAISE(ABORT, 'LOCAL_SOURCE_IDENTITY_IMMUTABLE'); END;
    `,
  },
  {
    version: 30,
    statements: `CREATE TABLE runtime_control (
      control_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
    ) STRICT;`,
  },
  {
    version: 31,
    statements: `CREATE TABLE monitor_progress_history (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      payload BLOB NOT NULL CHECK(length(payload) <= 131072),
      updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
    ) STRICT;`,
  },
  {
    version: 32,
    statements: `CREATE INDEX work_item_fanout_resolution_ready
      ON work_item(kind, available_at, work_key, state)
      WHERE state IN ('pending', 'retry_wait', 'quota_wait')
        AND last_error_code = 'FANOUT_RESOLUTION_PENDING';`,
  },
  {
    version: 33,
    statements: `CREATE TABLE runtime_provider_concurrency (
      provider TEXT PRIMARY KEY CHECK(provider = 'sol'),
      target INTEGER NOT NULL CHECK(target BETWEEN 1 AND 256),
      initial INTEGER NOT NULL CHECK(initial BETWEEN 1 AND target),
      revision INTEGER NOT NULL CHECK(revision >= 0)
    ) STRICT;`,
  },
  {
    version: 34,
    statements: `
      CREATE TABLE sol_operation (
        operation_key TEXT PRIMARY KEY CHECK(length(operation_key) = 64 AND operation_key NOT GLOB '*[^0-9a-f]*'),
        kind TEXT NOT NULL CHECK(kind IN ('generation','review-1','review-2')),
        model TEXT NOT NULL, model_key TEXT NOT NULL, pipeline_version TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider = 'sol'), reasoning_effort TEXT NOT NULL,
        current_attempt_id TEXT NOT NULL, current_epoch INTEGER NOT NULL CHECK(current_epoch > 0),
        FOREIGN KEY(operation_key, current_attempt_id, current_epoch)
          REFERENCES sol_invocation_attempt(operation_key, attempt_id, claim_epoch) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE TABLE sol_invocation_attempt (
        attempt_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL REFERENCES sol_operation(operation_key) DEFERRABLE INITIALLY DEFERRED,
        claim_epoch INTEGER NOT NULL CHECK(claim_epoch > 0),
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        state TEXT NOT NULL CHECK(state IN ('intent','unknown','known_success','known_rejection','known_invalid')),
        exit_code INTEGER, signal TEXT, finished_at INTEGER,
        turn_started_at INTEGER, session_id TEXT, session_observed_at INTEGER,
        observations_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(observations_json)
          AND length(CAST(observations_json AS BLOB)) <= 16384),
        CHECK((state = 'intent') = (finished_at IS NULL)),
        CHECK(finished_at IS NULL OR finished_at >= created_at),
        CHECK(turn_started_at IS NULL OR turn_started_at >= created_at),
        CHECK((session_id IS NULL) = (session_observed_at IS NULL)),
        CHECK(session_observed_at IS NULL OR session_observed_at >= created_at),
        CHECK(state NOT IN ('known_success','known_invalid') OR (exit_code IS 0 AND signal IS NULL)),
        CHECK(state != 'known_rejection' OR (exit_code IS NOT NULL AND signal IS NULL AND turn_started_at IS NULL)),
        UNIQUE(operation_key, claim_epoch), UNIQUE(operation_key, attempt_id, claim_epoch)
      ) STRICT;
      CREATE TRIGGER sol_operation_identity_immutable
      BEFORE UPDATE OF operation_key, kind, model, model_key, pipeline_version, provider, reasoning_effort
      ON sol_operation
      WHEN NEW.operation_key IS NOT OLD.operation_key OR NEW.kind IS NOT OLD.kind OR NEW.model IS NOT OLD.model
        OR NEW.model_key IS NOT OLD.model_key OR NEW.pipeline_version IS NOT OLD.pipeline_version
        OR NEW.provider IS NOT OLD.provider OR NEW.reasoning_effort IS NOT OLD.reasoning_effort
      BEGIN SELECT RAISE(ABORT, 'SOL_OPERATION_IDENTITY_IMMUTABLE'); END;
      CREATE TRIGGER sol_invocation_identity_immutable
      BEFORE UPDATE OF attempt_id, operation_key, claim_epoch, input_hash, created_at ON sol_invocation_attempt
      WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.operation_key IS NOT OLD.operation_key
        OR NEW.claim_epoch IS NOT OLD.claim_epoch OR NEW.input_hash IS NOT OLD.input_hash
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'SOL_INVOCATION_IDENTITY_IMMUTABLE'); END;
      CREATE TABLE sol_operation_import_receipt (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        source_digest TEXT NOT NULL CHECK(length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
        record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 100000),
        source_bytes INTEGER NOT NULL CHECK(source_bytes BETWEEN 0 AND 536870912),
        imported_at INTEGER NOT NULL CHECK(imported_at >= 0)
      ) STRICT;
      CREATE TRIGGER sol_operation_import_receipt_immutable BEFORE UPDATE ON sol_operation_import_receipt
      BEGIN SELECT RAISE(ABORT, 'SOL_OPERATION_IMPORT_RECEIPT_IMMUTABLE'); END;
      CREATE TRIGGER sol_operation_import_receipt_reject_delete BEFORE DELETE ON sol_operation_import_receipt
      BEGIN SELECT RAISE(ABORT, 'SOL_OPERATION_IMPORT_RECEIPT_IMMUTABLE'); END;
    `,
  },
  { version: 35, statements: RUNTIME_OWNER_MIGRATION_SQL },
  {
    version: 36,
    statements: `
      DROP INDEX IF EXISTS paid_operation_reconciliation_due;
      CREATE INDEX paid_operation_reconciliation_due
        ON paid_operation_reconciliation(next_reconcile_at)
        WHERE state = 'unknown';
    `,
  },
  {
    version: 37,
    statements: `
      DROP TRIGGER ledger_status_work_insert;
      DROP TRIGGER ledger_status_work_update;
      DROP TRIGGER ledger_status_event_insert;
      DROP TABLE ledger_state_count;
      DROP TABLE ledger_kind_state_count;
      DROP TABLE ledger_error_count;
      DROP TABLE ledger_kind_error_count;
      DROP TABLE ledger_kind_success_clock;

      CREATE TRIGGER ledger_status_work_insert
      AFTER INSERT ON work_item
      BEGIN
        INSERT INTO ledger_profile_state_count(
          kind, implementation_version, schema_version, state, item_count
        ) VALUES(NEW.kind, NEW.implementation_version, NEW.schema_version, NEW.state, 1)
          ON CONFLICT(kind, implementation_version, schema_version, state)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_availability_count(
          kind, implementation_version, schema_version, available_at, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.available_at, 1
          WHERE NEW.state IN ('pending','retry_wait','quota_wait')
          ON CONFLICT(kind, implementation_version, schema_version, available_at)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_error_count(
          kind, implementation_version, schema_version, error_code, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.last_error_code, 1
          WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(kind, implementation_version, schema_version, error_code)
          DO UPDATE SET item_count = item_count + 1;
      END;

      CREATE TRIGGER ledger_status_work_update
      AFTER UPDATE OF state, kind, implementation_version, schema_version,
                      available_at, last_error_code ON work_item
      BEGIN
        UPDATE ledger_profile_state_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND state = OLD.state;
        DELETE FROM ledger_profile_state_count
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND state = OLD.state AND item_count = 0;
        UPDATE ledger_profile_availability_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND available_at = OLD.available_at
            AND OLD.state IN ('pending','retry_wait','quota_wait');
        DELETE FROM ledger_profile_availability_count
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version AND available_at = OLD.available_at
            AND item_count = 0;
        UPDATE ledger_profile_error_count SET item_count = item_count - 1
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version
            AND error_code = OLD.last_error_code;
        DELETE FROM ledger_profile_error_count
          WHERE kind = OLD.kind AND implementation_version = OLD.implementation_version
            AND schema_version = OLD.schema_version
            AND error_code = OLD.last_error_code AND item_count = 0;

        INSERT INTO ledger_profile_state_count(
          kind, implementation_version, schema_version, state, item_count
        ) VALUES(NEW.kind, NEW.implementation_version, NEW.schema_version, NEW.state, 1)
          ON CONFLICT(kind, implementation_version, schema_version, state)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_availability_count(
          kind, implementation_version, schema_version, available_at, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.available_at, 1
          WHERE NEW.state IN ('pending','retry_wait','quota_wait')
          ON CONFLICT(kind, implementation_version, schema_version, available_at)
          DO UPDATE SET item_count = item_count + 1;
        INSERT INTO ledger_profile_error_count(
          kind, implementation_version, schema_version, error_code, item_count
        )
          SELECT NEW.kind, NEW.implementation_version, NEW.schema_version,
                 NEW.last_error_code, 1
          WHERE NEW.last_error_code IS NOT NULL
          ON CONFLICT(kind, implementation_version, schema_version, error_code)
          DO UPDATE SET item_count = item_count + 1;
      END;

      CREATE TRIGGER ledger_status_event_insert
      AFTER INSERT ON work_event
      BEGIN
        UPDATE ledger_status_clock
          SET last_success_at = NEW.created_at
          WHERE singleton = 1 AND NEW.event_type IN ('succeeded','imported');
        UPDATE ledger_status_clock
          SET last_failure_at = NEW.created_at
          WHERE singleton = 1 AND NEW.event_type IN ('retry_wait','quota_wait','dead_letter','lease_expired');
        INSERT INTO ledger_profile_success_clock(
          kind, implementation_version, schema_version, last_success_at
        )
          SELECT kind, implementation_version, schema_version, NEW.created_at
          FROM work_item
          WHERE work_key = NEW.work_key AND NEW.event_type IN ('succeeded','imported')
          ON CONFLICT(kind, implementation_version, schema_version)
          DO UPDATE SET last_success_at = excluded.last_success_at;
      END;

    `,
  },
  {
    version: 38,
    statements: `
      DROP TRIGGER IF EXISTS retired_scheduler_state_reject_update;
      DROP TRIGGER IF EXISTS retired_scheduler_state_reject_delete;
      DROP TABLE retired_scheduler_state;
      DROP TABLE monitor_progress_history;
    `,
  },
  {
    version: 39,
    statements: `
      DROP TRIGGER ledger_status_paid_operation_insert;
      DROP TRIGGER ledger_status_paid_operation_update;
      DROP TABLE paid_operation_state_count;

      DROP TRIGGER source_author_metadata_revision_insert;
      DROP TRIGGER source_author_metadata_revision_update;
      DROP TRIGGER local_source_identity_reject_update;
      ALTER TABLE local_source_identity
        ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0
          CHECK(metadata_revision >= 0);
      UPDATE local_source_identity
        SET metadata_revision = (
          SELECT revision FROM source_author_metadata_revision WHERE singleton = 1
        )
        WHERE singleton = 1;
      DROP TABLE source_author_metadata_revision;
      CREATE TRIGGER local_source_identity_reject_update
      BEFORE UPDATE OF source_name, source_origin ON local_source_identity
      BEGIN SELECT RAISE(ABORT, 'LOCAL_SOURCE_IDENTITY_IMMUTABLE'); END;
      CREATE TRIGGER source_author_metadata_revision_insert
      AFTER INSERT ON source_author_metadata
      BEGIN
        UPDATE local_source_identity
        SET metadata_revision = metadata_revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER source_author_metadata_revision_update
      AFTER UPDATE ON source_author_metadata
      BEGIN
        UPDATE local_source_identity
        SET metadata_revision = metadata_revision + 1 WHERE singleton = 1;
      END;
    `,
  },
  {
    version: 40,
    statements: `
      ALTER TABLE local_schema ADD COLUMN sol_milestone_history_complete INTEGER NOT NULL DEFAULT 0
        CHECK(sol_milestone_history_complete IN (0, 1));
      ALTER TABLE local_schema ADD COLUMN sol_milestone_high_watermark INTEGER NOT NULL DEFAULT 0
        CHECK(sol_milestone_high_watermark >= 0);
      UPDATE local_schema SET
        sol_milestone_history_complete = CASE
          WHEN (SELECT COUNT(*) FROM sol_poem_milestone_backfill
                WHERE completed_at IS NOT NULL) = 2
            OR (SELECT MAX(high_watermark) FROM sol_poem_milestone_backfill) = 0
          THEN 1 ELSE 0 END,
        sol_milestone_high_watermark =
          (SELECT MAX(high_watermark) FROM sol_poem_milestone_backfill)
      WHERE singleton = 1;
      DROP TABLE sol_poem_milestone_backfill;
    `,
  },
];

export class LedgerMigrator implements LedgerMigrationPort {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  migrate(): number {
    // Inspect existing authority before even bootstrap DDL. Historical ledgers
    // must use the explicit schema34 staging/import path first.
    const objects = ExistingSchemaObjectsSchema.parse(
      this.#database.prepare(READ_USER_SCHEMA_OBJECTS).all(),
    );
    if (objects.length > 0) {
      if (!objects.some((object) => object.name === "local_schema"))
        throw new Error("RUNTIME_OWNER_UNVERSIONED_NONEMPTY_LEDGER");
      const existingVersion = LocalSchemaVersionRowSchema.parse(
        this.#database.prepare(READ_LOCAL_SCHEMA_VERSION_SQL).get(),
      ).version;
      if (existingVersion === 0)
        throw new Error("RUNTIME_OWNER_EXISTING_SCHEMA_ZERO");
      if (existingVersion < 34)
        throw new Error("RUNTIME_OWNER_REQUIRES_STAGED_SCHEMA34_IMPORT");
      if (existingVersion > CURRENT_SCHEMA_VERSION)
        throw new Error(
          `Ledger schema ${String(existingVersion)} is newer than supported schema ${String(CURRENT_SCHEMA_VERSION)}`,
        );
    }
    if (objects.length === 0) {
      // A second process can initialize this file while we wait for the
      // writer lock. Inspect again inside the transaction before choosing the
      // fresh bootstrap path, then use the ordinary upgrade path if we lost
      // that race. The initial inspection alone is not an ownership fence.
      const bootstrapped = this.#database
        .transaction(() => {
          if (this.#database.prepare(READ_USER_SCHEMA_OBJECTS).get())
            return false;
          this.#migrateInitialized(true);
          return true;
        })
        .immediate();
      if (bootstrapped) return CURRENT_SCHEMA_VERSION;
      return this.migrate();
    }
    return this.#migrateInitialized(false);
  }

  assertConfiguredSourceIdentity(): void {
    new LedgerMigrationEngine(this.#database).assertConfiguredSourceIdentity();
  }

  #migrateInitialized(fresh: boolean): number {
    if (
      fresh &&
      this.#database.prepare(READ_USER_SCHEMA_OBJECTS).get() !== undefined
    )
      throw new Error("RUNTIME_OWNER_FRESH_BOOTSTRAP_CHANGED");
    this.#database.exec(`
    CREATE TABLE IF NOT EXISTS local_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version INTEGER NOT NULL CHECK(version >= 0)
    ) STRICT;
    INSERT INTO local_schema(singleton, version) VALUES(1, 0) ON CONFLICT(singleton) DO NOTHING;
  `);
    const readVersion = (): number =>
      LocalSchemaVersionRowSchema.parse(
        this.#database.prepare(READ_LOCAL_SCHEMA_VERSION_SQL).get(),
      ).version;
    const initialVersion = readVersion();
    if (initialVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Ledger schema ${String(initialVersion)} is newer than supported schema ${String(CURRENT_SCHEMA_VERSION)}`,
      );
    }
    this.#applyMigrations(initialVersion, fresh, readVersion);
    this.assertConfiguredSourceIdentity();
    return CURRENT_SCHEMA_VERSION;
  }

  #applyMigrations(
    initialVersion: number,
    fresh: boolean,
    readVersion: () => number,
  ): void {
    for (const migration of MIGRATIONS) {
      if (migration.version <= initialVersion) continue;
      if (!fresh) this.#database.exec("BEGIN IMMEDIATE");
      try {
        // Another process may have completed this migration while this
        // connection waited for the writer lock. Re-read under that lock rather
        // than acting on the stale version observed before BEGIN IMMEDIATE.
        const lockedVersion = readVersion();
        if (lockedVersion >= migration.version) {
          if (!fresh) this.#database.exec("COMMIT");
          continue;
        }
        this.#assertMigrationPredecessor(migration.version, lockedVersion);
        if (migration.version === 35)
          this.#validateRuntimeOwnerMigration(initialVersion);
        new LedgerMigrationEngine(this.#database).apply(migration);
        if (!fresh) this.#database.exec("COMMIT");
      } catch (error) {
        if (!fresh) this.#database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  #assertMigrationPredecessor(version: number, lockedVersion: number): void {
    if (lockedVersion === version - 1) return;
    throw new Error(
      `Ledger migration ${String(version)} requires schema ${String(version - 1)}; received ${String(lockedVersion)}`,
    );
  }

  #validateRuntimeOwnerMigration(initialVersion: number): void {
    if (this.#database.name !== ":memory:") {
      const path = join(dirname(this.#database.name), "RUN.lock");
      if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
        throw new Error("RUNTIME_OWNER_MIGRATION_LEGACY_LOCK_PRESENT");
    }
    if (initialVersion === 0) return;
    this.assertConfiguredSourceIdentity();
    OwnerMigrationControlsSchema.parse(
      this.#database
        .prepare(
          `SELECT
      (SELECT enabled FROM runtime_control WHERE control_key='service_enabled') AS service,
      (SELECT enabled FROM runtime_control WHERE control_key='global_paused') AS global,
      (SELECT enabled FROM runtime_control WHERE control_key='paid_work_paused') AS paid,
      (SELECT enabled FROM runtime_control WHERE control_key='legacy_pause_imported') AS pauseImported,
      (SELECT enabled FROM runtime_control WHERE control_key='legacy_service_imported') AS serviceImported,
      (SELECT COUNT(*) FROM work_item WHERE kind='poem-enrichment-sol' AND state='running') AS runningSol`,
        )
        .get(),
    );
    new SolOperationStore(this.#database).assertImported();
  }
}

/** Internal schema mechanics, not an operator entrypoint. The guarded caller
 * owns the transaction and admission policy; this never commits or acquires ownership. */
export class LedgerMigrationEngine implements MigrationEnginePort {
  readonly #database: Database.Database;
  constructor(database: Database.Database) {
    this.#database = database;
  }

  apply(migration: Migration): void {
    if (!this.#database.inTransaction)
      throw new Error("MIGRATION_ENGINE_REQUIRES_TRANSACTION");
    const version = LocalSchemaVersionRowSchema.parse(
      this.#database.prepare(READ_LOCAL_SCHEMA_VERSION_SQL).get(),
    ).version;
    if (version !== migration.version - 1)
      throw new Error("MIGRATION_ENGINE_VERSION_FENCE");
    if (migration.version === 8) this.#validatePoemIdentityBackfill();
    if (migration.version === 9 || migration.version === 10)
      this.#validateWorkDefinitions();
    if (migration.version === 29) this.#validateVersion28SourceIdentity();
    this.#database.exec(migration.statements);
    if (migration.version === 28) this.#retireObsoleteSchedulerState();
    if (migration.version === 29) this.#seedSourceIdentity();
    const advanced = this.#database
      .prepare(
        "UPDATE local_schema SET version = ? WHERE singleton = 1 AND version = ?",
      )
      .run(migration.version, version);
    if (advanced.changes !== 1)
      throw new Error("Ledger migration version fence was lost");
  }

  assertConfiguredSourceIdentity(): void {
    const schema = LocalSchemaVersionRowSchema.parse(
      this.#database.prepare(READ_LOCAL_SCHEMA_VERSION_SQL).get(),
    );
    // Read-only commands may intentionally inspect an older ledger before an
    // explicit apply path upgrades it. Schema 29 is the first version with a
    // durable source-identity fence; all ledgers at or beyond it must match.
    if (schema.version < 29) return;
    const configured = currentSource();
    const persisted = LocalSourceIdentityRowSchema.parse(
      this.#database
        .prepare(
          `SELECT source_name, source_origin
             FROM local_source_identity WHERE singleton = 1`,
        )
        .get(),
    );
    if (
      persisted.source_name !== configured.name ||
      persisted.source_origin !== configured.origin
    ) {
      throw new Error("LOCAL_SOURCE_IDENTITY_MISMATCH");
    }
  }

  #seedSourceIdentity(): void {
    const configured = currentSource();
    const inserted = this.#database
      .prepare(
        `INSERT INTO local_source_identity(
           singleton, source_name, source_origin
         ) VALUES(1, ?, ?)
         ON CONFLICT(singleton) DO NOTHING`,
      )
      .run(configured.name, configured.origin);
    if (inserted.changes !== 1) {
      throw new Error("LOCAL_SOURCE_IDENTITY_SEED_FAILED");
    }
  }

  #validateVersion28SourceIdentity(): void {
    const configured = currentSource();
    const authorMetadataSql = SqliteSchemaSqlRowSchema.parse(
      this.#database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'table' AND name = 'source_author_metadata'`,
        )
        .get(),
    ).sql;
    const poemIdentitySql = SqliteSchemaSqlRowSchema.parse(
      this.#database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'table' AND name = 'poem_identity'`,
        )
        .get(),
    ).sql;
    const poemDefinitionIndexSql = SqliteSchemaSqlRowSchema.parse(
      this.#database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'index'
              AND name = 'work_item_poem_definition_unique'`,
        )
        .get(),
    ).sql;

    const expectedSourceConstraint = `CHECK(source_name = ${sqlText(configured.name)})`;
    const expectedPoemPrefix = sqlText(`${configured.origin}/poem`);
    const expectedPoemKind = sqlText(`${configured.name}_poem_detail`);
    if (
      !authorMetadataSql.includes(expectedSourceConstraint) ||
      !poemIdentitySql.includes(expectedPoemPrefix) ||
      !poemDefinitionIndexSql.includes(`WHERE kind = ${expectedPoemKind}`)
    ) {
      throw new Error(
        "LOCAL_SOURCE_IDENTITY_MISMATCH: configured source does not match the durable v28 ledger schema",
      );
    }
  }

  #retireObsoleteSchedulerState(): void {
    const authority = SchedulerStateAuthorityRowSchema.nullable().parse(
      this.#database
        .prepare(
          `SELECT state_json, state_digest FROM scheduler_state
           WHERE state_key = 'provider-v10:sol'`,
        )
        .get() ?? null,
    );
    if (
      !authority ||
      schedulerStateSchemaVersion(authority.state_json) !== 10 ||
      hash("sha256", authority.state_json, "hex") !== authority.state_digest
    )
      return;
    this.#database
      .prepare(
        `DELETE FROM scheduler_state
          WHERE state_key IN (
            'provider-v10:agy', 'provider-v10:claude',
            'provider:agy', 'provider:claude'
          )`,
      )
      .run();
  }

  #validateWorkDefinitions(): void {
    const invalid = this.#database
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM work_item
       WHERE CASE
           WHEN json_valid(input_json) THEN json_type(input_json) IS NOT 'object'
           ELSE 1
         END
         OR length(work_key) <> 64
         OR work_key GLOB '*[^0-9a-f]*'
         OR length(input_hash) <> 64
         OR input_hash GLOB '*[^0-9a-f]*'
         OR length(trim(kind)) NOT BETWEEN 1 AND 100
         OR length(trim(schema_version)) NOT BETWEEN 1 AND 100
         OR length(trim(implementation_version)) NOT BETWEEN 1 AND 100
         OR priority NOT BETWEEN -1000000 AND 1000000`,
      )
      .get();
    if ((invalid?.count ?? 0) > 0) {
      throw new Error(
        `WORK_ITEM_DEFINITION_INVALID_MIGRATION: ${String(invalid?.count ?? 0)} work item(s) have invalid definition or priority metadata`,
      );
    }
  }

  #validatePoemIdentityBackfill(): void {
    const source = currentSource();
    const poemUrlPrefix = `${source.origin}/poem`;
    const invalidJson = this.#database
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) AS count FROM work_item
       WHERE kind = ? AND NOT json_valid(input_json)`,
      )
      .get(collectionWorkKinds().poemDetail);
    if ((invalidJson?.count ?? 0) > 0) {
      throw new Error(
        `SOURCE_POEM_IDENTITY_INVALID: ${String(invalidJson?.count ?? 0)} work item(s) contain invalid JSON`,
      );
    }
    const malformed = this.#database
      .prepare<
        [string, string, string, string, string, string, string],
        { count: number }
      >(
        `SELECT COUNT(*) AS count FROM work_item
       WHERE kind = ?
         AND (json_type(input_json, '$.poemHref') IS NOT 'text'
           OR json_type(input_json, '$.authorHref') IS NOT 'text'
           OR json_extract(input_json, '$.poemHref') = ''
           OR json_extract(input_json, '$.authorHref') = ''
           OR json_extract(input_json, '$.poemHref') NOT GLOB (? || '[1-9]*.html')
           OR substr(
             json_extract(input_json, '$.poemHref'),
             length(?) + 1,
             length(json_extract(input_json, '$.poemHref'))
               - length(?) - length('.html')
           ) GLOB '*[^0-9]*'
           OR length(json_extract(input_json, '$.poemHref'))
             - length(?) - length('.html') > 16
           OR (
             length(json_extract(input_json, '$.poemHref'))
               - length(?) - length('.html') = 16
             AND substr(
               json_extract(input_json, '$.poemHref'),
               length(?) + 1,
               16
             ) > '9007199254740991'
           ))`,
      )
      .get(
        collectionWorkKinds().poemDetail,
        poemUrlPrefix,
        poemUrlPrefix,
        poemUrlPrefix,
        poemUrlPrefix,
        poemUrlPrefix,
        poemUrlPrefix,
      );
    if ((malformed?.count ?? 0) > 0) {
      throw new Error(
        `SOURCE_POEM_IDENTITY_INVALID: ${String(malformed?.count ?? 0)} work item(s) lack canonical identity fields`,
      );
    }
    const conflict = this.#database
      .prepare<[string], { author_count: number; poem_href: string }>(
        `SELECT json_extract(input_json, '$.poemHref') AS poem_href,
              COUNT(DISTINCT json_extract(input_json, '$.authorHref')) AS author_count
       FROM work_item
       WHERE kind = ?
       GROUP BY json_extract(input_json, '$.poemHref')
       HAVING author_count > 1
       ORDER BY poem_href
       LIMIT 1`,
      )
      .get(collectionWorkKinds().poemDetail);
    if (conflict) {
      throw new Error(
        `SOURCE_POEM_DUPLICATE_MIGRATION: ${conflict.poem_href} is claimed by ${String(conflict.author_count)} authors`,
      );
    }
  }
}
