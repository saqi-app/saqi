-- Allow old Workers to write the pointer table while new Workers update the
-- source poem directly. Both paths are fenced and mirror the same versioned
-- state until a later contract removes the old table.
DROP TRIGGER IF EXISTS source_poem_current_revision_update_guard;
DROP TRIGGER IF EXISTS poem_source_pointer_sync_insert;
DROP TRIGGER IF EXISTS poem_source_pointer_sync_update;

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
  OR NOT (
    (OLD.current_revision_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM poem_source_pointer WHERE source_poem_id = NEW.id
    ))
    OR EXISTS (
      SELECT 1 FROM poem_source_pointer pointer
      WHERE pointer.source_poem_id = NEW.id
        AND pointer.revision_id IS OLD.current_revision_id
        AND pointer.pointer_version IS OLD.current_revision_version
        AND pointer.writer_epoch IS OLD.current_revision_writer_epoch
        AND pointer.updated_at IS OLD.current_revision_updated_at
    )
    OR EXISTS (
      SELECT 1 FROM poem_source_pointer pointer
      WHERE pointer.source_poem_id = NEW.id
        AND pointer.revision_id IS NEW.current_revision_id
        AND pointer.pointer_version IS NEW.current_revision_version
        AND pointer.writer_epoch IS NEW.current_revision_writer_epoch
        AND pointer.updated_at IS NEW.current_revision_updated_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_CURRENT_REVISION_TRANSITION_INVALID');
END;

CREATE TRIGGER poem_source_pointer_sync_insert
AFTER INSERT ON poem_source_pointer
BEGIN
  UPDATE source_poem_identity SET
    current_revision_id = NEW.revision_id,
    current_revision_version = NEW.pointer_version,
    current_revision_writer_epoch = NEW.writer_epoch,
    current_revision_updated_at = NEW.updated_at
  WHERE id = NEW.source_poem_id
    AND (current_revision_id IS NOT NEW.revision_id
      OR current_revision_version IS NOT NEW.pointer_version
      OR current_revision_writer_epoch IS NOT NEW.writer_epoch
      OR current_revision_updated_at IS NOT NEW.updated_at);
END;

CREATE TRIGGER poem_source_pointer_sync_update
AFTER UPDATE ON poem_source_pointer
BEGIN
  UPDATE source_poem_identity SET
    current_revision_id = NEW.revision_id,
    current_revision_version = NEW.pointer_version,
    current_revision_writer_epoch = NEW.writer_epoch,
    current_revision_updated_at = NEW.updated_at
  WHERE id = NEW.source_poem_id
    AND (current_revision_id IS NOT NEW.revision_id
      OR current_revision_version IS NOT NEW.pointer_version
      OR current_revision_writer_epoch IS NOT NEW.writer_epoch
      OR current_revision_updated_at IS NOT NEW.updated_at);
END;

CREATE TRIGGER source_poem_current_revision_sync_pointer
AFTER UPDATE OF current_revision_id, current_revision_version,
  current_revision_writer_epoch, current_revision_updated_at
ON source_poem_identity
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  INSERT INTO poem_source_pointer (
    source_poem_id, revision_id, pointer_version, writer_epoch, updated_at
  )
  SELECT NEW.id, NEW.current_revision_id, NEW.current_revision_version,
    NEW.current_revision_writer_epoch, NEW.current_revision_updated_at
  WHERE NOT EXISTS (
    SELECT 1 FROM poem_source_pointer WHERE source_poem_id = NEW.id
  );

  UPDATE poem_source_pointer SET
    revision_id = NEW.current_revision_id,
    pointer_version = NEW.current_revision_version,
    writer_epoch = NEW.current_revision_writer_epoch,
    updated_at = NEW.current_revision_updated_at
  WHERE source_poem_id = NEW.id
    AND (revision_id IS NOT NEW.current_revision_id
      OR pointer_version IS NOT NEW.current_revision_version
      OR writer_epoch IS NOT NEW.current_revision_writer_epoch
      OR updated_at IS NOT NEW.current_revision_updated_at);
END;
