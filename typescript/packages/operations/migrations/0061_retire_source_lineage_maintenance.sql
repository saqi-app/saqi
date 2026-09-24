-- PR12 removed the minutely lineage cron and its only writer. The deployed
-- singleton and conflict ledger have not changed since 2026-09-23 12:52 UTC.
-- Recreate the old shapes only on fresh installs so the same guarded contract
-- can run after the rebuilt 0037 baseline, which omitted both legacy tables.
CREATE TABLE IF NOT EXISTS source_lineage_maintenance_job ( -- sarj-noqa: SARJ102 — Existing D1 databases retain this historical table; fresh installs create and immediately retire it.
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('idle', 'active', 'blocked', 'failed', 'complete')),
  cursor_poem_id TEXT,
  pass INTEGER NOT NULL DEFAULT 0 CHECK (pass >= 0),
  lease_owner TEXT,
  lease_token TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at INTEGER,
  scanned_total INTEGER NOT NULL DEFAULT 0 CHECK (scanned_total >= 0),
  adopted_total INTEGER NOT NULL DEFAULT 0 CHECK (adopted_total >= 0),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (cursor_poem_id) REFERENCES poem(id) ON DELETE RESTRICT,
  CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND length(lease_token) = 36
      AND lease_expires_at IS NOT NULL AND lease_expires_at >= 0)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS source_lineage_conflict ( -- sarj-noqa: SARJ102 — Existing D1 databases retain this historical table; fresh installs create and immediately retire it.
  poem_id TEXT PRIMARY KEY,
  error_code TEXT NOT NULL CHECK (
    length(error_code) BETWEEN 3 AND 100
    AND error_code NOT GLOB '*[^A-Z0-9_]*'
  ),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= last_seen_at),
  FOREIGN KEY (poem_id) REFERENCES poem(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS _source_lineage_retirement_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;

INSERT INTO _source_lineage_retirement_guard (invalid_count) -- sarj-noqa: SARJ105 — Abort if the legacy writer resumed or the observed singleton changed.
SELECT CASE WHEN
  (SELECT count(*) FROM source_lineage_maintenance_job) <= 1
  AND NOT EXISTS (
    SELECT 1 FROM source_lineage_maintenance_job
    WHERE singleton IS NOT 1
      OR state IS NOT 'idle'
      OR pass IS NOT 0
      OR lease_owner IS NOT NULL
      OR lease_token IS NOT NULL
      OR lease_expires_at IS NOT NULL
      OR lease_epoch IS NOT 3383
      OR scanned_total IS NOT 65950
      OR adopted_total IS NOT 63521
      OR last_error_code IS NOT NULL
      OR updated_at IS NOT 1790167946843
  )
THEN 0 ELSE 1 END;

INSERT INTO _source_lineage_retirement_guard (invalid_count) -- sarj-noqa: SARJ105 — Abort if historical conflict rows changed after the read-only audit.
SELECT CASE WHEN
  (SELECT count(*) FROM source_lineage_conflict) = 0
  OR (
    (SELECT count(*) FROM source_lineage_conflict) = 2422
    AND (SELECT count(*) FROM source_lineage_conflict
         WHERE resolved_at IS NULL) = 2422
    AND (SELECT min(first_seen_at) FROM source_lineage_conflict) = 1788834715408
    AND (SELECT max(last_seen_at) FROM source_lineage_conflict) = 1790167946719
  )
THEN 0 ELSE 1 END;

INSERT INTO _source_lineage_retirement_guard (invalid_count) -- sarj-noqa: SARJ105 — Abort if a table, trigger, or view still depends on either retired table.
SELECT count(*) FROM sqlite_schema schema
WHERE (schema.type IN ('trigger', 'view')
       AND (schema.sql LIKE '%source_lineage_maintenance_job%'
         OR schema.sql LIKE '%source_lineage_conflict%'))
   OR (schema.type = 'table' AND schema.name NOT IN (
         'source_lineage_maintenance_job', 'source_lineage_conflict'
       ) AND EXISTS (
         SELECT 1 FROM pragma_foreign_key_list(schema.name) foreign_key
         WHERE foreign_key."table" IN (
           'source_lineage_maintenance_job', 'source_lineage_conflict'
         )
       ));

DROP TABLE IF EXISTS _source_lineage_retirement_guard; -- sarj-noqa: SARJ119 — D1 rolls back the contract if the old lineage state changed after its read-only audit.
DROP TABLE IF EXISTS source_lineage_maintenance_job;
DROP TABLE IF EXISTS source_lineage_conflict;
