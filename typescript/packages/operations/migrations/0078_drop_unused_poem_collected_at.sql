-- The column-independent writer is already deployed. No core reader uses this value.
ALTER TABLE poem DROP COLUMN collected_at; -- sarj-noqa: SARJ102 — SQLite has no DROP COLUMN IF EXISTS; Wrangler applies this bounded rewrite once.
