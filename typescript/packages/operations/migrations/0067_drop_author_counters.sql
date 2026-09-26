-- Author counts are derived from indexed canonical poems by the public catalog.
-- Retire the redundant writes and columns together, preserving the same sort index.
DROP TRIGGER IF EXISTS public_poem_count_after_insert;
DROP TRIGGER IF EXISTS public_poem_count_after_delete;
DROP TRIGGER IF EXISTS public_poem_count_after_update;
DROP INDEX IF EXISTS idx_author_public_catalog;
ALTER TABLE author DROP COLUMN poem_count;
ALTER TABLE author DROP COLUMN gemini_translation_count;
ALTER TABLE author DROP COLUMN public_poem_count;
CREATE INDEX idx_author_public_catalog
  ON author(sort_name_arabic, id)
  WHERE hidden = 0;
