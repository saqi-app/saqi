-- The production audit found 66 nonpublic poems: zero publications and
-- zero active/unknown invocations. Future malformed writes abort rather than
-- persisting an invisible poem. The public readers still use publishable until
-- their separate cutover. A Time Travel bookmark precedes this deletion.
-- Wrangler records this file once; D1 serializes its write transaction. The
-- guard aborts unexpected live state, and the postcondition proves no invalid
-- row remains. Restore the deployment bookmark if the published count moves.
CREATE TABLE IF NOT EXISTS _invalid_poem_guard (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO _invalid_poem_guard -- sarj-noqa: SARJ105 — Guard the audited production deletion.
SELECT CASE WHEN
  ((SELECT count(*) FROM poem) < 1000
    OR (SELECT count(*) FROM poem WHERE publishable <> 1) = 66)
  AND (SELECT count(*) FROM poem
       WHERE publishable <> 1 AND publication_json IS NOT NULL) = 0
  AND (SELECT count(*) FROM poem
       WHERE publishable <> 1 AND rig_status IN ('claimed','dispatching','unknown')) = 0
THEN 0 ELSE 1 END;
CREATE TRIGGER poem_valid_before_insert
BEFORE INSERT ON poem
WHEN CASE WHEN length(trim(NEW.id)) BETWEEN 1 AND 500
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
  THEN 0 ELSE 1 END = 1
BEGIN
  SELECT RAISE(ABORT, 'invalid poem');
END;
CREATE TRIGGER poem_valid_before_update
BEFORE UPDATE OF id, slug, verses, name_arabic, content_arabic ON poem
WHEN CASE WHEN length(trim(NEW.id)) BETWEEN 1 AND 500
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
  THEN 0 ELSE 1 END = 1
BEGIN
  SELECT RAISE(ABORT, 'invalid poem');
END;
DELETE FROM poem WHERE publishable <> 1; -- sarj-noqa: SARJ105 — Only audited nonpublic, unpublished, inactive rows.
INSERT INTO _invalid_poem_guard -- sarj-noqa: SARJ105 — The corpus is now canonical for the reader cutover.
SELECT count(*) FROM poem WHERE publishable <> 1;
DROP TABLE IF EXISTS _invalid_poem_guard;
