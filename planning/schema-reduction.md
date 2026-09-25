# Saqi schema reduction: two public tables, no local SQLite

25 September 2026. Source baseline: main c94995e5f05ad1b71b3210d2e73446b447f712ea. This document is the cutover contract, not permission to run a destructive production migration without the gates below.

## Recommendation

Keep author and poem as the only application tables in public D1. Source identity, source hash, collection timestamp, the currently visible English tracks and insights, and the current Codex invocation state become columns on those rows. A single local runner executes Codex; it has no SQLite database. It may leave one temporary result file per in-flight invocation so a finished result survives a process crash. It never silently replays an unknown invocation. Collection work comes from author.collected_at and known source URLs; enrichment work comes from poem.source_hash versus poem.publication_source_hash. Stop/start the local process for pause/resume. The existing Cloudflare Access-protected operations Worker is the only D1 mutation boundary.

This removes 16 of 18 current public application tables and all 23 local SQLite tables at the final cutover. The first staged migration only adds columns and removes the three dashboard tables, so the generated intermediate diagram has 15 public and 23 legacy local tables. Do not mistake that intermediate state for completion. The final poem row needs one compact publication JSON document containing every **currently visible** English track, its label/provider, the selected/default key, and poem-level insights. Model artifacts and rejected or superseded versions can go. Whether alternate public selectors can go is a separate product decision after visibility parity; the 26 poems with multiple active model pointers are the minimum known case.

Ranked by practical reduction: (1) replace the 23-table local rig and its roughly 51,560 production source lines with the one-process runner; (2) project current publications and remove the six-table model graph plus selectors; (3) move source identity/hash to canonical rows and remove staged import/revision/clock/writer tables; (4) retire the three dashboard tables and route; (5) remove the 39-row Unicode policy table only with a proven validator. The last two are easy code reductions, but the first two remove most operational failure modes.

### Live evidence and limits

Read-only production D1 audit at 2026-09-25 17:37 UTC: 1,145,155,584 bytes; 1,391 authors; 104,960 poems; 104,658 joined author/poem rows with public flags; zero foreign-key violations. There are 71,791 non-null legacy translation payloads, 3,930 Gemini payloads, 3,234 legacy insight payloads, 8,321 poems with an active model pointer, and 26 with multiple active model pointers. These are storage/pointer counts, not valid rendered-output counts. Live local rig database and a consistent backup were not found on this Mac; every local row/byte count below is unverified. No 2 GB benchmark can honestly be claimed.

Further read-only overlap at 2026-09-25: 2,841 poems have both legacy and Gemini payloads; 586 have legacy plus an active model pointer; 153 have Gemini plus an active model pointer. Valid display counts need the catalog validator. These overlaps make a one-track projection unsafe: the initial `publication_json` reader deliberately falls back to old visible tracks on such poems. Implement the compact multi-track projection before removing any legacy field or model graph reader.

Before/after application footprint: D1 18 tables and 540,818 rows -> 2 tables and 106,351 canonical rows, plus any newly collected rows. The post-migration byte count is unknown until the D1 rebuild/vacuum and publication projection; do not promise a storage percentage. Local SQLite 23 tables -> 0, with present rows/bytes unknown because the installed rig has not been located.

There are 26,049 poems without an established source identity. Inferring one from a poemNNN slug would collide with a different canonical poem 3,968 times; 20 author slug inferences collide as well. Three current source pointers disagree with the poem's active source revision. Two sealed import records lack source identity. The identity backfill therefore copies only established mappings. These cases need explicit reconciliation, never an automatic slug merge.

The additive backfill preflight found zero mapped poems with a null source version and zero authors/poems with multiple established source keys. Its unique indexes and non-null source_version column are therefore compatible with the observed production mappings; rerun this read-only preflight immediately before migration.

## Target schema and paths

author: id primary key, slug unique, Arabic/English names, hidden, source_name + source_author_id unique when present, source_url, collected_at. Keep only display/sort fields that indexed live queries prove necessary.

poem: id primary key, author_id foreign key, slug, Arabic title/content, hidden/publishable, source_name + source_poem_id unique when present, source_url, source_hash, source_version, collected_at; publication_json (tracks array, selected key, insights), publication_source_hash, publication_version, publication_hash; rig_status, rig_version, rig_lease_token, rig_lease_expires_at, rig_checkpoint_json, rig_last_error, rig_updated_at, publication_cache_dirty. The final cleanup may fold publication_json into existing translation/insights columns after output parity; keep one representation, not both. No application-specific third table. Wrangler's own migration ledger remains platform metadata.

Collect: select a known author due by collected_at, fetch source under an origin cooldown in process memory, direct idempotent upsert by (source_name, source_poem_id), update content and hash in one D1 transaction/CAS, advance collected_at. Changed Arabic invalidates the publication hash comparison but does not erase the old visible translation before replacement. New author/poem creation uses stable canonical IDs and checks the source key before creating either row.

Translate: atomically claim one eligible poem, persist attempt ID/input hash/model before starting Codex, run one ephemeral structured Codex call, acknowledge only that attempt, validate line alignment and insight shape, publish with source-hash/version CAS, then purge public cache. An unknown result blocks the single runner; recovery reads its deterministic temporary result file. If no result file exists, a human must explicitly mark/retry the attempt. One manual retry can spend one extra Codex call. Automatic duplicate calls: zero by design. A crash can leave one poem blocked until inspected; it cannot drain or silently replay another poem.

The explicit retry command is node typescript/scripts/rig-lite.mjs retry-unknown POEM_ID ATTEMPT_ID. It checks the current D1 attempt and refuses if the matching local result file can be recovered. Run it only after checking for a still-running Codex process and accepting a possible second charge for that one poem.

Render: during the additive stage, the one-track current publication is shown only for poems without an existing legacy, Gemini, or active model selection; otherwise the existing published tracks win. The final multi-track JSON reader must reproduce each visible selection before deleting the old readers. Restart: read the active poem state in D1; recover the exact result file, wait for a live invocation, or stop at explicit unknown. No local queue.

## 41-table decision matrix

Counts are live D1 counts above; local counts are ? until an installed rig and backup are inspected. Each gate is a required proof before the final drop. Data-loss text describes the worst concrete consequence, not a reason to retain history indefinitely.

| Current table | Rows | Decision and replacement | Loss / worst failure; proof before drop |
|---|---:|---|---|
| author | 1,391 | KEEP CORE, with source fields | Preserve URL/name/count parity and source uniqueness. |
| catalog_unsafe_control | 39 | DROP; shared deterministic Unicode validator and read guard | Unsafe controls might enter display/search; inject every code point through writer tests and smoke render/search. Drop triggers with table. |
| crawl_import_bundle | 78,868 | DROP; transactional direct upsert keyed by source ID/hash | Historical import manifests lost; replay a duplicate and interrupted import without duplicate canonicals. Resolve 847 sealed bundles first. |
| crawl_import_record | 79,766 | DROP; canonical poem content/hash | Staged text lost; reconcile 2 sealed unmapped records, then compare source/canonical counts. |
| enrichment_profile | 18 | DROP; model label on current publication, model config in runner | Past model configuration lost; visible selected label parity for every published poem. |
| insights_collection_month | 2 | DROP; retire /insights | Monthly chart lost; route/sitemap/cache/canary removed. |
| insights_model_count | 2 | DROP; retire /insights | Model count chart lost; trigger and last test reader removed. |
| insights_rollup | 1 | DROP; cheap ad hoc counts if operationally needed | Dashboard totals lost; no public reader left. |
| model_enrichment_artifact | 8,733 | FOLD visible tracks INTO poem.publication_json | Rejected/superseded raw payloads lost; row-by-row all visible line/insight/gloss/label parity and shadow reads. |
| model_enrichment_validation | 17,466 | DROP; deterministic validation before one publication CAS | Historical review decisions lost; reject malformed/refusal outputs in tests and live rehearsal. |
| model_publication_receipt | 6,252 | DROP; publication_hash/version on poem | Receipt history lost; idempotent duplicate publish and cache purge retry proven. |
| poem | 104,960 | KEEP CORE, with current source/publication/invocation fields | Arabic, URL, visibility and selected English/insight parity required. |
| poem_model_publication_pointer | 8,347 | FOLD visible selections INTO poem.publication_json | Pointer history lost; all active selections and selected/default output parity for 8,321 active-pointer poems, especially 26 multi-pointer poems. |
| poem_source_revision | 78,911 | FOLD INTO poem.source_hash/version/content | Old Arabic revisions lost; stale source update CAS and current hash/content parity. |
| scraper_writer_control | 1 | DROP after direct single-writer CAS | Old epoch prevented an expired concurrent writer from promoting stale content; prove only one deployed writer and a stale-worker race against new CAS. |
| source_admission_clock | 75,938 | FOLD INTO poem.collected_at/source_hash | Per-source admission timing lost; idempotent recrawl and due query benchmark. |
| source_author_identity | 1,212 | FOLD INTO author source key | URL aliases/history lost; 20 slug conflicts resolved and all mapped IDs preserved. |
| source_poem_identity | 78,911 | FOLD INTO poem source key | Tombstones/history lost; 3 pointer disagreements and 26,049 unmapped poems handled explicitly. |
| canonical_translation_binding | ? | DROP; one current publication per poem | Old binding choice lost; selected publication parity. |
| checkpoint | ? | FOLD INTO poem.rig_checkpoint_json/current result file | Earlier checkpoint chain lost; interrupted-call rehearsal. |
| checkpoint_attempt_reference | ? | DROP; attempt ID in poem checkpoint | Old references lost; exact-attempt acknowledgement test. |
| fanout_detail_material | ? | DROP; canonical Arabic plus current output | Reusable detail cache lost; fetch/recompute test and latency check. |
| fanout_reusable_enrichment | ? | DROP; publication hash on poem | Cross-poem cached artifacts lost; one new translation test. |
| ledger_profile_availability_count | ? | DROP; indexed query over poem | Counter history lost; real-rig query benchmark. |
| ledger_profile_count | ? | DROP; indexed query over poem | Profile totals lost; real-rig query benchmark. |
| ledger_profile_success_clock | ? | DROP; rig_updated_at or indexed query | Historical success clock lost; real-rig query benchmark. |
| local_schema | ? | DROP with SQLite; supported-version cutoff in installer | Old upgrade chain lost; fresh install and current-version migration rehearsal. |
| local_source_identity | ? | DROP; validated source config | Local alias overrides lost; compare active config with D1 keys. |
| origin_gate | ? | KEEP TEMPORARILY as in-process cooldown; no table | A restarted process may forget cooldown and risk a source ban; verify source rate limits and persist only a tiny file if real bans occur. |
| paid_operation_reconciliation | ? | FOLD INTO poem invocation lifecycle; rename operation terminology | Billing diagnostics lost; unknown-outcome recovery test. |
| poem_identity | ? | DROP; D1 canonical source key | Local mapping lost; 3,968 collision cases must remain separate. |
| runtime_control | ? | DROP; launchd stop/start | DB pause flag lost; atomic process stop/restart rehearsal. |
| runtime_owner | ? | DROP; D1 atomic claim plus one launchd process | Old fencing logs lost; two-runner contention test. |
| runtime_provider_concurrency | ? | DROP; runner concurrency fixed at one | Dynamic throttle lost; prove one Codex child at a time. |
| scheduler_state | ? | DROP; derive next from D1 | Old scheduling position lost; restart order/forward progress test. |
| sol_invocation_attempt | ? | FOLD INTO poem current invocation | Detailed past attempts lost; only current unknown outcome retained. |
| sol_operation | ? | FOLD INTO poem current invocation | Operation history lost; publish CAS and duplicate invocation test. |
| sol_poem_milestone | ? | DROP; publication hash/state on poem | Intermediate milestones lost; completed poem parity. |
| source_author_metadata | ? | FOLD INTO author source fields | Scraper-only metadata lost; collection fixture parity. |
| work_event | ? | DROP; current status/error/timestamps on poem | Debug timeline lost; error visibility and interrupted run test. |
| work_item | ? | DROP; due work derived from author/poem | Queue order/history lost; pending/running/unknown migration and forward progress check. |

## Migration order and exact gates

1. Inventory: query sqlite_master, row counts, foreign_key_check, trigger/FK graph and query plans in production; locate live local state and one consistent backup. Record source DB versions, page_count/page_size, WAL state, orphan rates, and last writes. The missing local rig is a hard evidence gap, not an inferred empty queue.
2. Additive D1: add source/publication/invocation columns and indexes. Migration 0063 copies at most 500 established authors, 500 poems and 500 matching hashes per statement, because [D1 limits a query and batch to 30 seconds](https://developers.cloudflare.com/d1/platform/limits/). After a verified restore point, run `node typescript/scripts/backfill-source-identity.mjs` for read-only pending counts, then `node typescript/scripts/backfill-source-identity.mjs --apply` to resume bounded, idempotent batches. The command stops if progress stalls or pending counts rise; rerunning after a crash is safe. Do not start the new runner yet; old writers do not dual-write these columns. Reconcile three source disagreements and two sealed unmapped records. Measure production write time before any mass update.
3. Projection: freeze all currently visible translations/insights per poem, including selected/default key, labels and glosses, into one JSON column. Write in bounded batches using the current catalog validator. Store source hash and SHA-256 of canonical JSON. Run shadow reads across every currently public translated poem, comparing exact rendered English lines for every selectable track, insight JSON, visible labels and URL. Counts alone cannot pass this gate. Raw overlap counts above are not sufficient; only validator-approved displayed tracks count.
   The new local CLI remains inactive unless SAQI_RIG_ACTIVE=1; do not set that flag before this gate passes, or old poems with null publication_json will enter the queue.
4. Reader/writer cutover: publish poem projection first, switch author-list badges and poem pages, then switch direct source upserts and one local runner. Rehearse one new import, changed Arabic, one Codex translation/publication, cache purge, process kill before dispatch, during dispatch, after result file write, and after D1 commit. Verify no duplicate canonical and no silent Codex replay.
5. Final D1 contraction: remove old readers/writers, triggers and FKs first; copy any remaining current values; rebuild author and poem only if SQLite requires dropping legacy FK columns; then drop 13 remaining non-core tables. Rerun table/FK/visibility parity and EXPLAIN/query latency. Regenerate /docs from final SQL. Never edit an already-applied Wrangler migration.
6. Local retirement: stop service, take SQLite online backup after checkpointing WAL, migrate pending/running/unknown work to canonical D1 fields, verify counts and sample hashes, install the one-process runner, watch forward progress, then archive the old DB and remove 23-table local persistence code. Fresh installations begin at a declared supported-version cutoff rather than carrying every historical local migration.

Dependency order: source identity/history and staged import -> direct canonical source upsert -> remove source tables; artifact/validation/profile/pointer/receipt -> selected poem projection -> remove model graph; /insights and cache tags -> remove rollup triggers -> drop rollup tables; Unicode validator/reader guard -> replace publishability triggers -> drop policy table; local queue/checkpoints/invocation history -> D1 CAS and crash rehearsal -> remove SQLite.

Parity query sketch: for each currently public poem ID, compute Old = current CatalogRepository.getPoemPage plus all poemTranslationTracks and the default selected key; compute New = projection-only reader; require SHA256(JSON.stringify({id, authorSlug, poemUrl, linesArabic, tracks:[{key,englishLines,visibleModel,glosses}], selectedKey, insights})) equality. Persist only hashes and mismatch IDs in the audit report, never full poem payload. Check every ID, not a sample. SQL pre/post: SELECT count(*) FROM author; SELECT count(*) FROM poem; PRAGMA foreign_key_check; SELECT count(*) FROM poem WHERE publication_json IS NOT NULL AND json_valid(publication_json)=0; SELECT count(*) FROM poem WHERE publication_cache_dirty=1; SELECT count(*) FROM poem WHERE rig_status='unknown'. Sample actual URLs, search, all sitemap shards, and screenshots of /docs plus live translated poem pages after deployment.

Concrete user-visible risks: a bad source-key inference merges two different poems; a missing backfill blanks a published translation; stale Arabic gets a translation for another revision; an unknown Codex attempt gets billed twice if replayed; a failed cache purge leaves old English visible for up to the cache TTL; dropping Unicode controls without the validator lets bidi/control text distort rendering or search; deleting a live origin cooldown may trigger source throttling. Each is blocked by the specific gate above.

Release sequence: (A) additive columns, direct projection reader fallback, dashboard retirement and no-local-DB runner behind an inactive endpoint; (B) bounded production backfill and exact shadow parity, source writer dual-write, cache purge rehearsal; (C) activate single runner and direct collection, verify live forward progress; (D) drop model/source/Unicode graphs and local SQLite after backups and final parity. A merge to main does not deploy automatically: deploy.yml is workflow_dispatch on an approved main SHA. Back up D1 with a verified Cloudflare restore point or approved encrypted destination, record the restore identifier and pre-counts; do not copy the corpus into an unapproved temporary directory. Roll back code by redeploying the preceding main SHA; restore D1 to the recorded point only if its writes can be reconciled without discarding new poems. Keep the archived local DB until the new queue progresses and unknown work has been resolved.

Files/features to remove in final contraction: site/src/lib/catalog.ts model-graph SQL and selectors; site/src/lib/poem-translations.ts alternate track logic; site /insights route, insights.ts, its test, cache tag, sitemap URL and canary; operations /api/v2/enrichment-publications and source-admissions compatibility paths once direct endpoints own writes; precedent-node corpus-revision-store.ts and production-resolution-reader.ts old graph; crawler-local persistence, projection, scheduler, fanout, ledger, old CLI flags and migrations; generated site database-schema.json regenerated from final SQL. Search complete repo and workflows at each cutover for test-only versus live references.

Unresolved before destructive production work: location/version/backup of the actual local rig; whether another supported rig exists; production writer topology and old epoch race; count of *valid displayed* legacy/model/Gemini translations and exact selected output hashes; 2 sealed unmapped records; 3 source pointer disagreements; 3,968 poem/20 author slug conflicts; real-D1 migration batch latency and 2 GB local-rig indexed-query latency; current Cloudflare D1 restore location and retention. The proposed design deliberately favors deletion, but none of these facts may be silently assumed away.
