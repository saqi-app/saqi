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

The separate automation profile can remain blocked by Cloudflare. Use the site-scoped extension in the normal signed-in Chrome profile instead:

```sh
python3 chrome/saqi-collector/install.py
```

This installs the native bridge and retires the separate-profile launchd collector. In `chrome://extensions`, enable Developer mode and Load unpacked: `chrome/saqi-collector` from this repository. This installation grants source-page access and must be explicitly approved by the browser owner. The extension can read only `https://www.aldiwan.net/*`, manage its dedicated collector tab, and talk to its native bridge. No cookies are copied and no credentials are stored in Chrome.

Once enabled, it checks for the next D1 author every minute and visits poems serially, at least 13 seconds apart. Clicking its toolbar icon starts a check immediately. Disable the extension to stop collection. Closing personal Chrome stops collection; reopening it resumes. Incomplete manifests, challenges and identity conflicts are surfaced explicitly; source keys and pre-fetch hashes prevent duplicate admission and stale updates. A full author is marked collected only after all listed poems are handled.

Collection cycles through source-linked authors already admitted to D1 and updates their metadata and poems. It does not discover the entire author directory. The one-shot manual fallback remains `SAQI_RIG_ACTIVE=1 node typescript/scripts/rig-local.mjs collect author AUTHOR_URL ARABIC_NAME`; it uses a separate browser profile and may require human verification.

## macOS monitor

```sh
python3 macos/SaqiActivityMonitor/install.py
```

The native menu-bar app starts at login and shows translation/collection status, current progress, errors and source verification alerts. It reads launchd and two current-state logs, not a database. Translation controls manage the translator; Chrome's extension switch controls collection. Quit monitor closes the UI while workers continue.

`~/Library/Application Support/Saqi/translate.log` contains the current/last translation task. `collect.log` contains the current personal-Chrome status and heartbeat; an expired active heartbeat is an attention state, not reported as healthy. Source API errors and unknown Codex outcomes remain visible. There are no lifetime counters or append-only diagnostic logs.

## Crash recovery

The invocation marker in D1 prevents unknown Codex outcomes from being silently replayed. Restarting recovers a completed local result or publishes an already acknowledged D1 result. If neither exists, inspect the attempt before explicitly allowing a duplicate call:

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
