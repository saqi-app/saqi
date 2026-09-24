-- A fingerprint is optional until its revision has been backfilled. Keep the
-- one-time append semantics while storing it on the revision itself.
ALTER TABLE poem_source_revision ADD COLUMN fingerprint_algorithm TEXT; -- sarj-noqa: SARJ102 — SQLite has no ADD COLUMN IF NOT EXISTS; Wrangler applies each migration once.
ALTER TABLE poem_source_revision ADD COLUMN fingerprint_created_at INTEGER; -- sarj-noqa: SARJ102 — SQLite has no ADD COLUMN IF NOT EXISTS; Wrangler applies each migration once.
ALTER TABLE poem_source_revision ADD COLUMN line_nfc_hash TEXT; -- sarj-noqa: SARJ102 — SQLite has no ADD COLUMN IF NOT EXISTS; Wrangler applies each migration once.
ALTER TABLE poem_source_revision ADD COLUMN prompt_material_hash TEXT; -- sarj-noqa: SARJ102 — SQLite has no ADD COLUMN IF NOT EXISTS; Wrangler applies each migration once.

DROP TRIGGER IF EXISTS poem_source_revision_immutable_update;

UPDATE poem_source_revision
SET fingerprint_algorithm = (
      SELECT algorithm FROM source_revision_fingerprint
      WHERE source_revision_id = poem_source_revision.id
    ),
    fingerprint_created_at = (
      SELECT created_at FROM source_revision_fingerprint
      WHERE source_revision_id = poem_source_revision.id
    ),
    line_nfc_hash = (
      SELECT line_nfc_hash FROM source_revision_fingerprint
      WHERE source_revision_id = poem_source_revision.id
    ),
    prompt_material_hash = (
      SELECT prompt_material_hash FROM source_revision_fingerprint
      WHERE source_revision_id = poem_source_revision.id
    )
WHERE EXISTS (
  SELECT 1 FROM source_revision_fingerprint
  WHERE source_revision_id = poem_source_revision.id
);

DROP TABLE IF EXISTS source_revision_fingerprint;

CREATE INDEX IF NOT EXISTS idx_source_revision_fingerprint_line_nfc -- sarj-noqa: SARJ108 — D1 SQLite does not support CONCURRENTLY; Wrangler serializes this migration.
ON poem_source_revision(line_nfc_hash, id);
CREATE INDEX IF NOT EXISTS idx_source_revision_fingerprint_prompt_material -- sarj-noqa: SARJ108 — D1 SQLite does not support CONCURRENTLY; Wrangler serializes this migration.
ON poem_source_revision(prompt_material_hash, id);

CREATE TRIGGER poem_source_revision_fingerprint_insert_guard
BEFORE INSERT ON poem_source_revision
WHEN (CASE WHEN
  (NEW.fingerprint_algorithm IS NULL
    AND NEW.fingerprint_created_at IS NULL
    AND NEW.line_nfc_hash IS NULL
    AND NEW.prompt_material_hash IS NULL)
  OR (length(NEW.fingerprint_algorithm) BETWEEN 1 AND 100
    AND NEW.fingerprint_created_at >= 0
    AND length(NEW.line_nfc_hash) = 64
    AND NEW.line_nfc_hash NOT GLOB '*[^0-9a-f]*'
    AND length(NEW.prompt_material_hash) = 64
    AND NEW.prompt_material_hash NOT GLOB '*[^0-9a-f]*')
THEN 0 ELSE 1 END) = 1
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_REVISION_FINGERPRINT_INVALID');
END;

CREATE TRIGGER poem_source_revision_immutable_update
BEFORE UPDATE ON poem_source_revision
WHEN (CASE WHEN
  OLD.id IS NEW.id
  AND OLD.source_poem_id IS NEW.source_poem_id
  AND OLD.schema_version IS NEW.schema_version
  AND OLD.content_hash IS NEW.content_hash
  AND OLD.title_arabic IS NEW.title_arabic
  AND OLD.content_arabic IS NEW.content_arabic
  AND OLD.observed_at IS NEW.observed_at
  AND OLD.created_at IS NEW.created_at
  AND OLD.import_bundle_id IS NEW.import_bundle_id
  AND OLD.import_ordinal IS NEW.import_ordinal
  AND OLD.fingerprint_algorithm IS NULL
  AND OLD.fingerprint_created_at IS NULL
  AND OLD.line_nfc_hash IS NULL
  AND OLD.prompt_material_hash IS NULL
  AND length(NEW.fingerprint_algorithm) BETWEEN 1 AND 100
  AND NEW.fingerprint_created_at >= 0
  AND length(NEW.line_nfc_hash) = 64
  AND NEW.line_nfc_hash NOT GLOB '*[^0-9a-f]*'
  AND length(NEW.prompt_material_hash) = 64
  AND NEW.prompt_material_hash NOT GLOB '*[^0-9a-f]*'
THEN 0 ELSE 1 END) = 1
BEGIN
  SELECT RAISE(ABORT, 'POEM_SOURCE_REVISION_IMMUTABLE');
END;
