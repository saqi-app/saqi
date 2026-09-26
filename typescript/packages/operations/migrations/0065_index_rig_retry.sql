-- A manual retry is rare but must not scan the 105k-poem corpus before every
-- fresh claim. The partial index is empty in the normal state. Application
-- read: SELECT id FROM poem INDEXED BY poem_rig_retry WHERE rig_status =
-- 'retry' AND hidden = 0 AND publishable = 1 AND source_hash IS NOT NULL
-- AND (publication_json IS NULL OR publication_source_hash IS NULL OR
-- publication_source_hash <> source_hash) ORDER BY id LIMIT 1.
-- Before: the same retry lookup scans 104,961 rows / 155 ms on live D1.
-- Verify EXPLAIN QUERY PLAN uses poem_rig_retry after deployment.
CREATE INDEX IF NOT EXISTS poem_rig_retry ON poem(id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE rig_status = 'retry';
