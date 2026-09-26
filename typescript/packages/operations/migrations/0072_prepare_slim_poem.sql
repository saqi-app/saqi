-- Populated installations must run prepare-corpus-contraction.py before 0073.
-- Bounded copying avoids the reproduced D1 error on a ~1 GB ALTER rewrite.
CREATE TABLE IF NOT EXISTS _poem_next (
  id TEXT PRIMARY KEY,
  author_id TEXT REFERENCES author(id) ON DELETE SET NULL,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) <= 1000),
  verses INTEGER NOT NULL CHECK (verses > 0),
  name_arabic TEXT NOT NULL CHECK (length(name_arabic) <= 10000),
  name_english TEXT CHECK (length(name_english) <= 10000),
  content_arabic TEXT NOT NULL,
  poem_title_first_line TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  publishable INTEGER NOT NULL DEFAULT 0 CHECK (publishable IN (0, 1))
, sort_name_arabic TEXT NOT NULL DEFAULT '', sitemap_shard INTEGER NOT NULL DEFAULT 0 -- sarj-noqa: SARJ102 — SQLite does not implement ADD COLUMN IF NOT EXISTS; Wrangler records the migration atomically.
  CHECK (sitemap_shard BETWEEN 0 AND 15), source_name TEXT, source_poem_id TEXT, source_url TEXT, source_hash TEXT, collected_at INTEGER, publication_json TEXT -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (publication_json IS NULL OR json_valid(publication_json)), publication_source_hash TEXT, publication_hash TEXT, publication_cache_dirty INTEGER NOT NULL DEFAULT 0 -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (publication_cache_dirty IN (0, 1)), rig_status TEXT -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (rig_status IS NULL OR rig_status IN
    ('claimed', 'dispatching', 'unknown', 'retry', 'blocked', 'complete')), rig_version INTEGER NOT NULL DEFAULT 0 -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (rig_version >= 0), rig_lease_token TEXT, rig_lease_expires_at INTEGER, rig_checkpoint_json TEXT -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; Wrangler records this migration once.
  CHECK (rig_checkpoint_json IS NULL OR (
    json_valid(rig_checkpoint_json)
    AND length(CAST(rig_checkpoint_json AS BLOB)) <= 1048576
  )), rig_last_error TEXT, rig_updated_at INTEGER);

CREATE INDEX IF NOT EXISTS _contraction_crawl_import_record_poem_fk ON crawl_import_record(canonical_poem_id);
CREATE INDEX IF NOT EXISTS _contraction_source_poem_identity_poem_fk ON source_poem_identity(canonical_poem_id);
CREATE INDEX IF NOT EXISTS _contraction_poem_model_publication_pointer_poem_fk ON poem_model_publication_pointer(poem_id);
CREATE INDEX IF NOT EXISTS _contraction_model_publication_receipt_poem_fk ON model_publication_receipt(poem_id);
