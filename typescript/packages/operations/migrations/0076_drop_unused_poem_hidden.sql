-- Run only after the column-independent reader/writer release is deployed.
-- Refuse to expose any poem hidden since the live audit.
CREATE TABLE IF NOT EXISTS _unused_hidden_guard (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO _unused_hidden_guard -- sarj-noqa: SARJ105 — Atomic migration guard; no persistent record survives.
SELECT count(*) FROM poem WHERE hidden <> 0;
DROP TABLE IF EXISTS _unused_hidden_guard;
DROP INDEX IF EXISTS idx_poem_public_author_title;
DROP INDEX IF EXISTS idx_poem_public_sitemap;
DROP INDEX IF EXISTS poem_needs_enrichment;
DROP TRIGGER IF EXISTS poem_publishability_after_insert;
DROP TRIGGER IF EXISTS poem_publishability_after_update;
ALTER TABLE poem DROP COLUMN hidden; -- sarj-noqa: SARJ102 — SQLite has no DROP COLUMN IF EXISTS; Wrangler applies this ledgered migration exactly once.
CREATE INDEX IF NOT EXISTS idx_poem_public_author_title -- sarj-noqa: SARJ108,SARJ116 — SQLite lacks CONCURRENTLY; verified existing baseline index, not incremental index growth; preserve schema equivalence.
  ON poem(author_id, sort_name_arabic, id)
  WHERE publishable = 1;
CREATE INDEX IF NOT EXISTS idx_poem_public_sitemap -- sarj-noqa: SARJ108,SARJ116 — SQLite lacks CONCURRENTLY; verified existing baseline index, not incremental index growth; preserve schema equivalence.
ON poem(sitemap_shard, id, author_id)
WHERE publishable = 1;
CREATE INDEX IF NOT EXISTS poem_needs_enrichment -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  ON poem(id)
  WHERE publishable = 1
    AND (publication_json IS NULL
      OR publication_source_hash IS NULL
      OR publication_source_hash <> source_hash);
CREATE TRIGGER poem_publishability_after_insert
AFTER INSERT ON poem
BEGIN
  UPDATE poem
  SET publishable = CASE
    WHEN length(trim(NEW.id)) BETWEEN 1 AND 500
      AND NEW.id = trim(NEW.id)
      AND NEW.id NOT IN ('.', '..')
      AND instr(NEW.id, '/') = 0
      AND length(trim(NEW.slug)) BETWEEN 1 AND 500
      AND NEW.slug = trim(NEW.slug)
      AND NEW.slug NOT IN ('.', '..')
      AND instr(NEW.slug, '/') = 0
      AND length(trim(NEW.name_arabic)) BETWEEN 1 AND 500
      AND NEW.name_arabic = trim(NEW.name_arabic)
      AND NEW.verses BETWEEN 1 AND 1000
      AND NOT EXISTS (
        SELECT 1 FROM json_each(json_array(NEW.id, NEW.slug, NEW.name_arabic)) field
        WHERE EXISTS (
          SELECT 1 FROM json_each('[0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,8234,8235,8236,8237,8238,8294,8295,8296,8297]') control
          WHERE instr(field.value, char(control.value)) > 0
        )
      )
      AND CASE WHEN json_valid(NEW.content_arabic)
        THEN json_type(NEW.content_arabic, '$.content') = 'array'
          AND json_array_length(NEW.content_arabic, '$.content') BETWEEN 1 AND 2000
        ELSE 0
      END
      AND NOT EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(NEW.content_arabic)
            THEN NEW.content_arabic ELSE '{"content":[]}' END,
          '$.content'
        ) line
        WHERE line.type <> 'text'
          OR length(line.value) > 5000
          OR EXISTS (
            SELECT 1 FROM json_each('[0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,8234,8235,8236,8237,8238,8294,8295,8296,8297]') control
            WHERE instr(line.value, char(control.value)) > 0
          )
      )
      AND EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(NEW.content_arabic)
            THEN NEW.content_arabic ELSE '{"content":[]}' END,
          '$.content'
        ) line
        WHERE line.type = 'text' AND trim(line.value) <> ''
      )
    THEN 1 ELSE 0
  END
  WHERE id = NEW.id;
END;
CREATE TRIGGER poem_publishability_after_update
AFTER UPDATE OF id, slug, verses, name_arabic, content_arabic ON poem
BEGIN
  UPDATE poem
  SET publishable = CASE
    WHEN length(trim(NEW.id)) BETWEEN 1 AND 500
      AND NEW.id = trim(NEW.id)
      AND NEW.id NOT IN ('.', '..')
      AND instr(NEW.id, '/') = 0
      AND length(trim(NEW.slug)) BETWEEN 1 AND 500
      AND NEW.slug = trim(NEW.slug)
      AND NEW.slug NOT IN ('.', '..')
      AND instr(NEW.slug, '/') = 0
      AND length(trim(NEW.name_arabic)) BETWEEN 1 AND 500
      AND NEW.name_arabic = trim(NEW.name_arabic)
      AND NEW.verses BETWEEN 1 AND 1000
      AND NOT EXISTS (
        SELECT 1 FROM json_each(json_array(NEW.id, NEW.slug, NEW.name_arabic)) field
        WHERE EXISTS (
          SELECT 1 FROM json_each('[0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,8234,8235,8236,8237,8238,8294,8295,8296,8297]') control
          WHERE instr(field.value, char(control.value)) > 0
        )
      )
      AND CASE WHEN json_valid(NEW.content_arabic)
        THEN json_type(NEW.content_arabic, '$.content') = 'array'
          AND json_array_length(NEW.content_arabic, '$.content') BETWEEN 1 AND 2000
        ELSE 0
      END
      AND NOT EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(NEW.content_arabic)
            THEN NEW.content_arabic ELSE '{"content":[]}' END,
          '$.content'
        ) line
        WHERE line.type <> 'text'
          OR length(line.value) > 5000
          OR EXISTS (
            SELECT 1 FROM json_each('[0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,8234,8235,8236,8237,8238,8294,8295,8296,8297]') control
            WHERE instr(line.value, char(control.value)) > 0
          )
      )
      AND EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(NEW.content_arabic)
            THEN NEW.content_arabic ELSE '{"content":[]}' END,
          '$.content'
        ) line
        WHERE line.type = 'text' AND trim(line.value) <> ''
      )
    THEN 1 ELSE 0
  END
  WHERE id = NEW.id;
END;
