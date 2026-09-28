-- Production has one source namespace (`aldiwan`) and zero name/ID pairing
-- errors. These indexes make the source ID alone the canonical lookup key.
-- DirectSourceRepository reads author by source_author_id and poem by
-- source_poem_id; keep the old compound indexes until every writer cuts over.
CREATE UNIQUE INDEX IF NOT EXISTS author_source_id ON author(source_author_id) -- sarj-noqa: SARJ108,SARJ116 — D1 builds this forward-migration index serially; source ID lookup is a live application read.
  WHERE source_author_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS poem_source_id ON poem(source_poem_id) -- sarj-noqa: SARJ108,SARJ116 — D1 builds this forward-migration index serially; source ID lookup is a live application read.
  WHERE source_poem_id IS NOT NULL;
