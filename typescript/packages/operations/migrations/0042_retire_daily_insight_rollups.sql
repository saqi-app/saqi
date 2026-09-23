-- The monthly reader is deployed. Retire daily and incomplete-gap writes.
-- Replaying this migration leaves the same trigger and table set.

DROP TRIGGER IF EXISTS insights_source_poem_insert;
DROP TRIGGER IF EXISTS insights_source_poem_month_insert;
CREATE TRIGGER insights_source_poem_insert
AFTER INSERT ON source_poem_identity
BEGIN
  UPDATE insights_rollup SET source_poem_count = source_poem_count + 1
  WHERE singleton = 1;
  INSERT INTO insights_collection_month (month, poem_count)
  VALUES (date(NEW.first_observed_at, 'unixepoch', 'start of month'), 1)
  ON CONFLICT(month) DO UPDATE SET poem_count = poem_count + 1;
END;

DROP TABLE IF EXISTS insights_collection_day;

DROP TRIGGER IF EXISTS insights_author_insert;
DROP TRIGGER IF EXISTS insights_author_delete;
DROP TRIGGER IF EXISTS insights_author_progress_update;
DROP TRIGGER IF EXISTS insights_poem_insert;
DROP TRIGGER IF EXISTS insights_poem_delete;
DROP TRIGGER IF EXISTS insights_poem_author_update;
DROP TABLE IF EXISTS insights_author_progress;

CREATE TRIGGER insights_author_insert
AFTER INSERT ON author
BEGIN
  UPDATE insights_rollup SET author_count = author_count + 1 WHERE singleton = 1;
END;

CREATE TRIGGER insights_author_delete
AFTER DELETE ON author
BEGIN
  UPDATE insights_rollup SET author_count = author_count - 1 WHERE singleton = 1;
END;

CREATE TRIGGER insights_poem_insert
AFTER INSERT ON poem
BEGIN
  UPDATE insights_rollup SET poem_count = poem_count + 1 WHERE singleton = 1;
END;

CREATE TRIGGER insights_poem_delete
AFTER DELETE ON poem
BEGIN
  UPDATE insights_rollup SET poem_count = poem_count - 1 WHERE singleton = 1;
END;
