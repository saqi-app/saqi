-- Stage the one-to-one current revision on its source poem. The old pointer
-- remains the write authority while older Workers are deployed; its triggers
-- keep these columns current until all readers and writers have cut over.
ALTER TABLE source_poem_identity ADD COLUMN current_revision_id TEXT REFERENCES poem_source_revision(id); -- sarj-noqa: SARJ102 — Wrangler applies this D1 migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE source_poem_identity ADD COLUMN current_revision_version INTEGER CHECK (current_revision_version >= 1); -- sarj-noqa: SARJ102 — Wrangler applies this D1 migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE source_poem_identity ADD COLUMN current_revision_writer_epoch INTEGER CHECK (current_revision_writer_epoch >= 1); -- sarj-noqa: SARJ102 — Wrangler applies this D1 migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE source_poem_identity ADD COLUMN current_revision_updated_at INTEGER; -- sarj-noqa: SARJ102 — Wrangler applies this D1 migration once; SQLite has no ADD COLUMN IF NOT EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_revision_owner_id -- sarj-noqa: SARJ108 — D1 SQLite does not support CONCURRENTLY; Wrangler serializes this migration.
ON poem_source_revision(source_poem_id, id);

CREATE TABLE IF NOT EXISTS _source_pointer_expand_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
) STRICT;
INSERT INTO _source_pointer_expand_guard (invalid_count) -- sarj-noqa: SARJ105 — A nonzero count must abort this one-time migration rather than replay.
SELECT count(*)
FROM poem_source_pointer pointer
LEFT JOIN poem_source_revision revision ON revision.id = pointer.revision_id
WHERE revision.id IS NULL OR revision.source_poem_id <> pointer.source_poem_id;

UPDATE source_poem_identity
SET current_revision_id = (
      SELECT revision_id FROM poem_source_pointer WHERE source_poem_id = source_poem_identity.id
    ),
    current_revision_version = (
      SELECT pointer_version FROM poem_source_pointer WHERE source_poem_id = source_poem_identity.id
    ),
    current_revision_writer_epoch = (
      SELECT writer_epoch FROM poem_source_pointer WHERE source_poem_id = source_poem_identity.id
    ),
    current_revision_updated_at = (
      SELECT updated_at FROM poem_source_pointer WHERE source_poem_id = source_poem_identity.id
    )
WHERE EXISTS (
  SELECT 1 FROM poem_source_pointer WHERE source_poem_id = source_poem_identity.id
);

INSERT INTO _source_pointer_expand_guard (invalid_count) -- sarj-noqa: SARJ105 — Any parity mismatch must abort this one-time migration.
SELECT count(*) FROM source_poem_identity source
LEFT JOIN poem_source_pointer pointer ON pointer.source_poem_id = source.id
WHERE source.current_revision_id IS NOT pointer.revision_id
   OR source.current_revision_version IS NOT pointer.pointer_version
   OR source.current_revision_writer_epoch IS NOT pointer.writer_epoch
   OR source.current_revision_updated_at IS NOT pointer.updated_at;
DROP TABLE IF EXISTS _source_pointer_expand_guard; -- sarj-noqa: SARJ119 — The guarded copy runs under D1's migration write lock and rolls back on mismatch.

CREATE TRIGGER source_poem_current_revision_insert_guard
BEFORE INSERT ON source_poem_identity
WHEN NEW.current_revision_id IS NOT NULL
  OR NEW.current_revision_version IS NOT NULL
  OR NEW.current_revision_writer_epoch IS NOT NULL
  OR NEW.current_revision_updated_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_CURRENT_REVISION_MUST_START_EMPTY');
END;

CREATE TRIGGER source_poem_current_revision_update_guard
BEFORE UPDATE OF current_revision_id, current_revision_version,
  current_revision_writer_epoch, current_revision_updated_at
ON source_poem_identity
WHEN NOT EXISTS (
  SELECT 1 FROM poem_source_pointer pointer
  JOIN poem_source_revision revision
    ON revision.id = pointer.revision_id
   AND revision.source_poem_id = NEW.id
  WHERE pointer.source_poem_id = NEW.id
    AND pointer.revision_id IS NEW.current_revision_id
    AND pointer.pointer_version IS NEW.current_revision_version
    AND pointer.writer_epoch IS NEW.current_revision_writer_epoch
    AND pointer.updated_at IS NEW.current_revision_updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_CURRENT_REVISION_MISMATCH');
END;

CREATE TRIGGER poem_source_pointer_sync_insert
AFTER INSERT ON poem_source_pointer
BEGIN
  UPDATE source_poem_identity SET
    current_revision_id = NEW.revision_id,
    current_revision_version = NEW.pointer_version,
    current_revision_writer_epoch = NEW.writer_epoch,
    current_revision_updated_at = NEW.updated_at
  WHERE id = NEW.source_poem_id;
END;

CREATE TRIGGER poem_source_pointer_sync_update
AFTER UPDATE ON poem_source_pointer
BEGIN
  UPDATE source_poem_identity SET
    current_revision_id = NEW.revision_id,
    current_revision_version = NEW.pointer_version,
    current_revision_writer_epoch = NEW.writer_epoch,
    current_revision_updated_at = NEW.updated_at
  WHERE id = NEW.source_poem_id;
END;
