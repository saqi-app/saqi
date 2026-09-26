-- Break the obsolete source/revision cycle before graph-table removal.
ALTER TABLE source_poem_identity DROP COLUMN current_revision_id;
