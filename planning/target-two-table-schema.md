# Final two-table schema sketch

This is a design target, **not an executable migration**. Preserve current URLs and output through the reader/writer gates in [schema-reduction.md](schema-reduction.md), then rebuild the tables from verified canonical rows. D1's own migration ledger is platform metadata. The local runner has no SQLite schema; only an exact in-flight Codex result file may exist until acknowledgement.

```sql
CREATE TABLE author (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_arabic TEXT NOT NULL,
  name_english TEXT,
  sort_name_arabic TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  source_name TEXT,
  source_author_id TEXT,
  source_url TEXT,
  collected_at INTEGER,
  CHECK ((source_name IS NULL) = (source_author_id IS NULL))
);
CREATE UNIQUE INDEX author_source_key ON author(source_name, source_author_id)
  WHERE source_name IS NOT NULL;

CREATE TABLE poem (
  id TEXT PRIMARY KEY,
  author_id TEXT REFERENCES author(id) ON DELETE SET NULL,
  slug TEXT NOT NULL UNIQUE,
  title_arabic TEXT NOT NULL,
  title_english TEXT,
  sort_title_arabic TEXT NOT NULL,
  content_arabic TEXT NOT NULL CHECK (json_valid(content_arabic)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  publishable INTEGER NOT NULL DEFAULT 0 CHECK (publishable IN (0, 1)),
  sitemap_shard INTEGER NOT NULL CHECK (sitemap_shard BETWEEN 0 AND 15),
  source_name TEXT,
  source_poem_id TEXT,
  source_url TEXT,
  source_hash TEXT CHECK (source_hash IS NULL OR length(source_hash) = 64),
  publication_json TEXT CHECK (publication_json IS NULL OR json_valid(publication_json)),
  publication_source_hash TEXT,
  publication_hash TEXT,
  cache_purged_hash TEXT,
  rig_status TEXT CHECK (rig_status IS NULL OR rig_status IN
    ('claimed', 'dispatching', 'unknown', 'retry', 'blocked', 'complete')),
  rig_version INTEGER NOT NULL DEFAULT 0 CHECK (rig_version >= 0),
  rig_lease_token TEXT,
  rig_lease_expires_at INTEGER,
  rig_checkpoint_json TEXT CHECK (rig_checkpoint_json IS NULL OR
    (json_valid(rig_checkpoint_json) AND
     length(CAST(rig_checkpoint_json AS BLOB)) <= 1048576)),
  rig_last_error TEXT,
  rig_updated_at INTEGER,
  CHECK ((source_name IS NULL) = (source_poem_id IS NULL))
);
CREATE UNIQUE INDEX poem_source_key ON poem(source_name, source_poem_id)
  WHERE source_name IS NOT NULL;
CREATE INDEX poem_public_author_order
  ON poem(author_id, sort_title_arabic, id)
  WHERE hidden = 0 AND publishable = 1;
CREATE INDEX poem_public_sitemap ON poem(sitemap_shard, id)
  WHERE hidden = 0 AND publishable = 1;
CREATE INDEX poem_enrichment_due ON poem(id)
  WHERE hidden = 0 AND publishable = 1 AND source_hash IS NOT NULL
    AND (publication_source_hash IS NULL OR publication_source_hash <> source_hash);
CREATE INDEX poem_active_attempt ON poem(rig_status, rig_updated_at, id)
  WHERE rig_status IN ('claimed', 'dispatching', 'unknown');
CREATE INDEX poem_rig_retry ON poem(id)
  WHERE rig_status = 'retry';
CREATE INDEX poem_cache_purge_due ON poem(id)
  WHERE publication_hash IS NOT cache_purged_hash;
```

`publication_json` holds only currently visible English tracks, their labels and insights in the validated v2 shape. `publication_source_hash` is the source version that output represents; `publication_hash` makes duplicate publication idempotent. A mismatched `cache_purged_hash` is the durable cache-purge retry marker, replacing a separate dirty bit. `rig_checkpoint_json` contains only the current attempt/result, not history. A stale writer must lose the `rig_version` and source-hash compare-and-swap before it can publish. No local queue, audit, model history, month rollup, or counter table remains.

`poem.author_id` stays nullable in this sketch because production has 100 canonical poems with no author row; 73 have a legacy English or insight payload. They currently have no readable author/poem URL, but silently deleting them would fail canonical row parity. Resolve or deliberately archive them before considering `NOT NULL`. Likewise, legacy English titles, Arabic sort keys, `sitemap_shard`, and publishability flags need exact reader parity before their old columns/triggers are replaced. The final target intentionally removes `source_version`, `publication_version`, `publication_cache_dirty`, all three author counters, and old model/source foreign keys; hash/CAS, live counts, and one cache-purge hash absorb their core behaviors.
