-- Add the canonical destination before any existing reader or writer changes.
-- This migration is additive: the old corpus and local crawler remain valid.
ALTER TABLE author ADD COLUMN source_name TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE author ADD COLUMN source_author_id TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE author ADD COLUMN source_url TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE author ADD COLUMN collected_at INTEGER; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.

CREATE UNIQUE INDEX IF NOT EXISTS author_source_identity -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  ON author(source_name, source_author_id)
  WHERE source_name IS NOT NULL AND source_author_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS author_collection_due -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  ON author(collected_at, id)
  WHERE source_author_id IS NOT NULL;

ALTER TABLE poem ADD COLUMN source_name TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN source_poem_id TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN source_url TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN source_hash TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN collected_at INTEGER; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN publication_json TEXT -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (publication_json IS NULL OR json_valid(publication_json));
ALTER TABLE poem ADD COLUMN publication_source_hash TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN publication_version INTEGER NOT NULL DEFAULT 0; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN publication_hash TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN publication_cache_dirty INTEGER NOT NULL DEFAULT 0 -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (publication_cache_dirty IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS poem_source_identity -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  ON poem(source_name, source_poem_id)
  WHERE source_name IS NOT NULL AND source_poem_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS poem_needs_enrichment -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  ON poem(id)
  WHERE hidden = 0 AND publishable = 1
    AND (publication_json IS NULL
      OR publication_source_hash IS NULL
      OR publication_source_hash <> source_hash);
CREATE INDEX IF NOT EXISTS poem_publication_cache_dirty ON poem(id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE publication_cache_dirty = 1;

-- A current, in-flight invocation is a property of the canonical poem.
-- Pending work is derived from source_hash versus publication_source_hash.
ALTER TABLE poem ADD COLUMN rig_status TEXT -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (rig_status IS NULL OR rig_status IN
    ('claimed', 'dispatching', 'unknown', 'retry', 'blocked', 'complete'));
ALTER TABLE poem ADD COLUMN rig_version INTEGER NOT NULL DEFAULT 0 -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (rig_version >= 0);
ALTER TABLE poem ADD COLUMN rig_lease_token TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN rig_lease_expires_at INTEGER; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN rig_checkpoint_json TEXT -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (rig_checkpoint_json IS NULL OR (
    json_valid(rig_checkpoint_json)
    AND length(CAST(rig_checkpoint_json AS BLOB)) <= 1048576
  ));
ALTER TABLE poem ADD COLUMN rig_last_error TEXT; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
ALTER TABLE poem ADD COLUMN rig_updated_at INTEGER; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
CREATE INDEX IF NOT EXISTS poem_rig_active ON poem(rig_status, rig_updated_at, id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE rig_status IN ('claimed', 'dispatching', 'unknown');
