# Saqi rig

The Operations API is a plain Cloudflare Worker with three endpoints; it has no Next.js server, React dashboard, or static asset build.

The rig has no local database, queue, event log, scheduler, or model registry. The Operations Worker derives the next task from production `author` and `poem` rows. Source keys prevent duplicate imports; source hashes and compare-and-swap writes reject stale updates.

## Run one task

From `typescript`, after installing dependencies and running `yarn build:api`:

```sh
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs collect next-author
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs translate
```

Collection visits one author's manifest, upserts each poem, then advances that author's collection timestamp. Translation claims one eligible poem, calls Codex once, saves the validated result to D1, and publishes it. Each command exits after its task. For continuous operation, install the two small launchd jobs below.

This Mac's wrapper loads the existing Cloudflare Access credential from Keychain. Other computers can supply `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` through their secret manager. Never put credentials in the repository or command arguments.

To collect a particular author or translate a particular canonical poem:

```sh
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs collect author AUTHOR_URL ARABIC_NAME
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs translate POEM_ID
```

Complete source verification in the collector's visible Chrome window when requested. It waits up to 15 minutes. Source requests are serial, spaced by at least 13 seconds; a source rate-limit deadline persists in D1 and survives process restarts.

## Use your regular Chrome session

For collection assisted by this coding agent, use the connected regular Chrome browser. On this Mac it loaded the source author and poem immediately where the separate automation profile remained challenged. Read the visible complete author manifest and poem text, validate them with `parseAuthorPoemManifest` and `parsePoemDetail`, then use the existing `/api/rig/source` endpoint with source keys and expected hashes. Respect the persisted source cooldown and serial pacing; mark the author collected only after the complete manifest succeeds. Temporary page projections can be deleted after D1 accepts them.

This path needs no dedicated browser profile or cookie copy. The standalone `collect` CLI still launches its own separate Chrome profile; it does not attach to an already-running personal Chrome session. Prefer the agent-assisted regular-browser path when the standalone collector repeatedly encounters source verification. Translation remains the same one-shot CLI command.

## Restart after a crash

Run the same translation command again. A durable invocation marker on the poem prevents an unknown Codex outcome from being silently dispatched again. If the completed result file still exists, the rig acknowledges and publishes that same result. Acknowledged results are already in D1 and can be published after a restart.

If the outcome is unknown and no result can be recovered, the rig stops. Inspect the reported poem and attempt before explicitly allowing another call:

```sh
node scripts/rig-local.mjs translate retry-unknown POEM_ID ATTEMPT_ID
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs translate
```

That manual retry can duplicate one Codex call if the previous invocation completed without a recoverable result. Automatic retries do not accept that tradeoff. Do not delete a result file while its invocation is unresolved.

## Local files

Only the browser profile, Keychain credential, and one temporary JSON result per unfinished Codex invocation are needed. Published result files are deleted. Losing the temporary result after an unacknowledged completion loses that intermediate result, but D1 retains the unknown invocation and blocks automatic replay. A new computer can resume all acknowledged work from D1.

Production uses migrations through 0079: author (11 columns) and poem (24 columns). Historical planning and parity evidence remain available in Git history before the planning-folder removal. Public translations and poem insights are part of the preserved publication; retired dashboard analytics are separate.

Each translation invocation now generates the full English translation, poem insights, and an English meaning for every Arabic word. The server reconstructs gloss segments from the original Arabic and rejects missing/extra meanings; Codex cannot change the Arabic spelling or punctuation. All three outputs publish atomically in `poem.publication_json`. Build shared contracts with `yarn build:api` before running the local command.

## Continuous background operation on this Mac

From the repository root after `yarn build:api` in `typescript`:

```sh
python3 typescript/scripts/rig-background.py install
python3 typescript/scripts/rig-background.py status
# Stop both jobs and remove their login startup entries:
python3 typescript/scripts/rig-background.py stop
```

The translator checks every 30 seconds and the collector every five minutes. launchd never overlaps a job with itself; long tasks continue to completion. The jobs resume at login and after task exits, while D1 remains the only queue. Do not simultaneously start manual copies. An unknown Codex outcome still blocks automatic replay and requires inspection. The computer must be awake and signed in; sleep pauses progress.

Credentials stay in Keychain. `~/Library/Application Support/Saqi/translate.log` and `collect.log` contain only the current/last run, and `source-browser/` holds the collector's persistent browser session. The collector cycles through source-linked authors in D1, upserts author metadata and imports their poem manifests. It does not discover an entire new source author directory; admit a new author's URL with the explicit collect-author command. Source Cloudflare verification can still pause collection; it does not block the separate translator.

## macOS menu-bar monitor

Run `python3 macos/SaqiActivityMonitor/install.py` from the repository root. This builds a native menu-bar app with translation/collection state, recent task output, source verification alerts, start/stop controls and log access. It starts at login and reads launchd plus the two current-run logs; it has no database and never reads credentials. Quit monitor closes the UI; the rig jobs continue independently.

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
