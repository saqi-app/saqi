# Saqi Codex VM

Provisioned 2026-10-06 in `sarj-nasr-dev`: `saqi-codex`, zone `us-east1-b`, e2-micro (2 burstable vCPUs, 0.25 sustained CPU, 1 GiB RAM), 20 GiB standard disk, Ubuntu 24.04, and 2 GiB swap. It has an ephemeral external IPv4 address for outbound access and no GCP service account. The `saqi-us-east1` subnet belongs to `nasr-dev-private`. No public application ports are open. The original Dammam VM and its 20 GiB balanced boot disk were permanently deleted on 2026-10-06 after replacement verification and explicit approval; they incur no further compute or disk charges. `saqi-codex-iap-ssh` allows TCP 22 only from Google IAP to the `saqi-codex` network tag. Atuin is a separate VM.

Codex CLI 0.159.3 and Node 24.21.0 are installed. The dedicated `saqi` Unix account uses GPT-6.1 Sol, xhigh reasoning, Standard speed, and ChatGPT login. The initial login was copied securely over IAP SSH from the existing authenticated device; credentials are private files, never metadata or source files. For a separate device session, use the device login command below. The translation job has no quota reserve or local spending cap. It consumes included allowance and available account credits until Codex rejects further usage.

## Connect and authenticate

```sh
gcloud compute ssh saqi-codex --project=sarj-nasr-dev --zone=us-east1-b --tunnel-through-iap
sudo -iu saqi
codex login status
# Stop scheduling and let the current translation finish before replacing this login.
# To create a fresh headless device session:
codex login --device-auth
# To keep a manual Codex session alive after SSH disconnects:
cd /home/saqi/work/saqi
tmux new -A -s codex
codex -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"'
```

Enable device login in ChatGPT security settings if required. Follow the browser link and enter the one-time code. Codex refreshes the cached session during use. The VM's minimal translator directory contains the rig entrypoints, output schema, compiled word-gloss contracts, and Zod 4.6.5. It is not a full development checkout.

## Background job

The [pool service](typescript/scripts/rig-vm/saqi-translate-pool.service) runs twenty independent poem workers through one shared Codex app-server process. Every new thread explicitly uses GPT-6.1 Sol, xhigh reasoning, Standard speed, a focused translation instruction set, and disabled tools. D1 atomically limits concurrent claims to twenty distinct poems, including any remaining legacy invocation. Each worker waits five seconds after an invocation and owns a private recovery ticket. Paid results are saved atomically before acknowledgement; ambiguous outcomes stay fenced rather than being regenerated. The older [single-invocation service](typescript/scripts/rig-vm/saqi-translate.service) and [timer](typescript/scripts/rig-vm/saqi-translate.timer) remain available for recovery but the timer is disabled during pool operation. D1 remains the queue. Pending result files live in `/home/saqi/.local/state/saqi/results`; do not delete an unresolved attempt's file.

The service loads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from the private mode-0600 file `/home/saqi/.config/saqi/access.env`. Login is in `/home/saqi/.codex/auth.json`, mode 0600. These files are outside the runtime code directory. Never copy their contents into chat, source control, instance metadata, or command arguments.

```sh
# These commands run on the VM:
# Disable legacy scheduling before starting the pool; let its in-flight poem finish.
sudo systemctl disable --now saqi-translate.timer
sudo systemctl enable --now saqi-translate-pool.service
sudo systemctl status saqi-translate-pool.service
sudo journalctl -u saqi-translate-pool.service -f
# Stop scheduling new work; let the current invocation finish:
sudo systemctl disable --now saqi-translate-pool.service
# Pool SIGTERM drains active translations before exiting; stop can take a while.
```

The [device-login activation service](typescript/scripts/rig-vm/saqi-codex-login.service) drains the pool and waits for any legacy in-flight translation before atomically installing a newly authorized login. It runs under systemd and survives SSH disconnects. Without a pending login, the service is skipped so an intentionally stopped pool stays stopped after reboot. The private staging files are `/home/saqi/.config/saqi/pending-codex-auth.json` and `pending-codex-login.env` (the latter sets `SAQI_CODEX_LOGIN_EMAIL` to the expected account); both must be mode 0600. A mismatched account leaves the existing login intact. The pool resumes when activation exits, and an unfinished activation is retried after reboot. Credentials never enter Git.

The [health timer](typescript/scripts/rig-vm/saqi-translation-health.timer) checks every 20 minutes without making model calls. Its reports count unique published poems and Arabic lines, show generation/publication latency and the current poem's elapsed time, and flag service failures, unexpected timer pauses, or invocations longer than 60 minutes. A login handoff is reported as maintenance. Pool reports include every active poem, worker number, model, reasoning effort, and elapsed time. Codex completion logs also record first-output delay, output bytes, completed response count, retry/error notifications, and token usage without generated text. One completed generation per twenty-minute window is retained privately as `quality-sample-<window>.json` in the result directory for semantic spot checks; confirm its poem is `complete` before counting it as published. Samples do not enter journals or Git. An authenticated `GET /api/rig/state?poemId=<id>&publication=1` also reads the persisted publication snapshot and cache-purge flag, then checks the deployed public Worker through its service binding for every current English line and word meaning. This catches stale or missing public content without a Bot Fight Mode challenge. These are operational reports in journald; they do not send chat notifications or automatically replay a generation. Inspect a long-running attempt before retrying it.

```sh
sudo systemctl enable --now saqi-translation-health.timer
sudo journalctl -u saqi-translation-health.service -n 20 --no-pager
```

Disable the Mac translation LaunchAgent before enabling the VM job so the Mac cannot resume a second translator at login. Collection in personal Chrome is independent and can continue.

The pool is enabled, the legacy timer is disabled, and the Mac translation LaunchAgent is disabled. A real four-line poem was generated and published on 2026-10-06 with GPT-6.1 Sol High, Standard speed; D1 independently reported `complete`, version 4, with its checkpoint cleared. The deployment write canary passed and the retained cache-purge backlog was drained.

The initial production 503 came from serializing a complete pending-purge database row, including publication/source hashes, into a strict public API request. `purgePublishedPoem` now sends only `authorSlug` and `poemId`; the regression test uses a repository-shaped row and the shared public contract. Known cache errors retain bounded status/details, and every production deployment now tests the authenticated purge write path. Cloudflare deployments use the protected GitHub production workflow because the current local CLI account cannot access Saqi's resources. Unknown older invocations remain fenced and do not prevent new poems from running.

## Capacity estimate

The measurements below used high reasoning before the xhigh change; they do not estimate xhigh consumption or latency. Synthetic benchmarks on this VM used the real rig prompt and output schema, GPT-6.1 Sol High, Standard speed, translation plus per-word meanings, and no production writes. Both line counts and word counts validated. The synthetic text was original, simple modern Arabic; it is not a sample of the live classical corpus.

| Arabic lines      | Input tokens | Output tokens | Reasoning token breakdown | Generation seconds | Estimated credits |
| ----------------- | -----------: | ------------: | ------------------------: | -----------------: | ----------------: |
| 4                 |       10,249 |           293 |                       143 |              15.08 |             0.586 |
| 20                |       10,964 |         1,012 |                       149 |              25.27 |             0.801 |
| 20, repeated test |       10,964 |         1,120 |                       262 |              27.90 |             0.828 |

The first live four-line poem additionally used 10,344 input tokens, 1,193 output tokens (including a 1,034-token reasoning breakdown), zero cached input, and about 51 seconds for generation. Estimated consumption was 0.815 credits, roughly 73,600 equally sized calls from 60,000 credits; this single poem is not a corpus average.

All three synthetic benchmarks reported zero cached input. At the published Standard rate, estimated credits are `(50 * uncached input + 2.5 * cached input + 250 * output) / 1,000,000`. Reasoning is part of billed output; do not charge its breakdown twice. These samples suggest approximately 72,000–102,000 similar short poems from 60,000 credits alone. Allow substantially more tokens for difficult classical poems, longer poems, retries, or extra context. This is a small synthetic benchmark, not a live-corpus average or a guarantee.

A full weekly Pro allowance adds capacity, but its fixed token/credit equivalent is not published and cannot be inferred from the credit rate card. The original account read showed Pro, 5% weekly use, and about 62,497 credits before these tests and the later device-account replacement. Other work shares that account allowance.

Budget capacity and seven days of throughput are different. The historical high-reasoning runs used a 30-second interval after each completed invocation. With that interval and the observed 15–28-second generation time, a single sequential worker has a theoretical ceiling around 10,400–13,400 short poems/week, before Operations API latency, outages, retries and longer poems. The first live invocation took about 60 seconds end to end; adding the 30-second interval would yield about 6,700 similar invocations/week. The current twenty-worker pool uses a 5-second interval per worker to reduce idle time, but its xhigh throughput must be measured separately. Difficult or longer poems take longer.

## Cost and operations

US list prices were verified through Google's Pricing API on 2026-10-06: E2 CPU $0.02181159/vCPU-hour, RAM $0.00292353/GiB-hour, standard disk $0.04/GiB-month beyond shared free storage, and external IPv4 $0.005/hour. At 744 hours, compute is `(0.25 * 0.02181159 + 0.00292353) * 744 = $6.23`, disk at most $0.80, and IPv4 $3.72: **about $10.75/month**, plus traffic and taxes, before account discounts. There is no separate US Cloud NAT gateway.

GCP's Free Tier includes one month's e2-micro hours across `us-east1`, `us-central1`, and `us-west1`, plus 30 GB-months of standard persistent disk, per eligible billing account. The same billing account already runs the `sarj-1password` e2-micro bridge in `us-central1`, so budget for paid Saqi compute rather than assuming a second free VM. Some standard disk capacity may remain free. With a completely unused eligible allowance, this configuration's base cost would be approximately $3.72/month for IPv4. The original Dammam e2-small cost about $24.18/month.

The existing $35 project-wide alerts-only budget also includes Atuin and archive costs; it may alert with this added VM. That budget is not a spending cap and was not changed.

The [startup script](typescript/scripts/rig-vm/startup.sh) pins Node and verifies its SHA256, installs the pinned Codex CLI, preserves existing login configuration, and configures security updates and bounded journald storage. Journal logs record model, field names, token usage, and publication status without printing poem output or secrets.

Stop and disable the pool, let it drain all active invocations, and wait for any legacy invocation to finish before stopping the VM. Compute charges stop when the VM is stopped; disk charges continue. To restart, use `gcloud compute instances start saqi-codex --project=sarj-nasr-dev --zone=us-east1-b`. An enabled pool resumes after boot.

Sources: [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex credit pricing](https://learn.chatgpt.com/docs/pricing), [GCP Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features#compute), [GCP Pricing API](https://docs.cloud.google.com/billing/docs/reference/pricing-api/rest), and [network pricing](https://cloud.google.com/vpc/network-pricing).
