-- The column-independent writer is already deployed. No core reader uses this value.
ALTER TABLE poem DROP COLUMN source_url; -- sarj-noqa: SARJ102 — SQLite has no DROP COLUMN IF EXISTS; Wrangler applies this bounded rewrite once.
