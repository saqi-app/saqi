-- Each immutable artifact resolves to one profile through the registry's
-- unique identity. Fail transactionally if any stored binding disagrees.
CREATE TABLE IF NOT EXISTS _artifact_profile_fold_guard (
  unmatched INTEGER NOT NULL CHECK (unmatched = 0)
);

INSERT INTO _artifact_profile_fold_guard (unmatched)
SELECT count(*) FROM model_enrichment_artifact artifact
LEFT JOIN poem_source_revision revision
  ON revision.id = artifact.source_revision_id
LEFT JOIN model_enrichment_artifact_profile binding
  ON binding.artifact_id = artifact.id
LEFT JOIN enrichment_profile profile
  ON profile.profile_key = binding.profile_key
 AND profile.public_track_key = artifact.model_key
 AND profile.runtime_model_id = artifact.model
 AND profile.prompt_version = artifact.prompt_version
 AND profile.reasoning_effort = artifact.reasoning_effort
 AND profile.input_schema_version = revision.schema_version
 AND profile.output_schema_version = artifact.schema_version
WHERE profile.profile_key IS NULL;

DROP TABLE _artifact_profile_fold_guard;

DROP TRIGGER IF EXISTS model_enrichment_artifact_profile_bind;
DROP TRIGGER IF EXISTS model_publication_profile_insert_guard;
DROP TRIGGER IF EXISTS model_publication_profile_update_guard;
DROP TRIGGER IF EXISTS legacy_sol_model_pointer_create_only;
DROP TABLE IF EXISTS model_enrichment_artifact_profile;

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

CREATE TRIGGER legacy_sol_model_pointer_create_only
BEFORE UPDATE OF enrichment_artifact_id ON poem_model_publication_pointer
WHEN NEW.model_key = 'sol-5.6'
  AND NEW.enrichment_artifact_id IS NOT OLD.enrichment_artifact_id
  AND EXISTS (
    SELECT 1 FROM model_enrichment_artifact artifact
    WHERE artifact.id = NEW.enrichment_artifact_id
      AND artifact.model_key = 'sol-5.6'
      AND artifact.prompt_version = 'sol-enrichment-v1'
  )
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_SOL_PUBLICATION_REQUIRES_EMPTY_POINTER');
END;
