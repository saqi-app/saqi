-- Public author pages, sitemaps, and the due queue have dedicated indexes.
-- These low-selectivity legacy indexes have no current runtime reader.
DROP INDEX IF EXISTS idx_poem_hidden;
DROP INDEX IF EXISTS idx_poem_verses;
