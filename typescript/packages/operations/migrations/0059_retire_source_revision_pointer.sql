-- The direct writer is already deployed. Require exact row and version parity
-- before retiring the old one-to-one pointer table and its mirror triggers.
CREATE TABLE IF NOT EXISTS _source_pointer_contract_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;

INSERT INTO _source_pointer_contract_guard (invalid_count) -- sarj-noqa: SARJ105 — Every old pointer must match its source identity.
SELECT count(*)
FROM poem_source_pointer pointer
LEFT JOIN source_poem_identity source ON source.id = pointer.source_poem_id
WHERE source.id IS NULL
   OR source.current_revision_id IS NOT pointer.revision_id
   OR source.current_revision_version IS NOT pointer.pointer_version
   OR source.current_revision_writer_epoch IS NOT pointer.writer_epoch
   OR source.current_revision_updated_at IS NOT pointer.updated_at;

INSERT INTO _source_pointer_contract_guard (invalid_count) -- sarj-noqa: SARJ105 — Reject any source identity with unmatched pointer state.
SELECT count(*)
FROM source_poem_identity source
LEFT JOIN poem_source_pointer pointer ON pointer.source_poem_id = source.id
WHERE (source.current_revision_id IS NULL) IS NOT (pointer.source_poem_id IS NULL)
   OR (source.current_revision_id IS NULL AND (
     source.current_revision_version IS NOT NULL
     OR source.current_revision_writer_epoch IS NOT NULL
     OR source.current_revision_updated_at IS NOT NULL
   ))
   OR (source.current_revision_id IS NOT NULL AND (
     source.current_revision_version IS NULL
     OR source.current_revision_writer_epoch IS NULL
     OR source.current_revision_updated_at IS NULL
   ));

DROP TABLE IF EXISTS _source_pointer_contract_guard; -- sarj-noqa: SARJ119 — D1 rolls back the table contract if either parity assertion fails.

DROP TRIGGER IF EXISTS source_poem_current_revision_sync_pointer;
DROP TRIGGER IF EXISTS poem_source_pointer_sync_insert;
DROP TRIGGER IF EXISTS poem_source_pointer_sync_update;
DROP TRIGGER IF EXISTS source_poem_current_revision_transition_guard;
DROP TABLE IF EXISTS poem_source_pointer;

CREATE TRIGGER source_poem_current_revision_transition_guard
BEFORE UPDATE OF current_revision_id, current_revision_version,
  current_revision_writer_epoch, current_revision_updated_at
ON source_poem_identity
WHEN NOT EXISTS (
    SELECT 1 FROM poem_source_revision revision
    WHERE revision.id = NEW.current_revision_id
      AND revision.source_poem_id = NEW.id
  )
  OR NEW.current_revision_version IS NOT
      COALESCE(OLD.current_revision_version, 0) + 1
  OR NEW.current_revision_writer_epoch IS NOT (
    SELECT writer_epoch FROM scraper_writer_control WHERE singleton = 1
  )
  OR NEW.current_revision_updated_at IS NULL
  OR NEW.current_revision_updated_at < COALESCE(OLD.current_revision_updated_at, 0)
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_CURRENT_REVISION_TRANSITION_INVALID');
END;
