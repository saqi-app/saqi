# Saqi rig

The rig has no local database, queue, event log, scheduler, or model registry. The Operations Worker derives the next task from production `author` and `poem` rows. Source keys prevent duplicate imports; source hashes and compare-and-swap writes reject stale updates.

## Run one task

From `typescript`, after installing dependencies and running `yarn build:api`:

```sh
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs collect next-author
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs translate
```

Collection visits one author's manifest, upserts each poem, then advances that author's collection timestamp. Translation claims one eligible poem, calls Codex once, saves the validated result to D1, and publishes it. Each command exits after its task. Stopping the process pauses work; no service is installed automatically.

This Mac's wrapper loads the existing Cloudflare Access credential from Keychain. Other computers can supply `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` through their secret manager. Never put credentials in the repository or command arguments.

To collect a particular author or translate a particular canonical poem:

```sh
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs collect author AUTHOR_URL ARABIC_NAME
SAQI_RIG_ACTIVE=1 node scripts/rig-local.mjs translate POEM_ID
```

Complete source verification in the collector's visible Chrome window when requested. It waits up to 15 minutes. Source requests are serial, spaced by at least 13 seconds; a source rate-limit deadline persists in D1 and survives process restarts.

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

Production migrations, backups, exact parity evidence, and rollback steps are recorded in [the schema reduction plan](planning/schema-reduction.md). Public translations and poem insights are part of the preserved publication; retired dashboard analytics are separate.
