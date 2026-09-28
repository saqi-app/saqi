-- Source IDs are unique on their own, and the installed collector now reads
-- and writes them without a per-row source namespace. Production contains
-- only the aldiwan namespace; keep the source ID indexes from migration 0083.
DROP INDEX IF EXISTS author_source_identity;
DROP INDEX IF EXISTS poem_source_identity;
ALTER TABLE author DROP COLUMN source_name; -- sarj-noqa: SARJ102 — Wrangler records this forward migration once after the reader/writer cutover.
ALTER TABLE poem DROP COLUMN source_name; -- sarj-noqa: SARJ102 — Wrangler records this forward migration once after the reader/writer cutover.
