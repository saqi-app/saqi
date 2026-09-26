-- Author counts are derived from indexed canonical poems by the public catalog.
-- Retire the redundant writes, columns, and counter-dependent sort index together.
DROP TRIGGER IF EXISTS public_poem_count_after_insert;
DROP TRIGGER IF EXISTS public_poem_count_after_delete;
DROP TRIGGER IF EXISTS public_poem_count_after_update;
DROP INDEX IF EXISTS idx_author_public_catalog;
ALTER TABLE author DROP COLUMN poem_count;
ALTER TABLE author DROP COLUMN gemini_translation_count;
ALTER TABLE author DROP COLUMN public_poem_count;
