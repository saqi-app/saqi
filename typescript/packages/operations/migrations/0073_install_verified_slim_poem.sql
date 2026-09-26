-- The copy must match every retained value before the serving table changes.
-- The preceding migration creates indexed child FKs; all are NO ACTION.
-- Defer only across this atomic replacement, then prove all FKs again.
CREATE TABLE IF NOT EXISTS _poem_copy_guard (mismatches INTEGER NOT NULL CHECK(mismatches=0));
INSERT INTO _poem_copy_guard -- sarj-noqa: SARJ105 — Atomic parity assertion, not a replayed data insert.
SELECT count(*) FROM poem p LEFT JOIN _poem_next n ON n.id=p.id
WHERE n.id IS NULL OR
  p."id" IS NOT n."id" COLLATE BINARY OR
  p."author_id" IS NOT n."author_id" COLLATE BINARY OR
  p."slug" IS NOT n."slug" COLLATE BINARY OR
  p."verses" IS NOT n."verses" COLLATE BINARY OR
  p."name_arabic" IS NOT n."name_arabic" COLLATE BINARY OR
  p."name_english" IS NOT n."name_english" COLLATE BINARY OR
  p."content_arabic" IS NOT n."content_arabic" COLLATE BINARY OR
  p."poem_title_first_line" IS NOT n."poem_title_first_line" COLLATE BINARY OR
  p."hidden" IS NOT n."hidden" COLLATE BINARY OR
  p."publishable" IS NOT n."publishable" COLLATE BINARY OR
  p."sort_name_arabic" IS NOT n."sort_name_arabic" COLLATE BINARY OR
  p."sitemap_shard" IS NOT n."sitemap_shard" COLLATE BINARY OR
  p."source_name" IS NOT n."source_name" COLLATE BINARY OR
  p."source_poem_id" IS NOT n."source_poem_id" COLLATE BINARY OR
  p."source_url" IS NOT n."source_url" COLLATE BINARY OR
  p."source_hash" IS NOT n."source_hash" COLLATE BINARY OR
  p."collected_at" IS NOT n."collected_at" COLLATE BINARY OR
  p."publication_json" IS NOT n."publication_json" COLLATE BINARY OR
  p."publication_source_hash" IS NOT n."publication_source_hash" COLLATE BINARY OR
  p."publication_hash" IS NOT n."publication_hash" COLLATE BINARY OR
  p."publication_cache_dirty" IS NOT n."publication_cache_dirty" COLLATE BINARY OR
  p."rig_status" IS NOT n."rig_status" COLLATE BINARY OR
  p."rig_version" IS NOT n."rig_version" COLLATE BINARY OR
  p."rig_lease_token" IS NOT n."rig_lease_token" COLLATE BINARY OR
  p."rig_lease_expires_at" IS NOT n."rig_lease_expires_at" COLLATE BINARY OR
  p."rig_checkpoint_json" IS NOT n."rig_checkpoint_json" COLLATE BINARY OR
  p."rig_last_error" IS NOT n."rig_last_error" COLLATE BINARY OR
  p."rig_updated_at" IS NOT n."rig_updated_at" COLLATE BINARY;
INSERT INTO _poem_copy_guard -- sarj-noqa: SARJ105 — Atomic parity assertion, not a replayed data insert.
SELECT count(*) FROM _poem_next n LEFT JOIN poem p ON p.id=n.id WHERE p.id IS NULL;
DROP TABLE IF EXISTS _poem_copy_guard;
PRAGMA defer_foreign_keys=ON;
DROP TABLE IF EXISTS poem;
ALTER TABLE _poem_next RENAME TO poem;
CREATE INDEX idx_poem_author_id ON poem(author_id);
CREATE INDEX idx_poem_public_author_title -- sarj-noqa: SARJ116 — Verified existing baseline index, not incremental index growth; preserve schema equivalence.
  ON poem(author_id, sort_name_arabic, id)
  WHERE hidden = 0 AND publishable = 1;
CREATE INDEX idx_poem_public_sitemap -- sarj-noqa: SARJ116 — Verified existing baseline index, not incremental index growth; preserve schema equivalence.
ON poem(sitemap_shard, id, author_id)
WHERE hidden = 0 AND publishable = 1;
CREATE INDEX poem_needs_enrichment -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  ON poem(id)
  WHERE hidden = 0 AND publishable = 1
    AND (publication_json IS NULL
      OR publication_source_hash IS NULL
      OR publication_source_hash <> source_hash);
CREATE INDEX poem_publication_cache_dirty ON poem(id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE publication_cache_dirty = 1;
CREATE INDEX poem_rig_active ON poem(rig_status, rig_updated_at, id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE rig_status IN ('claimed', 'dispatching', 'unknown');
CREATE INDEX poem_rig_retry ON poem(id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE rig_status = 'retry';
CREATE UNIQUE INDEX poem_source_identity -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  ON poem(source_name, source_poem_id)
  WHERE source_name IS NOT NULL AND source_poem_id IS NOT NULL;
CREATE TRIGGER poem_generated_title_guard_before_insert
BEFORE INSERT ON poem
WHEN
  (NEW.name_english IS NOT NULL AND (
    instr(NEW.name_english, char(10)) > 0
    OR length(trim(NEW.name_english)) > 200
  ))
  OR (NEW.poem_title_first_line IS NOT NULL AND (
    instr(NEW.poem_title_first_line, char(10)) > 0
    OR length(trim(NEW.poem_title_first_line)) > 200
  ))
  OR EXISTS (
    SELECT 1
    FROM json_each(json_array(
      '*here is*translat*', '*ai assistant*', '*unable to translat*',
      '*cannot translat*', '*do not*translat*', '*don''t*translat*',
      '*attempt*translat*', '*translated title*', '*from english to arabic*',
      '*you are an arabic*', 'i will not*translat*', 'i will not*provide*',
      'i have nothing*translat*', 'i have nothing*output*',
      'i have not*translat*', 'i presume not*translat*',
      'i did not*translat*', 'i am not able*translat*',
      'you''re right*translat*', '*without proper context*',
      '*copyrighted material*', '*as requested*translat*',
      '*as requested*output*', '*do not speak arabic*',
      '*not attempt to translat*', '*refrain from translat*',
      '*translation capabilities*', '*translation services*',
      '*please provide*arabic*', '*let''s have*discussion*',
      '*let''s have*conversation*', '*entrust you*translate*',
      'nice try*translate*', 'without permission*translate*',
      'translated to *', 'titles translated', 'my poem translation:'
    )) AS rejected
    WHERE lower(COALESCE(NEW.name_english, '')) GLOB rejected.value
      OR lower(COALESCE(NEW.poem_title_first_line, '')) GLOB rejected.value
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid generated poem title');
END;
CREATE TRIGGER poem_generated_title_guard_before_update
BEFORE UPDATE OF name_english, poem_title_first_line ON poem
WHEN
  (NEW.name_english IS NOT NULL AND (
    instr(NEW.name_english, char(10)) > 0
    OR length(trim(NEW.name_english)) > 200
  ))
  OR (NEW.poem_title_first_line IS NOT NULL AND (
    instr(NEW.poem_title_first_line, char(10)) > 0
    OR length(trim(NEW.poem_title_first_line)) > 200
  ))
  OR EXISTS (
    SELECT 1
    FROM json_each(json_array(
      '*here is*translat*', '*ai assistant*', '*unable to translat*',
      '*cannot translat*', '*do not*translat*', '*don''t*translat*',
      '*attempt*translat*', '*translated title*', '*from english to arabic*',
      '*you are an arabic*', 'i will not*translat*', 'i will not*provide*',
      'i have nothing*translat*', 'i have nothing*output*',
      'i have not*translat*', 'i presume not*translat*',
      'i did not*translat*', 'i am not able*translat*',
      'you''re right*translat*', '*without proper context*',
      '*copyrighted material*', '*as requested*translat*',
      '*as requested*output*', '*do not speak arabic*',
      '*not attempt to translat*', '*refrain from translat*',
      '*translation capabilities*', '*translation services*',
      '*please provide*arabic*', '*let''s have*discussion*',
      '*let''s have*conversation*', '*entrust you*translate*',
      'nice try*translate*', 'without permission*translate*',
      'translated to *', 'titles translated', 'my poem translation:'
    )) AS rejected
    WHERE lower(COALESCE(NEW.name_english, '')) GLOB rejected.value
      OR lower(COALESCE(NEW.poem_title_first_line, '')) GLOB rejected.value
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid generated poem title');
END;
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
CREATE TRIGGER poem_sort_name_after_insert
AFTER INSERT ON poem
BEGIN
  UPDATE poem
  SET sort_name_arabic = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    trim(NEW.name_arabic),
    'ـ', ''), 'ً', ''), 'ٌ', ''), 'ٍ', ''), 'َ', ''), 'ُ', ''), 'ِ', ''), 'ّ', ''), 'ْ', ''), 'ٰ', ''),
    'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'), 'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي')
  WHERE id = NEW.id;
END;
CREATE TRIGGER poem_sort_name_after_update
AFTER UPDATE OF name_arabic ON poem
WHEN OLD.name_arabic IS NOT NEW.name_arabic
BEGIN
  UPDATE poem
  SET sort_name_arabic = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    trim(NEW.name_arabic),
    'ـ', ''), 'ً', ''), 'ٌ', ''), 'ٍ', ''), 'َ', ''), 'ُ', ''), 'ِ', ''), 'ّ', ''), 'ْ', ''), 'ٰ', ''),
    'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'), 'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي')
  WHERE id = NEW.id;
END;
CREATE TABLE IF NOT EXISTS _poem_fk_guard (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO _poem_fk_guard -- sarj-noqa: SARJ105 — Atomic FK assertion, not a replayed data insert.
SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE IF EXISTS _poem_fk_guard;
PRAGMA defer_foreign_keys=OFF;
