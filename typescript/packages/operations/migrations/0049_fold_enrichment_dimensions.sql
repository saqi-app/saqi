-- Every published profile must resolve all three dimensions before the
-- immutable registry is folded. Unused dimension rows have no consumers.
CREATE TABLE IF NOT EXISTS _enrichment_dimension_fold_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO _enrichment_dimension_fold_guard (invalid_count) -- sarj-noqa: SARJ105 — Fail atomically if any published profile has missing provenance.
SELECT count(*) FROM enrichment_profile profile
LEFT JOIN ai_model model ON model.model_key = profile.model_key
LEFT JOIN ai_vendor vendor ON vendor.vendor_key = model.vendor_key
LEFT JOIN inference_backend backend ON backend.backend_key = profile.backend_key
WHERE model.model_key IS NULL OR vendor.vendor_key IS NULL
   OR backend.backend_key IS NULL;

DROP TABLE IF EXISTS _enrichment_dimension_fold_guard; -- sarj-noqa: SARJ119 — D1 holds the SQLite write lock for this bounded registry copy; a failed guard or copy rolls back the transaction, and the postcondition is one lossless profile row per old profile.

CREATE TABLE IF NOT EXISTS enrichment_profile_with_metadata (
  profile_key TEXT PRIMARY KEY CHECK (length(trim(profile_key)) BETWEEN 1 AND 300),
  public_track_key TEXT NOT NULL CHECK (length(trim(public_track_key)) BETWEEN 1 AND 200),
  model_key TEXT NOT NULL CHECK (length(trim(model_key)) BETWEEN 1 AND 200),
  backend_key TEXT NOT NULL CHECK (length(trim(backend_key)) BETWEEN 1 AND 100),
  vendor_key TEXT NOT NULL CHECK (length(trim(vendor_key)) BETWEEN 1 AND 100),
  vendor_display_name TEXT NOT NULL CHECK (length(trim(vendor_display_name)) BETWEEN 1 AND 200),
  vendor_created_at INTEGER NOT NULL,
  model_family_key TEXT NOT NULL CHECK (length(trim(model_family_key)) BETWEEN 1 AND 100),
  model_version_label TEXT NOT NULL CHECK (length(trim(model_version_label)) BETWEEN 1 AND 100),
  model_display_name TEXT NOT NULL CHECK (length(trim(model_display_name)) BETWEEN 1 AND 200),
  model_created_at INTEGER NOT NULL,
  backend_display_name TEXT NOT NULL CHECK (length(trim(backend_display_name)) BETWEEN 1 AND 200),
  backend_created_at INTEGER NOT NULL,
  runtime_model_id TEXT NOT NULL CHECK (length(trim(runtime_model_id)) BETWEEN 1 AND 200),
  prompt_version TEXT NOT NULL CHECK (length(trim(prompt_version)) BETWEEN 1 AND 200),
  reasoning_effort TEXT NOT NULL CHECK (length(trim(reasoning_effort)) BETWEEN 1 AND 100),
  input_schema_version INTEGER NOT NULL CHECK (input_schema_version >= 1),
  output_schema_version INTEGER NOT NULL CHECK (output_schema_version >= 1),
  created_at INTEGER NOT NULL,
  UNIQUE (
    public_track_key, runtime_model_id, backend_key, prompt_version,
    reasoning_effort, input_schema_version, output_schema_version
  ),
  UNIQUE (
    public_track_key, runtime_model_id, prompt_version, reasoning_effort,
    input_schema_version, output_schema_version
  )
) STRICT;

INSERT INTO enrichment_profile_with_metadata ( -- sarj-noqa: SARJ105 — A duplicate profile must abort this ledgered one-time migration, never overwrite immutable provenance.
  profile_key, public_track_key, model_key, backend_key,
  vendor_key, vendor_display_name, vendor_created_at,
  model_family_key, model_version_label, model_display_name, model_created_at,
  backend_display_name, backend_created_at,
  runtime_model_id, prompt_version, reasoning_effort,
  input_schema_version, output_schema_version, created_at
)
SELECT profile.profile_key, profile.public_track_key, profile.model_key,
       profile.backend_key, vendor.vendor_key, vendor.display_name,
       vendor.created_at, model.family_key, model.version_label,
       model.display_name, model.created_at, backend.display_name,
       backend.created_at, profile.runtime_model_id, profile.prompt_version,
       profile.reasoning_effort, profile.input_schema_version,
       profile.output_schema_version, profile.created_at
FROM enrichment_profile profile
JOIN ai_model model ON model.model_key = profile.model_key
JOIN ai_vendor vendor ON vendor.vendor_key = model.vendor_key
JOIN inference_backend backend ON backend.backend_key = profile.backend_key;

DROP TRIGGER IF EXISTS model_enrichment_artifact_profile_required;
DROP TRIGGER IF EXISTS model_publication_profile_insert_guard;
DROP TRIGGER IF EXISTS model_publication_profile_update_guard;

-- Migration 0047 removed the final inbound FK to enrichment_profile. D1
-- executes each migration in one transaction, so a failed copy rolls back.
DROP TABLE IF EXISTS enrichment_profile;
ALTER TABLE enrichment_profile_with_metadata RENAME TO enrichment_profile;

CREATE INDEX IF NOT EXISTS idx_enrichment_profile_model -- sarj-noqa: SARJ108 — SQLite/D1 does not support CONCURRENTLY; the 18-row immutable registry is rebuilt under D1's migration write lock.
ON enrichment_profile(model_key);
CREATE INDEX IF NOT EXISTS idx_enrichment_profile_backend -- sarj-noqa: SARJ108 — SQLite/D1 does not support CONCURRENTLY; the 18-row immutable registry is rebuilt under D1's migration write lock.
ON enrichment_profile(backend_key);

-- Retain the functional dependencies that the dimension primary/unique keys
-- enforced for future immutable profile registrations.
CREATE TRIGGER enrichment_profile_dimension_insert_guard
BEFORE INSERT ON enrichment_profile
WHEN EXISTS (
  SELECT 1 FROM enrichment_profile existing
  WHERE (existing.model_key = NEW.model_key AND (
           existing.vendor_key IS NOT NEW.vendor_key
        OR existing.model_family_key IS NOT NEW.model_family_key
        OR existing.model_version_label IS NOT NEW.model_version_label
        OR existing.model_display_name IS NOT NEW.model_display_name
        OR existing.model_created_at IS NOT NEW.model_created_at))
     OR (existing.vendor_key = NEW.vendor_key AND (
           existing.vendor_display_name IS NOT NEW.vendor_display_name
        OR existing.vendor_created_at IS NOT NEW.vendor_created_at))
     OR (existing.backend_key = NEW.backend_key AND (
           existing.backend_display_name IS NOT NEW.backend_display_name
        OR existing.backend_created_at IS NOT NEW.backend_created_at))
     OR (existing.vendor_key != NEW.vendor_key
         AND existing.vendor_display_name = NEW.vendor_display_name)
     OR (existing.backend_key != NEW.backend_key
         AND existing.backend_display_name = NEW.backend_display_name)
     OR (existing.model_key != NEW.model_key
         AND existing.vendor_key = NEW.vendor_key
         AND existing.model_family_key = NEW.model_family_key
         AND existing.model_version_label = NEW.model_version_label)
)
BEGIN
  SELECT RAISE(ABORT, 'ENRICHMENT_PROFILE_DIMENSION_INVALID');
END;

CREATE TRIGGER enrichment_profile_immutable_update BEFORE UPDATE ON enrichment_profile
BEGIN SELECT RAISE(ABORT, 'ENRICHMENT_PROFILE_IMMUTABLE'); END;

CREATE TRIGGER enrichment_profile_immutable_delete BEFORE DELETE ON enrichment_profile
BEGIN SELECT RAISE(ABORT, 'ENRICHMENT_PROFILE_IMMUTABLE'); END;

CREATE TRIGGER model_enrichment_artifact_profile_required
BEFORE INSERT ON model_enrichment_artifact
WHEN (
  SELECT count(*)
  FROM enrichment_profile profile
  JOIN poem_source_revision revision
    ON revision.id = NEW.source_revision_id
  WHERE profile.public_track_key = NEW.model_key
    AND profile.runtime_model_id = NEW.model
    AND profile.prompt_version = NEW.prompt_version
    AND profile.reasoning_effort = NEW.reasoning_effort
    AND profile.input_schema_version = revision.schema_version
    AND profile.output_schema_version = NEW.schema_version
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'MODEL_ENRICHMENT_PROFILE_INVALID');
END;

CREATE TRIGGER model_publication_profile_insert_guard
BEFORE INSERT ON poem_model_publication_pointer
WHEN NOT EXISTS (
  SELECT 1 FROM model_enrichment_artifact artifact
  JOIN poem_source_revision revision ON revision.id = artifact.source_revision_id
  JOIN enrichment_profile profile
    ON profile.public_track_key = artifact.model_key
   AND profile.runtime_model_id = artifact.model
   AND profile.prompt_version = artifact.prompt_version
   AND profile.reasoning_effort = artifact.reasoning_effort
   AND profile.input_schema_version = revision.schema_version
   AND profile.output_schema_version = artifact.schema_version
  WHERE artifact.id = NEW.enrichment_artifact_id
    AND profile.public_track_key = NEW.model_key
)
BEGIN
  SELECT RAISE(ABORT, 'MODEL_PUBLICATION_PROFILE_INVALID');
END;

CREATE TRIGGER model_publication_profile_update_guard
BEFORE UPDATE ON poem_model_publication_pointer
WHEN NOT EXISTS (
  SELECT 1 FROM model_enrichment_artifact artifact
  JOIN poem_source_revision revision ON revision.id = artifact.source_revision_id
  JOIN enrichment_profile profile
    ON profile.public_track_key = artifact.model_key
   AND profile.runtime_model_id = artifact.model
   AND profile.prompt_version = artifact.prompt_version
   AND profile.reasoning_effort = artifact.reasoning_effort
   AND profile.input_schema_version = revision.schema_version
   AND profile.output_schema_version = artifact.schema_version
  WHERE artifact.id = NEW.enrichment_artifact_id
    AND profile.public_track_key = NEW.model_key
)
BEGIN
  SELECT RAISE(ABORT, 'MODEL_PUBLICATION_PROFILE_INVALID');
END;

DROP TABLE IF EXISTS ai_model;
DROP TABLE IF EXISTS ai_vendor;
DROP TABLE IF EXISTS inference_backend;
