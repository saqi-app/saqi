-- The column-independent writer is already deployed. No core reader uses this value.
ALTER TABLE poem DROP COLUMN rig_last_error; -- sarj-noqa: SARJ102 — SQLite has no DROP COLUMN IF EXISTS; Wrangler applies this bounded rewrite once.
