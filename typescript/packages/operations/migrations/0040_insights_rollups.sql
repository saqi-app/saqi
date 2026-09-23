-- Read-optimized public collection and enrichment statistics. Historical
-- migrations retain their D1 receipts; this is the sole migration for the
-- new reporting feature. Reapplying this SQL restores the same rollups.

CREATE TABLE IF NOT EXISTS insights_rollup (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  author_count INTEGER NOT NULL DEFAULT 0 CHECK (author_count >= 0),
  poem_count INTEGER NOT NULL DEFAULT 0 CHECK (poem_count >= 0),
  declared_poem_count INTEGER NOT NULL DEFAULT 0 CHECK (declared_poem_count >= 0),
  declared_author_count INTEGER NOT NULL DEFAULT 0 CHECK (declared_author_count >= 0),
  remaining_poem_count INTEGER NOT NULL DEFAULT 0 CHECK (remaining_poem_count >= 0),
  source_poem_count INTEGER NOT NULL DEFAULT 0 CHECK (source_poem_count >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS insights_author_progress (
  author_id TEXT PRIMARY KEY,
  declared_poem_count INTEGER NOT NULL CHECK (declared_poem_count >= 0),
  poem_count INTEGER NOT NULL CHECK (poem_count >= 0),
  remaining_poem_count INTEGER NOT NULL CHECK (remaining_poem_count >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS insights_model_count (
  model_key TEXT PRIMARY KEY,
  poem_count INTEGER NOT NULL CHECK (poem_count >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS insights_collection_day (
  day TEXT PRIMARY KEY,
  poem_count INTEGER NOT NULL CHECK (poem_count >= 0)
) STRICT;

DELETE FROM insights_author_progress;
INSERT INTO insights_author_progress (
  author_id, declared_poem_count, poem_count, remaining_poem_count
)
SELECT author.id, author.poem_count, count(poem.id),
  CASE WHEN author.poem_count > count(poem.id)
    THEN author.poem_count - count(poem.id) ELSE 0 END
FROM author
LEFT JOIN poem ON poem.author_id = author.id
GROUP BY author.id
ON CONFLICT(author_id) DO UPDATE SET
  declared_poem_count = excluded.declared_poem_count,
  poem_count = excluded.poem_count,
  remaining_poem_count = excluded.remaining_poem_count;

INSERT INTO insights_rollup (
  singleton, author_count, poem_count, declared_poem_count,
  declared_author_count, remaining_poem_count, source_poem_count
) SELECT 1,
    (SELECT count(*) FROM insights_author_progress),
    (SELECT count(*) FROM poem),
    (SELECT coalesce(sum(declared_poem_count), 0) FROM insights_author_progress),
    (SELECT count(*) FROM insights_author_progress WHERE declared_poem_count > 0),
    (SELECT coalesce(sum(remaining_poem_count), 0) FROM insights_author_progress),
    (SELECT count(*) FROM source_poem_identity)
ON CONFLICT(singleton) DO UPDATE SET
  author_count = excluded.author_count,
  poem_count = excluded.poem_count,
  declared_poem_count = excluded.declared_poem_count,
  declared_author_count = excluded.declared_author_count,
  remaining_poem_count = excluded.remaining_poem_count,
  source_poem_count = excluded.source_poem_count;

DELETE FROM insights_model_count;
INSERT INTO insights_model_count (model_key, poem_count)
SELECT model_key, count(*)
FROM poem_model_publication_pointer
GROUP BY model_key
ON CONFLICT(model_key) DO UPDATE SET poem_count = excluded.poem_count;

DELETE FROM insights_collection_day;
INSERT INTO insights_collection_day (day, poem_count)
SELECT date(first_observed_at, 'unixepoch'), count(*)
FROM source_poem_identity
GROUP BY date(first_observed_at, 'unixepoch')
ON CONFLICT(day) DO UPDATE SET poem_count = excluded.poem_count;

CREATE TRIGGER IF NOT EXISTS insights_author_insert
AFTER INSERT ON author
BEGIN
  INSERT INTO insights_author_progress ( -- sarj-noqa: SARJ105 — A duplicate progress row for a newly inserted author indicates drift and must fail.
    author_id, declared_poem_count, poem_count, remaining_poem_count
  ) VALUES (NEW.id, NEW.poem_count, 0, NEW.poem_count);
  UPDATE insights_rollup SET
    author_count = author_count + 1,
    declared_poem_count = declared_poem_count + NEW.poem_count,
    declared_author_count = declared_author_count + (NEW.poem_count > 0),
    remaining_poem_count = remaining_poem_count + NEW.poem_count
  WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS insights_author_delete
AFTER DELETE ON author
BEGIN
  UPDATE insights_rollup SET
    author_count = author_count - 1,
    declared_poem_count = declared_poem_count - OLD.poem_count,
    declared_author_count = declared_author_count - (OLD.poem_count > 0),
    remaining_poem_count = remaining_poem_count - (
      SELECT remaining_poem_count FROM insights_author_progress
      WHERE author_id = OLD.id
    )
  WHERE singleton = 1;
  DELETE FROM insights_author_progress WHERE author_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS insights_author_progress_update
AFTER UPDATE OF id, poem_count ON author
WHEN NEW.id <> OLD.id OR NEW.poem_count <> OLD.poem_count
BEGIN
  UPDATE insights_rollup SET
    declared_poem_count = declared_poem_count + NEW.poem_count - OLD.poem_count,
    declared_author_count = declared_author_count
      + (NEW.poem_count > 0) - (OLD.poem_count > 0),
    remaining_poem_count = remaining_poem_count - (
      SELECT remaining_poem_count FROM insights_author_progress
      WHERE author_id = OLD.id
    )
  WHERE singleton = 1;
  UPDATE insights_author_progress SET
    author_id = NEW.id,
    declared_poem_count = NEW.poem_count,
    remaining_poem_count = max(0, NEW.poem_count - poem_count)
  WHERE author_id = OLD.id;
  UPDATE insights_rollup SET
    remaining_poem_count = remaining_poem_count + (
      SELECT remaining_poem_count FROM insights_author_progress
      WHERE author_id = NEW.id
    )
  WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS insights_poem_insert
AFTER INSERT ON poem
BEGIN
  UPDATE insights_rollup SET
    poem_count = poem_count + 1,
    remaining_poem_count = remaining_poem_count - coalesce((
      SELECT (declared_poem_count > poem_count)
      FROM insights_author_progress WHERE author_id = NEW.author_id
    ), 0)
  WHERE singleton = 1;
  UPDATE insights_author_progress SET
    poem_count = poem_count + 1,
    remaining_poem_count = max(0, remaining_poem_count - 1)
  WHERE author_id = NEW.author_id;
END;

CREATE TRIGGER IF NOT EXISTS insights_poem_delete
AFTER DELETE ON poem
BEGIN
  UPDATE insights_rollup SET
    poem_count = poem_count - 1,
    remaining_poem_count = remaining_poem_count + coalesce((
      SELECT (declared_poem_count >= poem_count)
      FROM insights_author_progress WHERE author_id = OLD.author_id
    ), 0)
  WHERE singleton = 1;
  UPDATE insights_author_progress SET
    poem_count = poem_count - 1,
    remaining_poem_count = max(0, declared_poem_count - (poem_count - 1))
  WHERE author_id = OLD.author_id;
END;

CREATE TRIGGER IF NOT EXISTS insights_poem_author_update
AFTER UPDATE OF author_id ON poem
WHEN NEW.author_id IS NOT OLD.author_id
BEGIN
  UPDATE insights_rollup SET remaining_poem_count = remaining_poem_count
    + coalesce((
      SELECT (declared_poem_count >= poem_count)
      FROM insights_author_progress WHERE author_id = OLD.author_id
    ), 0)
    - coalesce((
      SELECT (declared_poem_count > poem_count)
      FROM insights_author_progress WHERE author_id = NEW.author_id
    ), 0)
  WHERE singleton = 1;
  UPDATE insights_author_progress SET
    poem_count = poem_count - 1,
    remaining_poem_count = max(0, declared_poem_count - (poem_count - 1))
  WHERE author_id = OLD.author_id;
  UPDATE insights_author_progress SET
    poem_count = poem_count + 1,
    remaining_poem_count = max(0, declared_poem_count - (poem_count + 1))
  WHERE author_id = NEW.author_id;
END;

CREATE TRIGGER IF NOT EXISTS insights_source_poem_insert
AFTER INSERT ON source_poem_identity
BEGIN
  UPDATE insights_rollup SET source_poem_count = source_poem_count + 1
  WHERE singleton = 1;
  INSERT INTO insights_collection_day (day, poem_count)
  VALUES (date(NEW.first_observed_at, 'unixepoch'), 1)
  ON CONFLICT(day) DO UPDATE SET poem_count = poem_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS insights_model_pointer_insert
AFTER INSERT ON poem_model_publication_pointer
BEGIN
  INSERT INTO insights_model_count (model_key, poem_count)
  VALUES (NEW.model_key, 1)
  ON CONFLICT(model_key) DO UPDATE SET poem_count = poem_count + 1;
END;
