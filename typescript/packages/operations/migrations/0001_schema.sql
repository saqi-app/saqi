-- Current schema. Reapplying this baseline preserves existing corpus and publication state.

CREATE TABLE IF NOT EXISTS author (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_arabic TEXT NOT NULL CHECK (length(name_arabic) <= 10000),
  name TEXT,
  sort_name_arabic TEXT NOT NULL DEFAULT '', source_author_id TEXT, source_url TEXT, source_retry_after INTEGER CHECK (source_retry_after IS NULL OR source_retry_after >= 0));

CREATE TABLE IF NOT EXISTS "poem" (
  id TEXT PRIMARY KEY,
  author_id TEXT REFERENCES author(id) ON DELETE SET NULL,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) <= 1000),
  verses INTEGER NOT NULL CHECK (verses > 0),
  name_arabic TEXT NOT NULL CHECK (length(name_arabic) <= 10000),
  name_english TEXT CHECK (length(name_english) <= 10000),
  content_arabic TEXT NOT NULL,
  sort_name_arabic TEXT NOT NULL DEFAULT '',
  sitemap_shard INTEGER NOT NULL DEFAULT 0 CHECK (sitemap_shard BETWEEN 0 AND 15),
  source_poem_id TEXT,
  source_hash TEXT,
  publication_json TEXT CHECK (publication_json IS NULL OR json_valid(publication_json)),
  publication_source_hash TEXT,
  publication_hash TEXT,
  publication_cache_dirty INTEGER NOT NULL DEFAULT 0 CHECK (publication_cache_dirty IN (0, 1)),
  rig_status TEXT CHECK (rig_status IS NULL OR rig_status IN ('claimed', 'dispatching', 'unknown', 'retry', 'blocked', 'complete')),
  rig_version INTEGER NOT NULL DEFAULT 0 CHECK (rig_version >= 0),
  rig_lease_token TEXT,
  rig_lease_expires_at INTEGER,
  rig_checkpoint_json TEXT CHECK (rig_checkpoint_json IS NULL OR (json_valid(rig_checkpoint_json) AND length(CAST(rig_checkpoint_json AS BLOB)) <= 1048576)), publication_cache_generation INTEGER NOT NULL DEFAULT 1, public_slug TEXT, public_slug_language TEXT, public_route_generation INTEGER NOT NULL DEFAULT 1, public_route_checked_generation INTEGER NOT NULL DEFAULT 0, public_route_cache_generation INTEGER NOT NULL DEFAULT 0, public_route_cache_epoch INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS author_index_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
  next_purge_at INTEGER NOT NULL DEFAULT 0 CHECK (next_purge_at BETWEEN 0 AND 9007199254740991),
  bootstrap_generation INTEGER CHECK (bootstrap_generation IS NULL OR bootstrap_generation BETWEEN 1 AND 9007199254740991)
, public_routes_purged_epoch INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS public_author_namespace (
  id TEXT PRIMARY KEY NOT NULL,
  author_id TEXT UNIQUE REFERENCES author(id) ON DELETE SET NULL ON UPDATE SET NULL,
  canonical_slug TEXT,
  FOREIGN KEY(id, canonical_slug) REFERENCES public_author_segment(namespace_id, segment)
);

CREATE TABLE IF NOT EXISTS public_author_segment (
  segment TEXT PRIMARY KEY NOT NULL COLLATE BINARY,
  namespace_id TEXT NOT NULL REFERENCES public_author_namespace(id),
  UNIQUE(namespace_id, segment)
);

CREATE TABLE IF NOT EXISTS public_poem_alias (
  author_namespace_id TEXT NOT NULL REFERENCES public_author_namespace(id),
  segment TEXT NOT NULL COLLATE BINARY,
  poem_id TEXT REFERENCES poem(id) ON DELETE SET NULL ON UPDATE SET NULL,
  PRIMARY KEY(author_namespace_id, segment)
);

CREATE INDEX IF NOT EXISTS poem_publication_cache_dirty ON poem(id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE publication_cache_dirty = 1;

CREATE INDEX IF NOT EXISTS poem_rig_retry ON poem(id) -- sarj-noqa: SARJ108 — D1 SQLite lacks CONCURRENTLY; Wrangler serializes the migration.
  WHERE rig_status = 'retry';

CREATE INDEX IF NOT EXISTS poem_rig_active ON poem(rig_status, id) -- sarj-noqa: SARJ108,SARJ116 — Replaces the previous active-work index; D1 cannot build it concurrently.
  WHERE rig_status IN ('claimed', 'dispatching', 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS author_source_id ON author(source_author_id) -- sarj-noqa: SARJ108,SARJ116 — D1 builds this forward-migration index serially; source ID lookup is a live application read.
  WHERE source_author_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS poem_source_id ON poem(source_poem_id) -- sarj-noqa: SARJ108,SARJ116 — D1 builds this forward-migration index serially; source ID lookup is a live application read.
  WHERE source_poem_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_poem_author_title_canonical -- sarj-noqa: SARJ108,SARJ116 — Author page ORDER BY author_id, sort_name_arabic, id; D1 serializes this forward migration.
  ON poem(author_id, sort_name_arabic, id);

CREATE INDEX IF NOT EXISTS idx_poem_sitemap_canonical -- sarj-noqa: SARJ108,SARJ116 — Sitemap shard scan orders by id; D1 serializes this forward migration.
  ON poem(sitemap_shard, id, author_id);

CREATE INDEX IF NOT EXISTS poem_needs_enrichment_canonical -- sarj-noqa: SARJ108,SARJ116 — Rig scans current unpublished or stale source rows by id; D1 serializes this forward migration.
  ON poem(id)
  WHERE publication_json IS NULL
    OR publication_source_hash IS NULL
    OR publication_source_hash <> source_hash;

-- index-justification: referential-action: ON DELETE SET NULL
CREATE INDEX IF NOT EXISTS public_poem_alias_poem ON public_poem_alias(poem_id) WHERE poem_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS poem_public_routes_pending ON poem(id) -- sarj-noqa: SARJ108,SARJ116 — App read uses INDEXED BY poem_public_routes_pending for bounded allocation; SQLite EXPLAIN scans this partial index.
  WHERE public_route_checked_generation<public_route_generation;

-- index-justification: app-read: bounded route purge; query: typescript/packages/operations/src/lib/public-route-cache-repository.ts#COVERED_PREFIX; explain: https://github.com/saqi-app/saqi/blob/main/typescript/packages/operations/src/lib/public-route-cache-repository.test.ts
CREATE INDEX IF NOT EXISTS poem_public_route_cache_pending ON poem(public_route_cache_epoch,id) WHERE public_route_cache_epoch>0;

CREATE TRIGGER IF NOT EXISTS author_sort_name_after_insert
AFTER INSERT ON author
BEGIN
  UPDATE author
  SET sort_name_arabic = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    trim(NEW.name_arabic),
    'ـ', ''), 'ً', ''), 'ٌ', ''), 'ٍ', ''), 'َ', ''), 'ُ', ''), 'ِ', ''), 'ّ', ''), 'ْ', ''), 'ٰ', ''),
    'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'), 'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي')
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS author_sort_name_after_update
AFTER UPDATE OF name_arabic ON author
WHEN OLD.name_arabic IS NOT NEW.name_arabic
BEGIN
  UPDATE author
  SET sort_name_arabic = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    trim(NEW.name_arabic),
    'ـ', ''), 'ً', ''), 'ٌ', ''), 'ٍ', ''), 'َ', ''), 'ُ', ''), 'ِ', ''), 'ّ', ''), 'ْ', ''), 'ٰ', ''),
    'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'), 'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي')
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS poem_sort_name_after_insert
AFTER INSERT ON poem
BEGIN
  UPDATE poem
  SET sort_name_arabic = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    trim(NEW.name_arabic),
    'ـ', ''), 'ً', ''), 'ٌ', ''), 'ٍ', ''), 'َ', ''), 'ُ', ''), 'ِ', ''), 'ّ', ''), 'ْ', ''), 'ٰ', ''),
    'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'), 'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي')
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS poem_sort_name_after_update
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

CREATE TRIGGER IF NOT EXISTS poem_generated_title_guard_before_insert
BEFORE INSERT ON poem
WHEN
  (NEW.name_english IS NOT NULL AND (
    instr(NEW.name_english, char(10)) > 0
    OR length(trim(NEW.name_english)) > 200
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
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid generated poem title');
END;

CREATE TRIGGER IF NOT EXISTS poem_generated_title_guard_before_update
BEFORE UPDATE OF name_english ON poem
WHEN
  (NEW.name_english IS NOT NULL AND (
    instr(NEW.name_english, char(10)) > 0
    OR length(trim(NEW.name_english)) > 200
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
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid generated poem title');
END;

CREATE TRIGGER IF NOT EXISTS poem_valid_before_insert
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

CREATE TRIGGER IF NOT EXISTS poem_valid_before_update
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

CREATE TRIGGER IF NOT EXISTS poem_publication_cache_after_dirty
AFTER UPDATE OF publication_cache_dirty ON poem
WHEN NEW.publication_cache_dirty = 1
BEGIN
  UPDATE poem SET publication_cache_generation = publication_cache_generation + 1
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS poem_publication_cache_after_legacy_clear
AFTER UPDATE OF publication_cache_dirty ON poem
WHEN OLD.publication_cache_dirty = 1 AND NEW.publication_cache_dirty = 0
  AND OLD.publication_cache_generation = NEW.publication_cache_generation
BEGIN
  UPDATE poem SET publication_cache_dirty = 1 WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS author_index_cache_after_poem_insert
AFTER INSERT ON poem
BEGIN
  UPDATE author_index_cache SET generation = generation + 1, dirty = 1 WHERE id = 1;
  -- New Arabic-only poems already affect author pages, before translation.
  UPDATE poem SET publication_cache_dirty = 1 WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS author_index_cache_after_poem_delete
AFTER DELETE ON poem
BEGIN
  -- The deleted row can no longer supply its old poem and author cache tags.
  UPDATE author_index_cache SET generation = generation + 1,
    bootstrap_generation = generation + 1, dirty = 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS author_index_cache_after_poem_move
AFTER UPDATE OF id, author_id ON poem
WHEN OLD.id IS NOT NEW.id OR OLD.author_id IS NOT NEW.author_id
BEGIN
  -- Current-row lookup cannot recover the old poem ID or author, including
  -- SET NULL on author deletion. Normal maintenance retains its purge budget.
  UPDATE author_index_cache SET generation = generation + 1,
    bootstrap_generation = generation + 1, dirty = 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS author_index_cache_after_author_update
AFTER UPDATE OF id, name_arabic, name, slug, sort_name_arabic ON author
WHEN (OLD.id IS NOT NEW.id OR OLD.name_arabic IS NOT NEW.name_arabic OR OLD.name IS NOT NEW.name
  OR OLD.slug IS NOT NEW.slug OR OLD.sort_name_arabic IS NOT NEW.sort_name_arabic)
  AND EXISTS (SELECT 1 FROM poem WHERE author_id IN (OLD.id, NEW.id))
BEGIN
  UPDATE author_index_cache SET generation = generation + 1, dirty = 1,
    bootstrap_generation = CASE
      WHEN OLD.id IS NOT NEW.id OR OLD.slug IS NOT NEW.slug THEN generation + 1
      ELSE bootstrap_generation END
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS poem_whitespace_before_insert
BEFORE INSERT ON poem
WHEN CASE WHEN trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.id = trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.slug = trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.name_arabic = trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(NEW.content_arabic)
            THEN NEW.content_arabic ELSE '{"content":[]}' END,
          '$.content'
        ) line
        WHERE line.type = 'text' AND trim(line.value, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      )
  THEN 0 ELSE 1 END = 1
BEGIN
  SELECT RAISE(ABORT, 'invalid poem');
END;

CREATE TRIGGER IF NOT EXISTS poem_whitespace_before_update
BEFORE UPDATE OF id, slug, name_arabic, content_arabic ON poem
WHEN CASE WHEN trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.id = trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.slug = trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.name_arabic = trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(NEW.content_arabic)
            THEN NEW.content_arabic ELSE '{"content":[]}' END,
          '$.content'
        ) line
        WHERE line.type = 'text' AND trim(line.value, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      )
  THEN 0 ELSE 1 END = 1
BEGIN
  SELECT RAISE(ABORT, 'invalid poem');
END;

CREATE TRIGGER IF NOT EXISTS author_whitespace_before_insert
BEFORE INSERT ON author
WHEN CASE WHEN trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.id = trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.slug = trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.name_arabic = trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND (NEW.name IS NULL OR trim(NEW.name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
        OR NEW.name = trim(NEW.name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
  THEN 0 ELSE 1 END = 1
BEGIN
  SELECT RAISE(ABORT, 'invalid author');
END;

CREATE TRIGGER IF NOT EXISTS author_whitespace_before_update
BEFORE UPDATE OF id, slug, name_arabic, name ON author
WHEN CASE WHEN trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.id = trim(NEW.id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.slug = trim(NEW.slug, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> ''
      AND NEW.name_arabic = trim(NEW.name_arabic, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
      AND (NEW.name IS NULL OR trim(NEW.name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
        OR NEW.name = trim(NEW.name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
  THEN 0 ELSE 1 END = 1
BEGIN
  SELECT RAISE(ABORT, 'invalid author');
END;

CREATE TRIGGER IF NOT EXISTS public_author_namespace_no_reassignment
BEFORE UPDATE OF author_id ON public_author_namespace
WHEN NEW.author_id IS NOT OLD.author_id AND (NEW.author_id IS NOT NULL OR EXISTS(SELECT 1 FROM author WHERE id=OLD.author_id))
BEGIN SELECT RAISE(ABORT, 'PUBLIC_AUTHOR_NAMESPACE_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_author_segment_no_reassignment
BEFORE UPDATE OF namespace_id, segment ON public_author_segment
WHEN NEW.namespace_id IS NOT OLD.namespace_id OR NEW.segment IS NOT OLD.segment
BEGIN SELECT RAISE(ABORT, 'PUBLIC_AUTHOR_SEGMENT_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_poem_alias_no_reassignment
BEFORE UPDATE OF poem_id ON public_poem_alias
WHEN NEW.poem_id IS NOT OLD.poem_id AND (NEW.poem_id IS NOT NULL OR EXISTS(SELECT 1 FROM poem WHERE id=OLD.poem_id))
BEGIN SELECT RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_poem_alias_no_rekey
BEFORE UPDATE OF author_namespace_id, segment ON public_poem_alias
WHEN NEW.author_namespace_id IS NOT OLD.author_namespace_id OR NEW.segment IS NOT OLD.segment
BEGIN SELECT RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_author_namespace_no_delete BEFORE DELETE ON public_author_namespace
BEGIN SELECT RAISE(ABORT, 'PUBLIC_AUTHOR_NAMESPACE_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_author_segment_no_delete BEFORE DELETE ON public_author_segment
BEGIN SELECT RAISE(ABORT, 'PUBLIC_AUTHOR_SEGMENT_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_poem_alias_no_delete BEFORE DELETE ON public_poem_alias
BEGIN SELECT RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_author_namespace_no_rekey BEFORE UPDATE OF id ON public_author_namespace
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'PUBLIC_AUTHOR_NAMESPACE_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_author_namespace_no_replace BEFORE INSERT ON public_author_namespace
WHEN EXISTS(SELECT 1 FROM public_author_namespace WHERE id=NEW.id OR (NEW.author_id IS NOT NULL AND author_id=NEW.author_id))
BEGIN SELECT RAISE(ABORT, 'PUBLIC_AUTHOR_NAMESPACE_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_author_segment_no_replace BEFORE INSERT ON public_author_segment
WHEN EXISTS(SELECT 1 FROM public_author_segment WHERE segment=NEW.segment)
BEGIN SELECT RAISE(ABORT, 'PUBLIC_AUTHOR_SEGMENT_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_poem_alias_no_replace BEFORE INSERT ON public_poem_alias
WHEN EXISTS(SELECT 1 FROM public_poem_alias WHERE author_namespace_id=NEW.author_namespace_id AND segment=NEW.segment)
BEGIN SELECT RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED'); END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_author_insert AFTER INSERT ON author
BEGIN
  INSERT INTO public_author_namespace(id, author_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT lower(hex(randomblob(16))), NEW.id
    WHERE NOT EXISTS(SELECT 1 FROM public_author_namespace WHERE author_id=NEW.id);
  INSERT INTO public_author_segment(segment, namespace_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT NEW.slug, n.id FROM public_author_namespace n WHERE n.author_id=NEW.id
      AND NOT EXISTS(SELECT 1 FROM public_author_segment WHERE segment=NEW.slug);
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM public_author_segment s JOIN public_author_namespace n ON n.author_id=NEW.id
    WHERE s.segment=NEW.slug AND s.namespace_id<>n.id
  ) THEN RAISE(ABORT, 'PUBLIC_AUTHOR_SEGMENT_OWNED') END;
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_author_identity AFTER UPDATE OF id ON author
WHEN OLD.id IS NOT NEW.id
BEGIN
  INSERT INTO public_author_namespace(id, author_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT lower(hex(randomblob(16))), NEW.id
    WHERE NOT EXISTS(SELECT 1 FROM public_author_namespace WHERE author_id=NEW.id);
  INSERT INTO public_author_segment(segment, namespace_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT NEW.slug, n.id FROM public_author_namespace n WHERE n.author_id=NEW.id
      AND NOT EXISTS(SELECT 1 FROM public_author_segment WHERE segment=NEW.slug);
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_author_slug AFTER UPDATE OF slug ON author
WHEN OLD.slug IS NOT NEW.slug
BEGIN
  INSERT INTO public_author_segment(segment, namespace_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT NEW.slug, n.id FROM public_author_namespace n WHERE n.author_id=NEW.id
      AND NOT EXISTS(SELECT 1 FROM public_author_segment WHERE segment=NEW.slug);
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM public_author_segment s JOIN public_author_namespace n ON n.author_id=NEW.id
    WHERE s.segment=NEW.slug AND s.namespace_id<>n.id
  ) THEN RAISE(ABORT, 'PUBLIC_AUTHOR_SEGMENT_OWNED') END;
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_poem_insert AFTER INSERT ON poem
BEGIN
  INSERT INTO public_poem_alias(author_namespace_id, segment, poem_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT n.id, NEW.id, NEW.id FROM public_author_namespace n WHERE n.author_id=NEW.author_id
      AND NOT EXISTS(SELECT 1 FROM public_poem_alias WHERE author_namespace_id=n.id AND segment=NEW.id);
  INSERT INTO public_poem_alias(author_namespace_id, segment, poem_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT n.id, NEW.public_slug, NEW.id FROM public_author_namespace n
    WHERE n.author_id=NEW.author_id AND NEW.public_slug IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public_poem_alias WHERE author_namespace_id=n.id AND segment=NEW.public_slug);
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM public_poem_alias a JOIN public_author_namespace n ON n.author_id=NEW.author_id
    WHERE a.author_namespace_id=n.id AND (a.segment=NEW.id OR a.segment=NEW.public_slug)
      AND a.poem_id IS NOT NEW.id
  ) THEN RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED') END;
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_poem_identity AFTER UPDATE OF id ON poem
WHEN OLD.id IS NOT NEW.id
BEGIN
  UPDATE poem SET public_slug=NULL, public_slug_language=NULL,
    public_route_generation=public_route_generation+1,
    public_route_checked_generation=0 WHERE id=NEW.id;
  INSERT INTO public_poem_alias(author_namespace_id, segment, poem_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT n.id, NEW.id, NEW.id FROM public_author_namespace n WHERE n.author_id=NEW.author_id
      AND NOT EXISTS(SELECT 1 FROM public_poem_alias WHERE author_namespace_id=n.id AND segment=NEW.id);
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM public_poem_alias a JOIN public_author_namespace n ON n.author_id=NEW.author_id
    WHERE a.author_namespace_id=n.id AND a.segment=NEW.id AND a.poem_id IS NOT NEW.id
  ) THEN RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED') END;
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_poem_move AFTER UPDATE OF author_id ON poem
WHEN OLD.author_id IS NOT NEW.author_id
BEGIN
  INSERT INTO public_poem_alias(author_namespace_id, segment, poem_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT n.id, NEW.id, NEW.id FROM public_author_namespace n WHERE n.author_id=NEW.author_id
      AND NOT EXISTS(SELECT 1 FROM public_poem_alias WHERE author_namespace_id=n.id AND segment=NEW.id);
  INSERT INTO public_poem_alias(author_namespace_id, segment, poem_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT n.id, NEW.public_slug, NEW.id FROM public_author_namespace n
    WHERE n.author_id=NEW.author_id AND NEW.public_slug IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public_poem_alias WHERE author_namespace_id=n.id AND segment=NEW.public_slug);
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM public_poem_alias a JOIN public_author_namespace n ON n.author_id=NEW.author_id
    WHERE a.author_namespace_id=n.id AND (a.segment=NEW.id OR a.segment=NEW.public_slug)
      AND a.poem_id IS NOT NEW.id
  ) THEN RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED') END;
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_poem_source AFTER UPDATE OF content_arabic, publication_json, author_id ON poem
WHEN OLD.content_arabic IS NOT NEW.content_arabic OR OLD.publication_json IS NOT NEW.publication_json OR OLD.author_id IS NOT NEW.author_id
BEGIN
  UPDATE poem SET public_route_generation=public_route_generation+1 WHERE id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_author_canonical AFTER UPDATE OF canonical_slug ON public_author_namespace
WHEN OLD.canonical_slug IS NOT NEW.canonical_slug
BEGIN
  UPDATE author_index_cache SET generation=generation+1, dirty=1,
    bootstrap_generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS public_routes_after_poem_canonical AFTER UPDATE OF public_slug ON poem
WHEN OLD.public_slug IS NOT NEW.public_slug
BEGIN
  INSERT INTO public_poem_alias(author_namespace_id, segment, poem_id) -- sarj-noqa: SARJ105 — Receipts fence seeds; guarded reservations must reject duplicate ownership, never upsert.
    SELECT n.id, NEW.public_slug, NEW.id FROM public_author_namespace n
    WHERE n.author_id=NEW.author_id AND NEW.public_slug IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public_poem_alias WHERE author_namespace_id=n.id AND segment=NEW.public_slug);
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM public_poem_alias a JOIN public_author_namespace n ON n.author_id=NEW.author_id
    WHERE a.author_namespace_id=n.id AND a.segment=NEW.public_slug AND a.poem_id IS NOT NEW.id
  ) THEN RAISE(ABORT, 'PUBLIC_POEM_ALIAS_OWNED') END;
  UPDATE author_index_cache SET generation=generation+1, dirty=1 WHERE id=1; -- sarj-noqa: SARJ119 — Atomic trigger replacement under one writer lock; bounded metadata runtime, matching-Worker bookmark rollback and postconditions documented above.
  -- A later full-corpus purge can acknowledge only route activations whose
  -- epoch it covered and whose cache generation has not changed meanwhile.
  UPDATE poem SET publication_cache_dirty=1,
    public_route_cache_generation=publication_cache_generation+1,
    public_route_cache_epoch=(SELECT generation FROM author_index_cache WHERE id=1)
    WHERE id=NEW.id;
END;

INSERT OR IGNORE INTO author_index_cache (id,generation,dirty,next_purge_at,bootstrap_generation,public_routes_purged_epoch) VALUES (1,1,1,0,1,0);
