-- Production preflight found exactly one hidden author with 137 poems and no
-- publications. These rows have no public URLs and no published English or
-- insights. Stop if that evidence changes; the deploy log records a D1 Time
-- Travel bookmark before applying this migration.
CREATE TABLE IF NOT EXISTS _hidden_delete_guard (mismatches INTEGER NOT NULL CHECK (mismatches = 0));
INSERT INTO _hidden_delete_guard -- sarj-noqa: SARJ105 — Guard must abort the migration if the live preflight no longer holds.
SELECT CASE WHEN
  ((SELECT count(*) FROM author WHERE hidden <> 0) = 0
   AND (SELECT count(*) FROM poem p JOIN author a ON a.id = p.author_id WHERE a.hidden <> 0) = 0)
  OR ((SELECT count(*) FROM author WHERE hidden <> 0) = 1
  AND (SELECT count(*) FROM poem p JOIN author a ON a.id = p.author_id WHERE a.hidden <> 0) = 137
  AND (SELECT count(*) FROM poem p JOIN author a ON a.id = p.author_id
       WHERE a.hidden <> 0 AND p.publication_json IS NOT NULL) = 0
  AND (SELECT count(*) FROM poem p JOIN author a ON a.id = p.author_id
       WHERE a.hidden <> 0 AND p.rig_status IN ('claimed', 'dispatching', 'unknown')) = 0)
  THEN 0 ELSE 1 END;
DELETE FROM poem WHERE author_id IN (SELECT id FROM author WHERE hidden <> 0);
DELETE FROM author WHERE hidden <> 0;
DROP TABLE IF EXISTS _hidden_delete_guard;
