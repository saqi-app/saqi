-- The collector has switched to source_url IS NOT NULL as its queue predicate.
-- Abort if any timestamp-complete author still has a pending URL. The D1
-- migration ledger applies this bounded table rewrite exactly once.
CREATE TABLE IF NOT EXISTS _author_completion_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
);
INSERT INTO _author_completion_guard -- sarj-noqa: SARJ105 — The migration must abort if old completion state was not fully backfilled; D1 records this file once.
SELECT count(*) FROM author
WHERE source_author_id IS NOT NULL
  AND collected_at IS NOT NULL
  AND source_url IS NOT NULL;
DROP TABLE IF EXISTS _author_completion_guard;
ALTER TABLE author DROP COLUMN collected_at; -- sarj-noqa: SARJ102 — The verified reader no longer references this column; Wrangler applies this once.
