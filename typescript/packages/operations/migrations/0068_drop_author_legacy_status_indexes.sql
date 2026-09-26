-- Status belongs to the retired scraper. Canonical source keys and collected_at
-- own the current queue; 1,391 authors need no write-maintained status index.
DROP INDEX IF EXISTS idx_author_status;
DROP INDEX IF EXISTS idx_author_public_slug;
DROP INDEX IF EXISTS author_collection_due;
ALTER TABLE author DROP COLUMN status;
