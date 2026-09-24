-- Mirror the deployed publishability control in fresh installs. The 39 code
-- points are shared with the public catalog's unsafe-control predicate.
-- Existing deployments already have this table and these triggers, but the
-- rebuilt 0037 baseline omitted the table and used weaker trigger predicates.
CREATE TABLE IF NOT EXISTS catalog_unsafe_control ( -- sarj-noqa: SARJ102 — Fresh installs need the deployed control table; production already has it.
  value TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO catalog_unsafe_control (value) -- sarj-noqa: SARJ105 — Seed only missing policy code points without rewriting production values.
SELECT char(value) FROM json_each('[0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,8234,8235,8236,8237,8238,8294,8295,8296,8297]');

-- Guard deployed data before replacing triggers. Any unexpected control value
-- aborts the D1 migration transaction instead of changing publication policy.
CREATE TABLE IF NOT EXISTS _catalog_unsafe_control_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);
INSERT INTO _catalog_unsafe_control_guard (invalid_count) -- sarj-noqa: SARJ105 — Fail if the control set has an unexpected cardinality.
SELECT (SELECT count(*) FROM catalog_unsafe_control) - 39;
INSERT INTO _catalog_unsafe_control_guard (invalid_count) -- sarj-noqa: SARJ105 — Fail if any deployed value differs from the confirmed catalog policy.
SELECT count(*) FROM catalog_unsafe_control control
WHERE NOT EXISTS (
  SELECT 1 FROM json_each('[0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,8234,8235,8236,8237,8238,8294,8295,8296,8297]') expected
  WHERE control.value = char(expected.value)
);
DROP TABLE IF EXISTS _catalog_unsafe_control_guard; -- sarj-noqa: SARJ119 — D1 rolls back all seed and trigger changes if either parity assertion fails.

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
          SELECT 1 FROM catalog_unsafe_control control
          WHERE instr(field.value, control.value) > 0
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
            SELECT 1 FROM catalog_unsafe_control control
            WHERE instr(line.value, control.value) > 0
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
          SELECT 1 FROM catalog_unsafe_control control
          WHERE instr(field.value, control.value) > 0
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
            SELECT 1 FROM catalog_unsafe_control control
            WHERE instr(line.value, control.value) > 0
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
