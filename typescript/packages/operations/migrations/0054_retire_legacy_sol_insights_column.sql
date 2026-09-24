-- The active model payload must retain the published insight object.
CREATE TABLE IF NOT EXISTS _legacy_sol_insights_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;
INSERT INTO _legacy_sol_insights_guard (invalid_count) -- sarj-noqa: SARJ105 — Published insights must survive this column removal.
SELECT count(*)
FROM poem canonical
WHERE canonical.insights_sol IS NOT NULL
  AND canonical.hidden = 0
  AND canonical.publishable = 1
  AND NOT EXISTS (
    SELECT 1
    FROM poem_model_publication_pointer publication
    JOIN model_enrichment_artifact artifact
      ON artifact.id = publication.enrichment_artifact_id
    WHERE publication.poem_id = canonical.id
      AND publication.model_key = 'sol-5.6'
      AND publication.source_revision_id = canonical.active_source_revision_id
      AND artifact.source_revision_id = canonical.active_source_revision_id
      AND json_valid(canonical.insights_sol)
      AND json_valid(artifact.payload)
      AND json_extract(artifact.payload, '$.insights')
          = json(canonical.insights_sol)
  );
DROP TABLE IF EXISTS _legacy_sol_insights_guard; -- sarj-noqa: SARJ119 — D1 atomically rolls back the column rewrite if the guard fails.
ALTER TABLE poem DROP COLUMN insights_sol;
