-- Freeze the existing 39-code-point publishability rule inside the two poem
-- triggers, then remove the write-maintained policy table. The public catalog
-- and direct writers already use the same deterministic code-point list.
CREATE TABLE IF NOT EXISTS _unsafe_policy_parity_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);
INSERT INTO _unsafe_policy_parity_guard (invalid_count) -- sarj-noqa: SARJ105 — Intentional CHECK failure aborts the atomic migration if the installed set has a different cardinality.
SELECT (SELECT count(*) FROM catalog_unsafe_control) - 39;
INSERT INTO _unsafe_policy_parity_guard (invalid_count) -- sarj-noqa: SARJ105 — Intentional CHECK failure aborts the atomic migration if any installed point differs.
SELECT count(*) FROM catalog_unsafe_control control
WHERE NOT EXISTS (
  SELECT 1 FROM json_each('[0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,8234,8235,8236,8237,8238,8294,8295,8296,8297]') expected
  WHERE control.value = char(expected.value)
);
DROP TABLE IF EXISTS _unsafe_policy_parity_guard;

DROP TRIGGER IF EXISTS poem_publishability_after_insert;
DROP TRIGGER IF EXISTS poem_publishability_after_update;

CREATE TRIGGER poem_publishability_after_insert
AFTER INSERT ON poem
BEGIN
  UPDATE poem
  SET publishable = CASE
    WHEN NEW.hidden = 0
      AND length(trim(NEW.id)) BETWEEN 1 AND 500
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
AFTER UPDATE OF id, slug, verses, hidden, name_arabic, content_arabic ON poem
BEGIN
  UPDATE poem
  SET publishable = CASE
    WHEN NEW.hidden = 0
      AND length(trim(NEW.id)) BETWEEN 1 AND 500
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

DROP TABLE IF EXISTS catalog_unsafe_control;
