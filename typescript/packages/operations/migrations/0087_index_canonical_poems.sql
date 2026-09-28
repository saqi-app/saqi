-- The audited deletion and write guards make every retained poem valid.
-- Build indexes for readers that no longer depend on publishable. Keep the
-- old partial indexes until those readers are deployed and shadow-checked.
CREATE INDEX IF NOT EXISTS idx_poem_author_title_canonical -- sarj-noqa: SARJ108,SARJ116 — Author page ORDER BY author_id, sort_name_arabic, id; D1 serializes this forward migration.
  ON poem(author_id, sort_name_arabic, id);
CREATE INDEX IF NOT EXISTS idx_poem_sitemap_canonical -- sarj-noqa: SARJ108,SARJ116 — Sitemap shard scan orders by id; D1 serializes this forward migration.
  ON poem(sitemap_shard, id, author_id);
CREATE INDEX IF NOT EXISTS poem_needs_enrichment_canonical -- sarj-noqa: SARJ108,SARJ116 — Rig scans current unpublished or stale source rows by id; D1 serializes this forward migration.
  ON poem(id)
  WHERE publication_json IS NULL
    OR publication_source_hash IS NULL
    OR publication_source_hash <> source_hash;
