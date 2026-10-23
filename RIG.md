# Operations

D1 holds the corpus, paid-call checkpoints, publications and persistent URL reservations. Preserve all six tables, result files and invocation fences during recovery.

## Translation

The `saqi-codex` VM runs 80 GPT-6.1 Sol xhigh Standard workers:

```sh
gcloud compute ssh saqi-codex --project=sarj-nasr-dev --zone=us-east1-b --tunnel-through-iap
sudo systemctl status saqi-translate-standard.service
sudo journalctl -u saqi-translate-standard.service -n 30 --no-pager
```

Stop with `sudo systemctl disable --now saqi-translate-standard.service`; it drains active calls. Wait before changing the checkout, login or VM. The [startup script](typescript/scripts/rig-vm/startup.sh) provisions new hosts.

Keep `/home/saqi/.config/saqi/access.env` and `/home/saqi/.codex/auth.json` private. Preserve `/home/saqi/.local/state/saqi/results-standard`. The quota watcher resumes only services it paused; disabling the pool cancels that intent.

For staged device login, place mode-0600 `pending-codex-auth.json` and `pending-codex-login.env` in `/home/saqi/.config/saqi/`, with `SAQI_CODEX_LOGIN_EMAIL` identifying the expected account. Start `saqi-codex-login.service` after draining.

## Status and recovery

Authenticated reads at `https://ops.saqi.app`:

- `/api/rig/state?diagnostics=1`: active slots and expired dispatches.
- `/api/rig/state?poemId=ID&publication=1`: saved publication and public-page comparison.
- `/api/public-routes`: allocation and cache status.

[Count translated poems](.github/workflows/corpus-totals.yml) reports partial English and complete rig publications separately. VM health and quota logs use `saqi-translation-health.service` and `saqi-translation-quota.service`.

An expired lease does not prove a paid call stopped. Confirm completion and review saved output before recovery. With Access credentials loaded, run on the machine holding the result:

```sh
node typescript/scripts/rig-lite.ts recover-attempt ATTEMPT_ID
```

A `.pending` fence requires explicit review and `--accept-incomplete`. Recovery never invokes a model. `retry-unknown POEM_ID ATTEMPT_ID` permits another paid call; use it only after resolving the prior outcome.

## Chrome collector

Build dependencies with `yarn build:api` and `yarn workspace @saqi/source-collector build` from `typescript`. Put `SAQI_SOURCE_NAME` and `SAQI_SOURCE_BASE_URL` in sibling `../private/source.env`, mode 0600. Keep the configured namespace stable.

```sh
python3 typescript/scripts/rig-chrome-install.py install
python3 typescript/scripts/rig-chrome-install.py doctor
python3 macos/SaqiActivityMonitor/install.py
```

Load the generated extension path printed by the installer in `chrome://extensions`. The bridge uses Keychain account `saqi-publication-access-v2`. Reload after updates and verify recent bridge contact in the popup.

Use **Start**, **Pause**, **Retry** and **Collect this author** in the popup. Complete source challenges in its collector tab. Closing Chrome stops collection. Uninstall with the installer’s `uninstall` command, then remove the extension.

The optional Mac translator is controlled by the monitor. Keep it stopped while the VM pool runs.

## Deployment

Run [Deploy to Cloudflare](.github/workflows/deploy.yml) with the reviewed full `main` SHA. It verifies both Workers, records a D1 Time Travel bookmark, applies the current schema baseline, deploys and checks public routes.

Preserve aliases and tombstones. After recovery, verify publications, foreign keys, route reservations and public pages before restarting writers. Restore D1 with `yarn wrangler d1 time-travel restore saqi-db --bookmark BOOKMARK` from `typescript/packages/operations`, with writers stopped and later publications preserved.
