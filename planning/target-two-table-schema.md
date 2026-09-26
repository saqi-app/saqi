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
  source_retry_after INTEGER CHECK (source_retry_after IS NULL OR source_retry_after >= 0),
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
  verses INTEGER NOT NULL CHECK (verses >= 0),
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
  publication_cache_dirty INTEGER NOT NULL DEFAULT 0
    CHECK (publication_cache_dirty IN (0, 1)),
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
  WHERE publication_cache_dirty = 1;
```

`publication_json` holds only currently visible English tracks, their labels and insights in the validated v2 shape. `publication_source_hash` is the source version that output represents; `publication_hash` makes duplicate publication idempotent. `publication_cache_dirty` is the durable cache-purge retry marker. Clear it only with a compare-and-swap against the publication and source hashes that were purged, so a concurrent update cannot lose its pending purge. `rig_checkpoint_json` contains only the current attempt/result, not history. A stale writer must lose the `rig_version` and source-hash compare-and-swap before it can publish. No local queue, audit, model history, month rollup, or counter table remains.

`poem.author_id` stays nullable in this sketch because production has 100 canonical poems with no author row; 73 have a legacy English or insight payload. They currently have no readable author/poem URL, but silently deleting them would fail canonical row parity. Resolve or deliberately archive them before considering `NOT NULL`. Likewise, legacy English titles, Arabic sort keys, `sitemap_shard`, and publishability flags need exact reader parity before their old columns/triggers are replaced. The final target intentionally removes `source_version`, `publication_version`, all three author counters, and old model/source foreign keys; hash/CAS, live counts, and the existing cache-purge bit absorb their core behaviors.

The `verses` field is core until a replacement proves the existing eligibility rule: a 26 September read-only production query found 104,880 of 104,960 stored values differ from `json_array_length(content_arabic, '$.content')`. Do not replace it with a raw line count. The single `title_english` target also needs a validator-aware backfill: 16,564 poems have no nonblank `name_english` but do have `poem_title_first_line`; the site chooses the first *usable* title, excluding generation-failure text. Applying the exact candidate reader's title validator to all 104,960 archived poems selected 55,869 primary titles and 16,408 fallback titles, including 66 with a nonblank but invalid primary; 32,683 had no usable English title. A plain `COALESCE` backfill would therefore preserve invalid primary text for those 66 instead of their displayed title. Keep both current title columns during the reader cutover, then backfill the selected usable title and compare every public page before dropping the fallback column.

A concrete graph-drop candidate is in [migration 0072](../typescript/packages/operations/migrations/0072_drop_obsolete_corpus_tables.sql), promoted to the migration directory after exhaustive parity and the full D1 restore passed; deploy only after the canonical application and fresh archive gates pass. On 26 September it was applied after migrations 0065–0069 to a disposable SQLite copy of the verified full production archive. It removed 64 obsolete graph triggers and 12 history/control/import/identity tables, leaving exactly `author` and `poem`. Every retained column compared equal across all 1,391 authors and 104,960 poems, with integrity `ok` and zero FK errors. This proves SQL/data compatibility in SQLite; D1 timing, active reader/writer cutover, and live end-to-end checks remain required.

The source/revision cycle must be broken by dropping `source_poem_identity.current_revision_id` and its FK, not by merely setting it to NULL. A full-data rehearsal of the latter spent more than 100 CPU seconds checking unindexed foreign keys while dropping revision rows and was stopped; removing the obsolete FK let the complete rehearsal finish in seconds. This candidate deliberately retains canonical payload/title/rig columns: dropping legacy payload fields requires the separate all-public-output parity gate, and simplifying their names can follow the table contraction without holding the 12-table deletion hostage.

Measured local storage after that candidate: 1,306,390,528 bytes before compaction, 734,855,168 bytes on the freelist, and 564,604,928 bytes after SQLite `VACUUM` (about 57% below the restored archive file). The surviving application rows are 106,351. This is a full-corpus SQLite measurement, not a promise that D1 immediately returns freed pages or reports the same physical size; measure production's reported size after its contraction. Legacy canonical payload columns still account for additional removable storage once their snapshot parity gate passes.

`author.source_retry_after` preserves an observed source 429 deadline across collector exits and machine restarts. The source reader takes the maximum deadline for its configured source before allowing either automatic or manual collection requests. The collector admits the stable author key before fetching its manifest so even a first-request 429 has a canonical row to hold the deadline. A later shorter response cannot shorten an existing deadline. A 429 without `Retry-After` waits 15 minutes; explicit waits have a 60-second minimum. This one current timestamp replaces an origin table and requires no local state file.

A second guarded candidate, [migration 0073](../typescript/packages/operations/migrations/0073_drop_duplicate_poem_payloads.sql), removes nine duplicated payload/flag/version columns after the canonical application is deployed. It replaces the insert trigger with only Arabic sort-key maintenance and drops the legacy flag trigger. Empty-database migration replay through 0070 plus both candidates leaves two tables and 28 poem columns, with integrity `ok` and zero FK errors. Full-corpus rehearsal now passes: all retained values in 1,391 authors and 104,960 poems are equal, integrity is `ok`, and FK errors are zero. The actual old reader against the original archive and the canonical reader against the fully contracted copy produce identical output for all 104,860 addressable poems (104,657 public pages), 1,277 author pages, the author index, and 16 sitemap shards. The public-output digest remains `69c4eb38d84f278e4e0ac9bddf77dc4ae99a45d118d5878359bc1ccb4fa9235d`; this comparison took 51 seconds. After `VACUUM`, the copy is 440,090,624 bytes, down from 1,306,390,528 bytes (66.3%). This is SQLite evidence; live D1 restore, latency, and reader/writer release gates remain required. Both English-title inputs stay until their validator-aware backfill is proved.

Non-public/raw payload loss is explicit: 2,827 rows have at least one non-null legacy translation/Gemini/insights field but no canonical publication snapshot. Of these, 73 have no author and 128 have an author but are hidden or unpublishable; the remaining 2,626 contribute no visible legacy output under the actual reader (proved by exhaustive parity). Column contraction removes these raw values from the serving database, including rejected generation output. They remain recoverable from the verified private archive. Reassigning an orphan or unhiding a poem later may therefore require restoring a valid publication from the archive or translating it again. Preserve the canonical Arabic rows; do not add a history table for this non-core payload.

Full-corpus SQLite latency (20 sequential reads, warm local cache, 26 September): the actual indexed next-due query returned one row at median 0.004 ms before and 0.005 ms after contraction (max 0.123/0.299 ms). Live public-author counts returned 1,277 rows at median 88.371 ms before and 61.917 ms after (max 92.589/65.208 ms). These are local measurements on the restored production corpus, not D1 network latency or a nonexistent old 2 GB local rig; remote before/after timing remains a release check.

Publication-version policy: this migration preserves every currently visible track and selector. After a later Arabic change, the old snapshot remains readable with the source-mismatch notice until the rig publishes a new valid Codex result. That publication atomically replaces the whole current snapshot with the new translation and insights; older model alternatives then cease to be current and are not retained as serving history. An unchanged poem whose publication_source_hash matches source_hash is not automatically retranslated. Keep these semantics explicit rather than adding a version table or silently dropping alternatives during schema migration.

Read-only production D1 baseline before contraction: the actual indexed next-due SQL took 1.4462 ms and read two rows. The actual CatalogRepository author-index SQL returned 1,277 rows in 269.1977 ms (323,286 rows read, including the existing Unicode/visibility validation). An explicit hint for the already-selected covering index returned the identical ordered-result SHA-256 (`4b74cd9e01bb61f738a0eb9d63693bcc8d685b401eb1aa9b232f763904adde74`) in 182.1003 ms with identical rows read; no hint or extra index was added because this was not evidence of a different plan. A separate grouped-count benchmark took 5,361.9063 ms but is not the site query and should not replace the indexed correlated counts. All measurements wrote zero rows.

The full private-archive D1 restore gate passed on 26 September at approximately 18:52 UTC. Disposable database `saqi-restore-rehearsal-7f810d6b7f2d` completed all 170 import steps, including five oversized bound rows, then exported successfully. Its full schema, every row/column in all 15 application tables and the 70-row migration ledger, integrity check, and foreign keys matched the verified archive. It was deleted successfully. A fresh production export at 18:40 UTC was exactly 1,155,639,050 bytes with the same SQL SHA-256, `bfbeab9248d55c723616a542add217d20b09ee68ff25a87e02ca05a6d609eab0`, proving the earlier private archive still contains the current database despite a changed Time Travel bookmark. This satisfies restore recoverability; it does not itself activate readers or writers. PR #134 also adds a real runner-process kill before acknowledgement, proving restart publishes the saved result with exactly one simulated Codex invocation; the live invocation rehearsal remains separate.

The original 0071/0072 contraction never applied: D1 returned internal error 7500 twice and live inspection confirmed all 14 tables and schema 0070. Split those unapplied files into 0071 FK/guard detachment, 0072 graph drops, and 0073 duplicate-column removal. Each phase is independently ledgered and the canonical-only application supports every intermediate state. An empty D1 accepted the original SQL, establishing that the failure was data-dependent; the smaller transactions are a mitigation to verify on live D1, not a claimed platform root cause.
