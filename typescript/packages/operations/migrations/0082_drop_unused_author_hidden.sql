-- The preceding release removed the sole hidden author and its 137
-- unpublished poems, then deployed readers that never consult this field.
ALTER TABLE author DROP COLUMN hidden; -- sarj-noqa: SARJ102 — Wrangler records this forward migration once; the column has no remaining index or trigger dependencies.
