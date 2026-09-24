-- The alias table is empty in production and has no application readers or writers.
-- This migration can be replayed: the compact rollup is rebuilt from its current
-- four retained columns, while the alias objects use IF EXISTS guards.

DROP TRIGGER IF EXISTS source_author_alias_insert_guard;
DROP TRIGGER IF EXISTS source_author_alias_update_guard;
DROP TRIGGER IF EXISTS source_author_alias_delete_forbidden;
DROP TABLE IF EXISTS source_author_alias;

DROP TRIGGER IF EXISTS insights_source_poem_insert;
DROP TRIGGER IF EXISTS insights_author_insert;
DROP TRIGGER IF EXISTS insights_author_delete;
DROP TRIGGER IF EXISTS insights_poem_insert;
DROP TRIGGER IF EXISTS insights_poem_delete;

CREATE TABLE IF NOT EXISTS insights_rollup_compact (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  author_count INTEGER NOT NULL DEFAULT 0 CHECK (author_count >= 0),
  poem_count INTEGER NOT NULL DEFAULT 0 CHECK (poem_count >= 0),
  source_poem_count INTEGER NOT NULL DEFAULT 0 CHECK (source_poem_count >= 0)
) STRICT;

INSERT OR REPLACE INTO insights_rollup_compact (
  singleton, author_count, poem_count, source_poem_count
)
SELECT singleton, author_count, poem_count, source_poem_count
FROM insights_rollup;

DROP TABLE IF EXISTS insights_rollup;
ALTER TABLE insights_rollup_compact RENAME TO insights_rollup;

CREATE TRIGGER insights_source_poem_insert
AFTER INSERT ON source_poem_identity
BEGIN
  UPDATE insights_rollup SET source_poem_count = source_poem_count + 1
  WHERE singleton = 1;
  INSERT INTO insights_collection_month (month, poem_count)
  VALUES (date(NEW.first_observed_at, 'unixepoch', 'start of month'), 1)
  ON CONFLICT(month) DO UPDATE SET poem_count = poem_count + 1;
END;

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
