-- Stage the production identity on the existing writer control singleton.
-- The old table remains until the new Worker is deployed and its guard is live.
ALTER TABLE scraper_writer_control ADD COLUMN database_id TEXT CHECK ( -- sarj-noqa: SARJ102 — Wrangler applies this D1 migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
  database_id IS NULL OR (
    length(database_id) = 36
    AND database_id GLOB '[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*'
  )
);

CREATE TABLE IF NOT EXISTS _database_identity_fold_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;
INSERT INTO _database_identity_fold_guard (invalid_count) -- sarj-noqa: SARJ105 — Reject a missing or unexpected production identity.
SELECT CASE WHEN
  (SELECT count(*) FROM production_deployment_identity) = 1
  AND (SELECT count(*) FROM scraper_writer_control WHERE singleton = 1) = 1
  AND (SELECT database_id FROM production_deployment_identity
       WHERE scope = 'production') = 'ffaae610-4dae-4d7e-bf86-8232f46ca2b5'
THEN 0 ELSE 1 END;

UPDATE scraper_writer_control
SET database_id = (
  SELECT database_id FROM production_deployment_identity
  WHERE scope = 'production'
)
WHERE singleton = 1;

INSERT INTO _database_identity_fold_guard (invalid_count) -- sarj-noqa: SARJ105 — Require exact parity before dropping the old table.
SELECT count(*) FROM scraper_writer_control control
WHERE control.singleton = 1
  AND control.database_id IS NOT (
    SELECT database_id FROM production_deployment_identity
    WHERE scope = 'production'
  );
DROP TABLE IF EXISTS _database_identity_fold_guard; -- sarj-noqa: SARJ119 — D1 atomically rolls back the guarded singleton copy on failure.

CREATE TRIGGER scraper_writer_database_identity_immutable
BEFORE UPDATE OF database_id ON scraper_writer_control
WHEN NEW.database_id IS NOT OLD.database_id
BEGIN
  SELECT RAISE(ABORT, 'PRODUCTION_DATABASE_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER production_deployment_identity_update_guard
BEFORE UPDATE ON production_deployment_identity
WHEN NEW.scope IS NOT OLD.scope OR NEW.database_id IS NOT OLD.database_id
BEGIN
  SELECT RAISE(ABORT, 'PRODUCTION_DATABASE_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER production_deployment_identity_delete_forbidden
BEFORE DELETE ON production_deployment_identity
BEGIN
  SELECT RAISE(ABORT, 'PRODUCTION_DATABASE_IDENTITY_IMMUTABLE');
END;
