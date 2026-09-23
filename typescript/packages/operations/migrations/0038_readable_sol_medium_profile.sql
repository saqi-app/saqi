-- New generation recipe; preserve every historical profile and publication.
INSERT INTO enrichment_profile ( -- sarj-noqa: SARJ105 -- Versioned migration must fail on preexisting immutable profile identities, not hide provenance drift.
  profile_key, public_track_key, model_key, backend_key, runtime_model_id,
  prompt_version, reasoning_effort, input_schema_version, output_schema_version,
  created_at
) VALUES
  ('sol-5.6/word-gloss-v3/source-v1', 'sol-5.6', 'gpt-5.6-sol', 'openai-codex-cli', 'gpt-5.6-sol', 'sol-word-gloss-v3', 'medium', 1, 2, 0),
  ('sol-5.6/word-gloss-v3/source-v2', 'sol-5.6', 'gpt-5.6-sol', 'openai-codex-cli', 'gpt-5.6-sol', 'sol-word-gloss-v3', 'medium', 2, 2, 0);

-- A delayed historical completion must not replace the newer recipe for the
-- same source revision, including publication through the receipt trigger.
CREATE TRIGGER sol_model_pointer_prevent_recipe_downgrade
BEFORE UPDATE OF enrichment_artifact_id ON poem_model_publication_pointer
WHEN NEW.model_key = 'sol-5.6'
  AND NEW.source_revision_id = OLD.source_revision_id
  AND EXISTS (
    SELECT 1 FROM model_enrichment_artifact incoming
    JOIN model_enrichment_artifact current ON current.id = OLD.enrichment_artifact_id
    WHERE incoming.id = NEW.enrichment_artifact_id
      AND incoming.prompt_version = 'sol-word-gloss-v2'
      AND current.prompt_version = 'sol-word-gloss-v3'
  )
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_SOL_PUBLICATION_SUPERSEDED');
END;
