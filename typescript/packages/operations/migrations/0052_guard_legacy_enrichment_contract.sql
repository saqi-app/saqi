-- Prove the copy migration is still complete before the first destructive
-- change. A stale legacy writer or any divergent payload aborts this migration.
CREATE TABLE IF NOT EXISTS _legacy_contract_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;
CREATE TABLE IF NOT EXISTS _legacy_contract_map (
  legacy_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  model_key TEXT NOT NULL
) STRICT;

INSERT INTO _legacy_contract_map (legacy_id, model_id, model_key) -- sarj-noqa: SARJ105 — Ambiguous profile identities must abort the contract.
SELECT legacy.id, current.id, profile.public_track_key
FROM enrichment_artifact legacy
JOIN poem_source_revision revision ON revision.id = legacy.source_revision_id
JOIN enrichment_profile profile
  ON profile.runtime_model_id = legacy.model
 AND profile.prompt_version = legacy.prompt_version
 AND profile.reasoning_effort = legacy.reasoning_effort
 AND profile.input_schema_version = revision.schema_version
 AND profile.output_schema_version = legacy.schema_version
JOIN model_enrichment_artifact current
  ON current.source_revision_id = legacy.source_revision_id
 AND current.payload_hash = legacy.payload_hash
 AND current.model_key = profile.public_track_key;

INSERT INTO _legacy_contract_guard (invalid_count) -- sarj-noqa: SARJ105 — Every legacy artifact must have a model copy.
SELECT (SELECT count(*) FROM enrichment_artifact)
     - (SELECT count(*) FROM _legacy_contract_map);

INSERT INTO _legacy_contract_guard (invalid_count) -- sarj-noqa: SARJ105 — Content or recipe divergence must abort the contract.
SELECT count(*)
FROM _legacy_contract_map map
JOIN enrichment_artifact legacy ON legacy.id = map.legacy_id
JOIN model_enrichment_artifact current ON current.id = map.model_id
WHERE current.source_revision_id IS NOT legacy.source_revision_id
   OR current.payload_hash IS NOT legacy.payload_hash
   OR current.payload IS NOT legacy.payload
   OR current.model IS NOT legacy.model
   OR current.prompt_version IS NOT legacy.prompt_version
   OR current.reasoning_effort IS NOT legacy.reasoning_effort
   OR current.schema_version IS NOT legacy.schema_version;

INSERT INTO _legacy_contract_guard (invalid_count) -- sarj-noqa: SARJ105 — Every validation must retain its exact result and report.
SELECT count(*)
FROM enrichment_validation legacy
LEFT JOIN _legacy_contract_map map ON map.legacy_id = legacy.artifact_id
LEFT JOIN model_enrichment_validation current
  ON current.artifact_id = map.model_id
 AND current.validator_key = legacy.validator_key
 AND current.validator_version = legacy.validator_version
 AND current.attempt = legacy.attempt
WHERE current.id IS NULL
   OR current.outcome IS NOT legacy.outcome
   OR current.highest_severity IS NOT legacy.highest_severity
   OR current.report_hash IS NOT legacy.report_hash
   OR current.report IS NOT legacy.report;

INSERT INTO _legacy_contract_guard (invalid_count) -- sarj-noqa: SARJ105 — Active legacy publications must have a visible current-revision model track.
SELECT count(*)
FROM poem_publication_pointer legacy
JOIN poem canonical ON canonical.id = legacy.poem_id
LEFT JOIN _legacy_contract_map map ON map.legacy_id = legacy.enrichment_artifact_id
LEFT JOIN poem_model_publication_pointer publication
  ON publication.poem_id = legacy.poem_id
 AND publication.model_key = map.model_key
LEFT JOIN model_enrichment_artifact artifact
  ON artifact.id = publication.enrichment_artifact_id
WHERE canonical.active_source_revision_id = legacy.source_revision_id
  AND (map.legacy_id IS NULL
    OR publication.poem_id IS NULL
    OR publication.source_revision_id IS NOT legacy.source_revision_id
    OR artifact.source_revision_id IS NOT legacy.source_revision_id
    OR artifact.model_key IS NOT map.model_key);

DROP TABLE IF EXISTS _legacy_contract_map; -- sarj-noqa: SARJ119 — D1 migration transaction guards the read-only parity scan and schema change.
DROP TABLE IF EXISTS _legacy_contract_guard; -- sarj-noqa: SARJ119 — Any failed parity assertion rolls back this entire migration.

-- This foreign key is the last relation from poem to the old artifact table.
DROP INDEX IF EXISTS idx_poem_active_enrichment_artifact;
ALTER TABLE poem DROP COLUMN active_enrichment_artifact_id;
