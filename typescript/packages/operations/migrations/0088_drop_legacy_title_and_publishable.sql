-- Exact title audit after 0085: zero visible fallbacks or parity failures.
-- After 0086, every retained poem has publishable=1; the deployed readers
-- now use only canonical poem rows and name_english. Abort on drift.
CREATE TABLE IF NOT EXISTS _poem_column_drop_guard (violations INTEGER NOT NULL CHECK (violations = 0));
INSERT INTO _poem_column_drop_guard -- sarj-noqa: SARJ105 — An unexpected prior guard row or parity violation must abort the atomic migration.
SELECT count(*) FROM poem WHERE publishable <> 1;
DROP TABLE IF EXISTS _poem_column_drop_guard;

DROP INDEX IF EXISTS idx_poem_public_author_title;
DROP INDEX IF EXISTS idx_poem_public_sitemap;
DROP INDEX IF EXISTS poem_needs_enrichment;
DROP TRIGGER IF EXISTS poem_publishability_after_insert;
DROP TRIGGER IF EXISTS poem_publishability_after_update;
ALTER TABLE poem DROP COLUMN poem_title_first_line;
ALTER TABLE poem DROP COLUMN publishable;
