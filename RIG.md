# Saqi rig

Production D1 is the only queue: two application tables, author and poem. There is no local SQLite, scheduler database, event ledger, or model registry. Current translations, poem insights and word meanings publish atomically on the poem row.

## Background translation

From `typescript`, install dependencies and run `yarn build:api` and `yarn workspace @saqi/source-collector build`. From the repository root:

```sh
python3 typescript/scripts/rig-background.py install
python3 typescript/scripts/rig-background.py status
python3 typescript/scripts/rig-background.py stop
```

launchd runs one translation task every 30 seconds, never overlapping itself. Long tasks finish before another starts. The job resumes at login; the Mac must be awake and signed in. Stop removes its login entry and terminates the current task. Do not run manual copies alongside it. One-off command: `SAQI_RIG_ACTIVE=1 node typescript/scripts/rig-local.mjs translate [POEM_ID]`.

Credentials remain in this Mac's Keychain under account `saqi-publication-access-v2`. Other machines can provide `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` through their secret manager. Never put credentials in arguments or Git. The only translation output file is one temporary JSON result per unfinished invocation; it is deleted after publication.

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

Collection checks for D1 work every minute and visits source pages at least 13 seconds apart. Closing Chrome stops it; reopening resumes the saved setting. A crash refetches the unfinished author from its beginning: up to 13 seconds per previously visited page plus load/API time. Canonical keys and pre-fetch hashes make those replays safe, and they do not invoke Codex. Incomplete content or missing independent counts stop collection rather than replacing a poem with partial text.

On a source author page, **Collect this author** previews the actual Arabic name and URL, validates the complete manifest and admits the author directly to D1. It preserves the current collection setting and never interrupts another author. Existing source-linked authors are revisited automatically; discovering the entire author directory is outside this release.

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

From `typescript/packages/operations`, the pre-drop-compatible rollback versions are:

```sh
yarn wrangler rollback 1de00fbf-5ea0-421a-9a54-6adcb2657bf1 --name saqi-ops --yes
yarn wrangler rollback 39ad654f-da26-4b03-a615-1fe3fbd719a1 --name saqi-public --yes
yarn wrangler rollback edf5dd91-8d7d-4117-8e56-96a2de2f8d1b --name saqi-www --yes
# Only after preserving/reconciling later writes, within Time Travel retention:
yarn wrangler d1 time-travel restore saqi-db --bookmark 0000298d-0000031b-000050f2-f9376334f5c147cda32075fa7afce5bd
```

Prefer a forward fix. Do not roll back to code that reads removed columns. Inspect the migration ledger after any ambiguous timeout; never assume an error means rollback. Before restarting, verify author/poem/publication counts, retained source/publication hashes, FK checks and public poem URLs. For a durable archive restore, use the checked-in `rehearse-production-d1-restore.py` and `rehearse-production-d1-import.py` helpers; oversized payloads require bound imports.
