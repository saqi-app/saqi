-- The operations Worker reads the writer-control identity after 0056.
-- Require exact singleton parity before retiring the duplicate identity table.
CREATE TABLE IF NOT EXISTS _database_identity_contract_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;

INSERT INTO _database_identity_contract_guard (invalid_count) -- sarj-noqa: SARJ105 — Abort the contract unless both singleton identities match production.
SELECT CASE WHEN
  (SELECT count(*) FROM production_deployment_identity) = 1
  AND (SELECT count(*) FROM scraper_writer_control) = 1
  AND (SELECT database_id FROM production_deployment_identity
       WHERE scope = 'production') = 'ffaae610-4dae-4d7e-bf86-8232f46ca2b5'
  AND (SELECT database_id FROM scraper_writer_control
       WHERE singleton = 1) = 'ffaae610-4dae-4d7e-bf86-8232f46ca2b5'
THEN 0 ELSE 1 END;

DROP TABLE IF EXISTS _database_identity_contract_guard; -- sarj-noqa: SARJ119 — D1 rolls back the table contract on parity failure.
DROP TRIGGER IF EXISTS production_deployment_identity_update_guard;
DROP TRIGGER IF EXISTS production_deployment_identity_delete_forbidden;
DROP TABLE IF EXISTS production_deployment_identity;
