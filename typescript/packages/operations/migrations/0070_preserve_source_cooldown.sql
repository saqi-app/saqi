-- A source 429 deadline belongs to the author request that observed it.
-- Readers take max(deadline) for that source; no local state or origin table.
ALTER TABLE author ADD COLUMN source_retry_after INTEGER CHECK (source_retry_after IS NULL OR source_retry_after >= 0); -- sarj-noqa: SARJ102 — D1 migration ledger applies this additive column exactly once.
