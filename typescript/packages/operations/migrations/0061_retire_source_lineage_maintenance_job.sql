-- PR12 removed the minutely lineage cron and its only writer. The deployed
-- singleton has remained idle, without a lease, since 2026-09-23 12:52 UTC.
-- Recreate the old shape only on fresh installs so the same guarded contract
-- can run after the rebuilt 0037 baseline, which omitted this legacy table.
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

CREATE TABLE IF NOT EXISTS _source_lineage_job_retirement_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;

INSERT INTO _source_lineage_job_retirement_guard (invalid_count) -- sarj-noqa: SARJ105 — Abort if the legacy writer resumed or the observed singleton changed.
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

DROP TABLE IF EXISTS _source_lineage_job_retirement_guard; -- sarj-noqa: SARJ119 — D1 rolls back the contract if the old job changed after its read-only audit.
DROP TABLE IF EXISTS source_lineage_maintenance_job;
