-- The old pointer and review tables are retained until the model ledger has
-- passed a second parity check immediately before the tables are dropped.
CREATE TABLE IF NOT EXISTS _legacy_enrichment_drop_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;

INSERT INTO _legacy_enrichment_drop_guard (invalid_count) -- sarj-noqa: SARJ105 — No artifact may disappear in the contract.
SELECT count(*)
FROM enrichment_artifact legacy
JOIN poem_source_revision revision ON revision.id = legacy.source_revision_id
LEFT JOIN enrichment_profile profile
  ON profile.runtime_model_id = legacy.model
 AND profile.prompt_version = legacy.prompt_version
 AND profile.reasoning_effort = legacy.reasoning_effort
 AND profile.input_schema_version = revision.schema_version
 AND profile.output_schema_version = legacy.schema_version
LEFT JOIN model_enrichment_artifact current
  ON current.source_revision_id = legacy.source_revision_id
 AND current.payload_hash = legacy.payload_hash
 AND current.model_key = profile.public_track_key
WHERE current.id IS NULL
   OR current.payload IS NOT legacy.payload
   OR current.model IS NOT legacy.model
   OR current.prompt_version IS NOT legacy.prompt_version
   OR current.reasoning_effort IS NOT legacy.reasoning_effort
   OR current.schema_version IS NOT legacy.schema_version;

INSERT INTO _legacy_enrichment_drop_guard (invalid_count) -- sarj-noqa: SARJ105 — No validator evidence may disappear in the contract.
SELECT count(*)
FROM enrichment_validation legacy
JOIN enrichment_artifact artifact ON artifact.id = legacy.artifact_id
JOIN poem_source_revision revision ON revision.id = artifact.source_revision_id
LEFT JOIN enrichment_profile profile
  ON profile.runtime_model_id = artifact.model
 AND profile.prompt_version = artifact.prompt_version
 AND profile.reasoning_effort = artifact.reasoning_effort
 AND profile.input_schema_version = revision.schema_version
 AND profile.output_schema_version = artifact.schema_version
LEFT JOIN model_enrichment_artifact current_artifact
  ON current_artifact.source_revision_id = artifact.source_revision_id
 AND current_artifact.payload_hash = artifact.payload_hash
 AND current_artifact.model_key = profile.public_track_key
LEFT JOIN model_enrichment_validation current
  ON current.artifact_id = current_artifact.id
 AND current.validator_key = legacy.validator_key
 AND current.validator_version = legacy.validator_version
 AND current.attempt = legacy.attempt
WHERE current.id IS NULL
   OR current.outcome IS NOT legacy.outcome
   OR current.highest_severity IS NOT legacy.highest_severity
   OR current.report_hash IS NOT legacy.report_hash
   OR current.report IS NOT legacy.report;

INSERT INTO _legacy_enrichment_drop_guard (invalid_count) -- sarj-noqa: SARJ105 — Active old publications must remain in the model ledger.
SELECT count(*)
FROM poem_publication_pointer legacy
JOIN poem canonical ON canonical.id = legacy.poem_id
JOIN enrichment_artifact old_artifact
  ON old_artifact.id = legacy.enrichment_artifact_id
JOIN poem_source_revision revision ON revision.id = old_artifact.source_revision_id
LEFT JOIN enrichment_profile profile
  ON profile.runtime_model_id = old_artifact.model
 AND profile.prompt_version = old_artifact.prompt_version
 AND profile.reasoning_effort = old_artifact.reasoning_effort
 AND profile.input_schema_version = revision.schema_version
 AND profile.output_schema_version = old_artifact.schema_version
LEFT JOIN poem_model_publication_pointer publication
  ON publication.poem_id = legacy.poem_id
 AND publication.model_key = profile.public_track_key
LEFT JOIN model_enrichment_artifact current
  ON current.id = publication.enrichment_artifact_id
WHERE canonical.active_source_revision_id = legacy.source_revision_id
  AND (publication.poem_id IS NULL
    OR publication.source_revision_id IS NOT legacy.source_revision_id
    OR current.source_revision_id IS NOT legacy.source_revision_id
    OR current.model_key IS NOT profile.public_track_key);

DROP TABLE IF EXISTS _legacy_enrichment_drop_guard; -- sarj-noqa: SARJ119 — D1 rolls back the table contract if any parity check fails.
DROP TABLE IF EXISTS poem_publication_pointer;
DROP TABLE IF EXISTS enrichment_validation;
DROP TABLE IF EXISTS enrichment_artifact;
