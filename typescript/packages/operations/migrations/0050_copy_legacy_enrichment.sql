-- Copy legacy artifacts and validation evidence into the model-scoped ledger.
-- Keep the old storage until the new site reader has deployed and live parity
-- checks pass. A later migration retires the old tables and poem columns.
CREATE TABLE IF NOT EXISTS _legacy_enrichment_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

CREATE TABLE IF NOT EXISTS _legacy_enrichment_map (
  legacy_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  model_key TEXT NOT NULL
);

INSERT INTO _legacy_enrichment_map (legacy_id, model_id, model_key) -- sarj-noqa: SARJ105 — Duplicate legacy identities must abort this ledgered migration.
SELECT legacy.id,
       COALESCE(current.id, 'legacy/' || legacy.id),
       profile.public_track_key
FROM enrichment_artifact legacy
JOIN poem_source_revision revision ON revision.id = legacy.source_revision_id
JOIN enrichment_profile profile
  ON profile.runtime_model_id = legacy.model
 AND profile.prompt_version = legacy.prompt_version
 AND profile.reasoning_effort = legacy.reasoning_effort
 AND profile.input_schema_version = revision.schema_version
 AND profile.output_schema_version = legacy.schema_version
LEFT JOIN model_enrichment_artifact current
  ON current.source_revision_id = legacy.source_revision_id
 AND current.payload_hash = legacy.payload_hash
 AND current.model_key = profile.public_track_key;

INSERT INTO _legacy_enrichment_guard -- sarj-noqa: SARJ105 — Any count mismatch must abort the migration.
SELECT (SELECT count(*) FROM enrichment_artifact)
     - (SELECT count(*) FROM _legacy_enrichment_map);

-- An existing hash identity can be reused only when its actual payload and
-- recipe agree. Never attach old validation evidence to a different recipe.
INSERT INTO _legacy_enrichment_guard -- sarj-noqa: SARJ105 — Recipe drift must abort the migration.
SELECT count(*)
FROM _legacy_enrichment_map map
JOIN enrichment_artifact legacy ON legacy.id = map.legacy_id
JOIN model_enrichment_artifact current ON current.id = map.model_id
WHERE current.source_revision_id IS NOT legacy.source_revision_id
   OR current.payload_hash IS NOT legacy.payload_hash
   OR current.payload IS NOT legacy.payload
   OR current.model IS NOT legacy.model
   OR current.prompt_version IS NOT legacy.prompt_version
   OR current.reasoning_effort IS NOT legacy.reasoning_effort
   OR current.schema_version IS NOT legacy.schema_version
   OR current.model_key IS NOT map.model_key;

INSERT INTO _legacy_enrichment_guard -- sarj-noqa: SARJ105 — An identity collision must abort the migration.
SELECT count(*)
FROM _legacy_enrichment_map map
JOIN enrichment_artifact legacy ON legacy.id = map.legacy_id
WHERE NOT EXISTS (
    SELECT 1 FROM model_enrichment_artifact WHERE id = map.model_id
  ) AND EXISTS (
      SELECT 1 FROM model_enrichment_artifact current
      WHERE current.task_key = 'legacy/' || legacy.id
        AND current.variant = legacy.variant
        AND current.model_key = map.model_key
  );

INSERT INTO model_enrichment_artifact ( -- sarj-noqa: SARJ105 — Immutable artifact collisions must abort the migration.
  id, source_revision_id, task_key, variant, schema_version, prompt_version,
  model, model_key, reasoning_effort, payload_hash, payload, created_at
)
SELECT map.model_id, legacy.source_revision_id, 'legacy/' || legacy.id,
       legacy.variant, legacy.schema_version, legacy.prompt_version,
       legacy.model, map.model_key, legacy.reasoning_effort,
       legacy.payload_hash, legacy.payload, legacy.created_at
FROM enrichment_artifact legacy
JOIN _legacy_enrichment_map map ON map.legacy_id = legacy.id
WHERE NOT EXISTS (
  SELECT 1 FROM model_enrichment_artifact current WHERE current.id = map.model_id
);

-- Keep the exact report bytes and validator identity. Identical evidence that
-- already exists on a reused model artifact needs no duplicate row.
INSERT INTO _legacy_enrichment_guard -- sarj-noqa: SARJ105 — Conflicting validation evidence must abort the migration.
SELECT count(*)
FROM enrichment_validation legacy
JOIN _legacy_enrichment_map map ON map.legacy_id = legacy.artifact_id
JOIN model_enrichment_validation current
  ON current.artifact_id = map.model_id
 AND current.validator_key = legacy.validator_key
 AND current.validator_version = legacy.validator_version
 AND current.attempt = legacy.attempt
WHERE current.outcome IS NOT legacy.outcome
   OR current.highest_severity IS NOT legacy.highest_severity
   OR current.report_hash IS NOT legacy.report_hash
   OR current.report IS NOT legacy.report;

INSERT INTO model_enrichment_validation ( -- sarj-noqa: SARJ105 — Immutable validation collisions must abort the migration.
  id, artifact_id, validator_key, validator_version, attempt, outcome,
  highest_severity, report_hash, report, created_at
)
SELECT 'legacy/' || legacy.id, map.model_id, legacy.validator_key,
       legacy.validator_version, legacy.attempt, legacy.outcome,
       legacy.highest_severity, legacy.report_hash, legacy.report,
       legacy.created_at
FROM enrichment_validation legacy
JOIN _legacy_enrichment_map map ON map.legacy_id = legacy.artifact_id
WHERE NOT EXISTS (
  SELECT 1 FROM model_enrichment_validation current
  WHERE current.artifact_id = map.model_id
    AND current.validator_key = legacy.validator_key
    AND current.validator_version = legacy.validator_version
    AND current.attempt = legacy.attempt
);

-- A newer model publication is authoritative. Add only current-revision
-- legacy publications for poems that lack that model track entirely.
-- A stale model pointer would hide an otherwise current legacy publication.
-- Stop for explicit repair instead of silently losing its visible translation.
INSERT INTO _legacy_enrichment_guard -- sarj-noqa: SARJ105 — A conflicting stale publication must abort the copy.
SELECT count(*)
FROM poem_publication_pointer legacy
JOIN poem canonical ON canonical.id = legacy.poem_id
JOIN _legacy_enrichment_map map ON map.legacy_id = legacy.enrichment_artifact_id
JOIN poem_model_publication_pointer current
  ON current.poem_id = legacy.poem_id AND current.model_key = map.model_key
WHERE canonical.active_source_revision_id = legacy.source_revision_id
  AND current.source_revision_id IS NOT legacy.source_revision_id;

INSERT INTO poem_model_publication_pointer ( -- sarj-noqa: SARJ105 — Conflicting current pointers must abort the migration.
  poem_id, model_key, source_revision_id, enrichment_artifact_id,
  pointer_version, writer_epoch, updated_at
)
SELECT legacy.poem_id, map.model_key, legacy.source_revision_id,
       map.model_id, 1, control.writer_epoch, legacy.updated_at
FROM poem_publication_pointer legacy
JOIN poem canonical ON canonical.id = legacy.poem_id
JOIN _legacy_enrichment_map map ON map.legacy_id = legacy.enrichment_artifact_id
JOIN scraper_writer_control control ON control.singleton = 1
WHERE canonical.active_source_revision_id = legacy.source_revision_id
  AND NOT EXISTS (
    SELECT 1 FROM poem_model_publication_pointer current
    WHERE current.poem_id = legacy.poem_id AND current.model_key = map.model_key
  );

-- All legacy rows must now resolve to immutable model rows before the old
-- storage and its foreign keys are retired.
INSERT INTO _legacy_enrichment_guard -- sarj-noqa: SARJ105 — Unmapped artifacts must abort the migration.
SELECT count(*) FROM _legacy_enrichment_map map
LEFT JOIN model_enrichment_artifact current ON current.id = map.model_id
WHERE current.id IS NULL;
INSERT INTO _legacy_enrichment_guard -- sarj-noqa: SARJ105 — Missing validation evidence must abort the migration.
SELECT count(*) FROM enrichment_validation legacy
JOIN _legacy_enrichment_map map ON map.legacy_id = legacy.artifact_id
WHERE NOT EXISTS (
  SELECT 1 FROM model_enrichment_validation current
  WHERE current.artifact_id = map.model_id
    AND current.validator_key = legacy.validator_key
    AND current.validator_version = legacy.validator_version
    AND current.attempt = legacy.attempt
);

DROP TABLE IF EXISTS _legacy_enrichment_map;
DROP TABLE IF EXISTS _legacy_enrichment_guard;
