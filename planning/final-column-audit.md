# Final column audit — 26 September 2026

Production has 1,392 authors and 104,961 poems. The read-only audit found zero hidden poems, one hidden author, 66 unpublishable poems, and zero stored rig error strings. There are 78,914 non-null poem collection timestamps; these are history, not scheduling input. No invocation was active or unknown at the audit.

The target is 11 author columns and 24 poem columns (39 → 35 total), with no additional tables. `publishable` is the indexed result of validating current Arabic content; it excludes malformed/unsafe poems from counts, search, sitemaps, and the translation queue. Removing it would either expose those 66 poems or make each listing repeatedly parse the corpus. `author.hidden` still excludes a real author. Keep these two narrow visibility behaviors. Poem-level manual hiding has never been used in the installed corpus; retire that feature instead of preserving an empty switch.

| Table | Column | Decision and current behavior |
|---|---|---|
| author | id | KEEP — canonical poem FK and stable source binding |
| author | slug | KEEP — existing public author URLs |
| author | name_arabic | KEEP — visible name and translation input |
| author | name | KEEP — currently displayed English name |
| author | hidden | KEEP — one author is deliberately excluded from site and rig |
| author | sort_name_arabic | KEEP — indexed Arabic ordering for the public index |
| author | source_name | KEEP — source identity namespace |
| author | source_author_id | KEEP — unique idempotent admission key |
| author | source_url | KEEP — next-author collector navigation |
| author | collected_at | KEEP — oldest/uncollected author scheduling and completed-manifest marker |
| author | source_retry_after | KEEP — durable source cooldown; maximum deadline applies to origin |
| poem | id | KEEP — existing poem URL and canonical identity |
| poem | author_id | KEEP — author pages and ownership |
| poem | slug | KEEP — collision guard for legacy poems without source keys; public validity parity |
| poem | verses | KEEP — displayed listing count and current validity constraint |
| poem | name_arabic | KEEP — displayed title, order, translation input |
| poem | name_english | KEEP — selected public English title input |
| poem | content_arabic | KEEP — authoritative Arabic text |
| poem | poem_title_first_line | KEEP — real public title fallback; prior full-corpus audit selected it for 16,408 poems, including 66 invalid nonblank primary titles |
| poem | hidden | DROP — all 104,961 values are zero; abort migration if any changes to nonzero |
| poem | publishable | KEEP — indexed current Arabic validity; 66 rows excluded |
| poem | sort_name_arabic | KEEP — indexed author-page ordering |
| poem | sitemap_shard | KEEP — stable bounded sitemap partition without scanning all poems |
| poem | source_name | KEEP — source identity namespace |
| poem | source_poem_id | KEEP — unique idempotent admission key |
| poem | source_url | DROP — never read by application; collector already supplies and validates URL |
| poem | source_hash | KEEP — source change detection and stale-update CAS |
| poem | collected_at | DROP — no scheduling/reader uses this timestamp; author completion schedules collection |
| poem | publication_json | KEEP — current translations, attribution, word glosses, poem insights |
| poem | publication_source_hash | KEEP — derive due translations and visible stale-source notice |
| poem | publication_hash | KEEP — acknowledge cache purge only for the exact published result |
| poem | publication_cache_dirty | KEEP — recover failed cache purge after successful publication |
| poem | rig_status | KEEP — durable current claim/dispatch/unknown/retry state |
| poem | rig_version | KEEP — reject stale invocation acknowledgements and publication |
| poem | rig_lease_token | KEEP — exclusive claim before Codex dispatch |
| poem | rig_lease_expires_at | KEEP — expire abandoned claims without replaying unknown invocations |
| poem | rig_checkpoint_json | KEEP — current invocation identity/result until publication; cleared on success |
| poem | rig_last_error | DROP — unread duplicate of unknown/retry status, currently empty |
| poem | rig_updated_at | KEEP — deterministic oldest-active recovery ordering |

Deploy readers/writers that omit the four retired columns first. Unchanged source upserts then do no bookkeeping write. Take a fresh private corpus archive, record the D1 Time Travel bookmark and all retained row values, and apply new ledgered migrations; never edit applied migrations. Remove the three partial indexes and two publishability triggers that mention poem.hidden together, recreate their exact definitions without the unused flag, and assert hidden=0 before dropping it. Keep author visibility and the unsafe-Arabic validator intact. Run each large column rewrite as its own migration to bound transaction work; on an ambiguous D1 response inspect the ledger and schema before resuming.

Before/after checks: author/poem/snapshot counts, hash of every retained row/column ordered by canonical ID, zero FK errors, unchanged set of publishable poem IDs, unchanged author visibility, indexed next-task and public-count query plans. Verify generated /docs, author/poem/search/sitemap behavior and a real local publication with English translation, poem insights and word glosses. Roll back the Worker only to the pre-drop-compatible reader release; reverting further requires restoring the matching archived database. Drop-column loss is limited to obsolete poem URL/timestamp diagnostics and the unused poem-level visibility switch; the private archive retains those old values.
