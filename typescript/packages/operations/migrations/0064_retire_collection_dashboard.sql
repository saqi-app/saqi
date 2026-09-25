-- The collection dashboard has been retired. Poem-level insights remain on poem.
-- Remove write-maintained counts and monthly analytics with their triggers.
DROP TRIGGER IF EXISTS insights_author_delete;
DROP TRIGGER IF EXISTS insights_author_insert;
DROP TRIGGER IF EXISTS insights_model_pointer_insert;
DROP TRIGGER IF EXISTS insights_poem_delete;
DROP TRIGGER IF EXISTS insights_poem_insert;
DROP TRIGGER IF EXISTS insights_source_poem_insert;

DROP TABLE IF EXISTS insights_collection_month;
DROP TABLE IF EXISTS insights_model_count;
DROP TABLE IF EXISTS insights_rollup;
