-- The source URL is needed only while an author awaits collection. Preserve
-- completed authors by clearing their pending URL before readers use it as
-- the sole queue predicate. Wrangler records this migration exactly once.
UPDATE author
SET source_url = NULL
WHERE source_author_id IS NOT NULL
  AND collected_at IS NOT NULL
  AND source_url IS NOT NULL;
