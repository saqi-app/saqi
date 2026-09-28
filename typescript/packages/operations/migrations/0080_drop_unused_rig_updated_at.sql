-- Runtime readers and writers stopped using this timestamp in the preceding
-- deployment. The active-work query orders by status and ID; leases and
-- invocation timestamps remain in their authoritative fields/checkpoint.
DROP INDEX IF EXISTS poem_rig_active;
ALTER TABLE poem DROP COLUMN rig_updated_at; -- sarj-noqa: SARJ102 — Wrangler records the forward migration once; this is a bounded D1 table rewrite after the runtime cutover.
-- Current work lookup: WHERE rig_status IN ('claimed','dispatching','unknown')
-- ORDER BY CASE WHEN rig_status='unknown' THEN 1 ELSE 0 END,id LIMIT 1.
CREATE INDEX IF NOT EXISTS poem_rig_active ON poem(rig_status, id) -- sarj-noqa: SARJ108,SARJ116 — Replaces the previous active-work index; D1 cannot build it concurrently.
  WHERE rig_status IN ('claimed', 'dispatching', 'unknown');
