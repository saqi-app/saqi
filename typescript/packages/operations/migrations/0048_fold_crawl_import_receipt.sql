-- The immutable promotion receipt has the same identity as its bundle. Keep
-- its counts on that row so finalization is a single, fenced write.
CREATE TABLE IF NOT EXISTS _crawl_import_receipt_fold_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO _crawl_import_receipt_fold_guard (invalid_count) -- sarj-noqa: SARJ105 — A mismatched receipt must abort this one-time transaction; D1's ledger prevents replay.
SELECT
  (SELECT count(*) FROM crawl_import_receipt receipt
   LEFT JOIN crawl_import_bundle bundle ON bundle.id = receipt.bundle_id
   WHERE bundle.id IS NULL OR bundle.status != 'promoted'
     OR bundle.plan_hash IS NOT receipt.plan_hash
     OR bundle.writer_epoch != receipt.writer_epoch
     OR bundle.promoted_at IS NULL
     OR receipt.created_at IS NULL
     OR receipt.inserted_revisions < 0 OR receipt.reused_revisions < 0
     OR receipt.advanced_pointers < 0 OR receipt.unchanged_pointers < 0)
  + (SELECT count(*) FROM crawl_import_bundle bundle
     WHERE bundle.status = 'promoted'
       AND NOT EXISTS (SELECT 1 FROM crawl_import_receipt receipt
                       WHERE receipt.bundle_id = bundle.id));

DROP TABLE IF EXISTS _crawl_import_receipt_fold_guard; -- sarj-noqa: SARJ119 — D1 transaction holds the SQLite write lock; linear receipt scan, atomic rollback, and parity guard above precede contract.

ALTER TABLE crawl_import_bundle ADD COLUMN receipt_created_at INTEGER; -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; D1 applies this guarded migration once.
ALTER TABLE crawl_import_bundle ADD COLUMN inserted_revisions INTEGER CHECK (inserted_revisions >= 0); -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; D1 applies this guarded migration once.
ALTER TABLE crawl_import_bundle ADD COLUMN reused_revisions INTEGER CHECK (reused_revisions >= 0); -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; D1 applies this guarded migration once.
ALTER TABLE crawl_import_bundle ADD COLUMN advanced_pointers INTEGER CHECK (advanced_pointers >= 0); -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; D1 applies this guarded migration once.
ALTER TABLE crawl_import_bundle ADD COLUMN unchanged_pointers INTEGER CHECK (unchanged_pointers >= 0); -- sarj-noqa: SARJ102 — SQLite lacks ADD COLUMN IF NOT EXISTS; D1 applies this guarded migration once.

-- D1 executes each migration in a transaction. The old table stays intact
-- until all counts are copied; a failed guard or copy rolls the whole change
-- back. Postcondition: every promoted bundle has one complete receipt row.
UPDATE crawl_import_bundle -- sarj-noqa: SARJ119 — Atomic guarded copy and contract; rollback restores the old table and trigger set.
SET receipt_created_at = (SELECT created_at FROM crawl_import_receipt WHERE bundle_id = crawl_import_bundle.id),
    inserted_revisions = (SELECT inserted_revisions FROM crawl_import_receipt WHERE bundle_id = crawl_import_bundle.id),
    reused_revisions = (SELECT reused_revisions FROM crawl_import_receipt WHERE bundle_id = crawl_import_bundle.id),
    advanced_pointers = (SELECT advanced_pointers FROM crawl_import_receipt WHERE bundle_id = crawl_import_bundle.id),
    unchanged_pointers = (SELECT unchanged_pointers FROM crawl_import_receipt WHERE bundle_id = crawl_import_bundle.id)
WHERE EXISTS (SELECT 1 FROM crawl_import_receipt WHERE bundle_id = crawl_import_bundle.id);

DROP TABLE IF EXISTS crawl_import_receipt;

CREATE TRIGGER crawl_import_bundle_receipt_insert_guard
BEFORE INSERT ON crawl_import_bundle
WHEN NEW.receipt_created_at IS NOT NULL
  OR NEW.inserted_revisions IS NOT NULL OR NEW.reused_revisions IS NOT NULL
  OR NEW.advanced_pointers IS NOT NULL OR NEW.unchanged_pointers IS NOT NULL
  OR NEW.status = 'promoted'
BEGIN
  SELECT RAISE(ABORT, 'CRAWL_IMPORT_RECEIPT_BUNDLE_INVALID');
END;

CREATE TRIGGER crawl_import_bundle_receipt_update_guard
BEFORE UPDATE ON crawl_import_bundle
WHEN (
  OLD.receipt_created_at IS NOT NULL AND (
    NEW.receipt_created_at IS NOT OLD.receipt_created_at
    OR NEW.inserted_revisions IS NOT OLD.inserted_revisions
    OR NEW.reused_revisions IS NOT OLD.reused_revisions
    OR NEW.advanced_pointers IS NOT OLD.advanced_pointers
    OR NEW.unchanged_pointers IS NOT OLD.unchanged_pointers
  )
) OR (
  OLD.receipt_created_at IS NULL AND NOT (
    NEW.receipt_created_at IS NULL
    AND NEW.inserted_revisions IS NULL AND NEW.reused_revisions IS NULL
    AND NEW.advanced_pointers IS NULL AND NEW.unchanged_pointers IS NULL
    AND NEW.status != 'promoted'
  ) AND NOT (
    OLD.status = 'sealed' AND NEW.status = 'promoted'
    AND NEW.promoted_at IS NOT NULL
    AND NEW.receipt_created_at IS NOT NULL
    AND NEW.inserted_revisions >= 0 AND NEW.reused_revisions >= 0
    AND NEW.advanced_pointers >= 0 AND NEW.unchanged_pointers >= 0
    AND NEW.plan_hash IS NOT NULL
    AND NEW.writer_epoch = OLD.writer_epoch
    AND NEW.writer_epoch = (
      SELECT writer_epoch FROM scraper_writer_control WHERE singleton = 1
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'CRAWL_IMPORT_RECEIPT_BUNDLE_INVALID');
END;
