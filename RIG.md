# Saqi rig

Production D1 is the only queue: two application tables, author and poem. There is no local SQLite, scheduler database, event ledger, or model registry. Current translations and word meanings publish atomically on the poem row.

## Background translation

From `typescript`, install dependencies and run `yarn build:api` and `yarn workspace @saqi/source-collector build`. From the repository root:

```sh
python3 typescript/scripts/rig-background.py install
python3 typescript/scripts/rig-background.py status
python3 typescript/scripts/rig-background.py stop
```

launchd runs one translation task every 30 seconds, never overlapping itself. Long tasks finish before another starts. New calls use GPT-6 Sol at medium reasoning. Before claiming a new poem, the rig reads Codex quota and waits when any reported window has 80% or more used, or quota cannot be verified; recovery and publication of an existing result still proceed. This preserves a practical 20% admission reserve, although an in-flight call or other Codex use can cross the threshold. The job resumes at login; the Mac must be awake and signed in. Stop removes its login entry and terminates the current task. Do not run manual copies alongside it. One-off command: `SAQI_RIG_ACTIVE=1 node typescript/scripts/rig-local.mjs translate [POEM_ID]`.

Credentials remain in this Mac's Keychain under account `saqi-publication-access-v2`. Other machines can provide `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` through their secret manager. Never put credentials in arguments or Git. One unfinished invocation may leave a private result in `~/Library/Application Support/Saqi/results`; it is deleted after acknowledgement. Results written to the old temporary location remain recoverable.

## Collection in personal Chrome

The personal Chrome extension uses one dedicated source tab, one native bridge and D1's existing author/poem rows. There is no browser queue, local SQLite, copied cookie profile or separate collection daemon. This release supports one collector Mac and standard Google Chrome 120 or newer. A kernel lock prevents two Chrome profiles from collecting simultaneously.

After the build commands above, run from the repository root:

```sh
python3 typescript/scripts/rig-chrome-install.py install
python3 typescript/scripts/rig-chrome-install.py doctor
```

Installation verifies Node 24+, the built parser, native protocol, Keychain credentials and read-only Operations access before replacing the registration. It preserves translation and existing collection status. If the checkout moves or the Node runtime changes, rerun installation. After updating extension source, reload it in Chrome.

In your personal Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `typescript/chrome/saqi-collector` from this repository. This browser permission step is manual. Open the Saqi popup and choose **Start collection**. Installation alone does not prove Chrome is connected: the popup must show recent bridge contact. No credentials are stored in Chrome, and source access remains limited to `https://www.aldiwan.net/*`.

The popup shows the current author, checked/added/updated/unchanged/review counts, connection time, actual progress time and recovery action. **Pause** prevents further source navigation; an already submitted write may finish. Pause survives Chrome restart. **Open collector tab** reveals the source page. On verification, the collector stops navigating until you finish the check and choose **Retry**. Source cooldowns cannot be overridden by Retry. Network failures retry after 1, 2 and 5 minutes, then require action.

Collection checks for unfinished D1 authors every minute, then continues directly to the next author on the same tab. Source navigations remain at least 13 seconds apart. Closing Chrome stops it; reopening resumes the saved setting. Manifest reconciliation skips poems already stored under the same author with validated source identity, including after a crash. Canonical keys and pre-fetch hashes make submitted writes safe to replay, and collection does not invoke Codex. Incomplete content or missing independent counts stop collection rather than replacing a poem with partial text.

An author with `collected_at` is treated as finished and is never revisited automatically. Historical values copied from the old source identity sometimes mean “last observed” rather than “full manifest completed”; this one-time cutover deliberately treats those existing authors as complete, so previously unseen poems under them may be omitted. Use **Collect this author** to admit a new author; the rig does not scan the author directory after it finishes its current work.

On a source author page, **Collect this author** previews the actual Arabic name and URL, validates the complete manifest and admits the author directly to D1. It preserves the current collection setting and never interrupts another author. An author already marked complete is not revisited automatically; discovering the entire author directory is outside this release.

Identity conflicts are never auto-merged. They count as checked but **need review**, not imported. The popup preserves the latest affected author's warning and up to 20 example poem IDs until dismissed. This is bounded current diagnostic evidence, not an exhaustive historical issue list.

To remove only the bridge:

```sh
python3 typescript/scripts/rig-chrome-install.py uninstall
```

Then remove the extension manually in Chrome. This preserves Keychain credentials, translation startup, unfinished translation results and corpus data. The personal-Chrome extension is the supported collector; there is no separate browser-profile collector.

## macOS monitor

```sh
python3 macos/SaqiActivityMonitor/install.py
```

The native menu-bar app starts at login and shows translation/collection status, current progress, errors and source verification alerts. It reads launchd, the translation log and a bounded collector status snapshot. Translation controls manage the translator; the Chrome popup controls collection. Quit monitor closes the UI while workers continue. Monitor upgrades compile and sign the replacement before stopping the working app.

`~/Library/Application Support/Saqi/translate.log` contains the current/last translation task. `collector-status.json` contains the current personal-Chrome state, connection/progress times and latest review warning. It is atomically replaced and capped at 64 KiB. Contact older than 150 seconds means disconnected, even when the last state was idle or paused. Heartbeats never advance progress time. `collector.lock` holds a kernel lock, not work state; a leftover file after a crash does not block restart. Source API errors and unknown Codex outcomes remain visible. There are no lifetime counters or append-only diagnostic logs.

## Crash recovery

The invocation marker in D1 prevents unknown Codex outcomes from being silently replayed. Restarting recovers a completed local result or publishes an already acknowledged D1 result. An unresolved poem stays marked `unknown` with its attempt ID while other poems continue. Inspect that attempt before explicitly allowing a duplicate call:

```sh
node typescript/scripts/rig-local.mjs translate retry-unknown POEM_ID ATTEMPT_ID
```

Known completed results that fail publication validation are marked `blocked` with their checkpoint retained; other poems continue. Review those rows with `SELECT id FROM poem WHERE rig_status = 'blocked'`. Generation constrains each line's exact word count before publication.

A manual retry can duplicate one call if it completed without a recoverable result. Automatic background checks never make that decision. Do not delete an unresolved invocation's result file.

## Recovery

Stop writers before database recovery and preserve any subsequent publications. The verified private pre-column-drop backup is `saqi-corpus-archive/d1/2026-09-26T22-01-42Z-5a40fbd75e02494b8d4e117d9e5f0c9e/manifest.json`. It has six checksum-verified compressed parts, 1,392 authors, 104,961 poems and 77,742 snapshots. Later background publications must be reconciled before restoring it. Create a fresh backup with `python3 typescript/scripts/archive-production-d1.py --execute` while writers are stopped.

Each migration deployment records a fresh D1 Time Travel bookmark in the **Record the D1 rollback bookmark** job step. Stop the collector and translator and reconcile any later writes before restoring that bookmark. From `typescript/packages/operations`:

```sh
yarn wrangler d1 time-travel restore saqi-db --bookmark BOOKMARK_FROM_DEPLOY_LOG
```

Prefer a forward fix. After restoring the D1 bookmark, redeploy the matching pre-migration Operations and public Worker versions from the previous successful deployment; do not run code against a mismatched schema. Inspect the migration ledger after any ambiguous timeout; never assume an error means rollback. Before restarting, verify author/poem/publication counts, retained source/publication hashes, FK checks and public poem URLs. For a durable archive restore, use the checked-in `rehearse-production-d1-restore.py` and `rehearse-production-d1-import.py` helpers; oversized payloads require bound imports.
