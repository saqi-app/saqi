-- The canonical-only application no longer reads this revision FK.
-- Separate the populated poem rewrite from all other schema changes.
ALTER TABLE poem DROP COLUMN active_source_revision_id;
