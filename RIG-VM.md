# Saqi Codex VM

Provisioned 2026-10-06 in `sarj-nasr-dev`: `saqi-codex`, zone `us-east1-b`, e2-micro (2 burstable vCPUs, 0.25 sustained CPU, 1 GiB RAM), 100 GiB standard disk, Ubuntu 24.04, and 2 GiB swap. It has an ephemeral external IPv4 address for outbound access and no GCP service account. The `saqi-us-east1` subnet belongs to `nasr-dev-private`. No public application ports are open. The original Dammam VM and its 20 GiB balanced boot disk were permanently deleted on 2026-10-06 after replacement verification and explicit approval; they incur no further compute or disk charges. `saqi-codex-iap-ssh` allows TCP 22 only from Google IAP to the `saqi-codex` network tag. Atuin is a separate VM.

The standard boot disk was expanded online from 20 to 100 GiB after the eighty-worker workload showed repeated disk I/O waits. Its size-based random I/O limits rise from 15 read / 30 write IOPS to 75 read / 150 write IOPS. The VM and paid model turns stayed running. Provisioned capacity determines these limits; the root filesystem is still 19 GiB with 13 GiB available at verification. Expand the filesystem during planned maintenance if additional file space is needed. [Google documents these performance limits](https://docs.cloud.google.com/compute/docs/disks/performance) and [online disk expansion](https://docs.cloud.google.com/compute/docs/disks/resize-persistent-disk).

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

The [pool service](typescript/scripts/rig-vm/saqi-translate-standard.service) runs eighty independent poem workers through one shared Codex app-server process. Every new thread explicitly uses GPT-6.1 Sol, xhigh reasoning, Standard speed, a focused translation instruction set, and disabled tools. D1 atomically limits concurrent claims to eighty distinct poems, including any remaining legacy invocation. Claim/source/dispatch setup passes through a shared two-lane scheduling gate, bounding startup bursts and competing candidate scans while feeding workers without a serial backlog; each lane opens before paid model inference, so all eighty translations can run concurrently. The pool health snapshot reports `setupConcurrency` separately from the paid-worker limit. Each worker waits five seconds after an invocation and owns a private recovery ticket. Cache invalidation runs independently every fifteen seconds, batching up to fifty completed publications per request so Cloudflare’s five tag-purges-per-minute limit does not pause model workers. Canonical dirty flags remain until the batch purge succeeds and each source/publication hash still matches. Cache maintenance continues during graceful drains, with a final flush after paid workers finish. Paid results are saved atomically before acknowledgement; ambiguous outcomes stay fenced rather than being regenerated. The older [single-invocation service](typescript/scripts/rig-vm/saqi-translate.service) and [timer](typescript/scripts/rig-vm/saqi-translate.timer) remain available for recovery but the timer is disabled during pool operation. D1 remains the queue. Pending result files live in `/home/saqi/.local/state/saqi/results-standard`; do not delete an unresolved attempt's file.

The service loads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from the private mode-0600 file `/home/saqi/.config/saqi/access.env`. Login is in `/home/saqi/.codex/auth.json`, mode 0600. These files are outside the runtime code directory. Never copy their contents into chat, source control, instance metadata, or command arguments.

```sh
# These commands run on the VM:
# Disable legacy scheduling before starting the pool; let its in-flight poem finish.
sudo systemctl disable --now saqi-translate.timer
sudo systemctl enable --now saqi-translate-standard.service
sudo systemctl status saqi-translate-standard.service
sudo journalctl -u saqi-translate-standard.service -f
# Stop scheduling new work; let the current invocation finish:
sudo systemctl disable --now saqi-translate-standard.service
# Pool SIGTERM drains active translations before exiting; stop can take a while.
```

The [device-login activation service](typescript/scripts/rig-vm/saqi-codex-login.service) drains the pool and waits for any legacy in-flight translation before atomically installing a newly authorized login. It runs under systemd and survives SSH disconnects. Without a pending login, the service is skipped so an intentionally stopped pool stays stopped after reboot. The private staging files are `/home/saqi/.config/saqi/pending-codex-auth.json` and `pending-codex-login.env` (the latter sets `SAQI_CODEX_LOGIN_EMAIL` to the expected account); both must be mode 0600. A mismatched account leaves the existing login intact. The pool resumes when activation exits, and an unfinished activation is retried after reboot. Credentials never enter Git.

The [health timer](typescript/scripts/rig-vm/saqi-translation-health.timer) checks every 20 minutes without making model calls. It streams the last day of journal records and retains only publication metadata, so monitoring does not load the entire log history into the small VM's memory. Its reports count unique published poems and Arabic lines, show generation/publication latency and the current poem's elapsed time, and flag service failures, unexpected timer pauses, or invocations longer than 60 minutes. A login handoff is reported as maintenance. Pool reports include every active poem, worker number, model, reasoning effort, and elapsed time. Codex completion logs also record first-output delay, output bytes, completed response count, retry/error notifications, and token usage without generated text. One completed generation per twenty-minute window is retained privately as `quality-sample-<window>.json` in the result directory for semantic spot checks; confirm its poem is `complete` before counting it as published. Samples do not enter journals or Git. An authenticated `GET /api/rig/state?poemId=<id>&publication=1` also reads the persisted publication snapshot and cache-purge flag, then checks the deployed public Worker through its service binding for every current English line and word meaning. This catches stale or missing public content without a Bot Fight Mode challenge. These are operational reports in journald; they do not send chat notifications or automatically replay a generation. Inspect a long-running attempt before retrying it.

```sh
sudo systemctl enable --now saqi-translation-health.timer
sudo journalctl -u saqi-translation-health.service -n 20 --no-pager
```

Disable the Mac translation LaunchAgent before enabling the VM job so the Mac cannot resume a second translator at login. Collection in personal Chrome is independent and can continue.

The pool is enabled, the legacy timer is disabled, and the Mac translation LaunchAgent is disabled. A real four-line poem was generated and published on 2026-10-06 with GPT-6.1 Sol High, Standard speed; D1 independently reported `complete`, version 4, with its checkpoint cleared. The deployment write canary passed and the retained cache-purge backlog was drained.

The initial production 503 came from serializing a complete pending-purge database row, including publication/source hashes, into a strict public API request. `purgePublishedPoem` now sends only `authorSlug` and `poemId`; the regression test uses a repository-shaped row and the shared public contract. Known cache errors retain bounded status/details, and every production deployment now tests the authenticated purge write path. Cloudflare deployments use the protected GitHub production workflow because the current local CLI account cannot access Saqi's resources. Unknown older invocations remain fenced and do not prevent new poems from running.

FAST is disabled at the user's request to maximize the number of poems covered by the allowance and credits. Threads and turns explicitly use the `default` tier, the CLI disables `fast_mode`, and the runner rejects any thread that does not confirm GPT-6.1 Sol, xhigh reasoning, and the Standard tier. The retired Fast service is inactive and disabled. See [Codex speed modes](https://learn.chatgpt.com/docs/agent-configuration/speed).

Candidate discovery reads at most eight pages of 128 canonical poems per request, with only IDs materialized and JSON checks applied after indexed row lookups. Concurrent claim requests carry a validated scan hint that the VM saves in `queue-scan-hint.json`, so discovery continues across Operations isolates and VM restarts. Losing or damaging this performance hint repeats bounded reads without changing durable work. Discovery cycles through untranslated, current but incomplete, and stale publications in that order. Explicit retries still run first. This avoids repeatedly sorting the entire corpus as publication JSON grows. A temporarily empty claim response can mean the bounded scan is still advancing, so workers continue polling.

Truncated JSON results stay on disk for review. Once the invocation lease expires, its outcome is marked unknown and remains fenced; its worker can continue with other poems. The rig never publishes a syntactically incomplete result or automatically regenerates that attempt.

For a complete result that arrived after its worker fenced an outcome, `node typescript/scripts/rig-lite.mjs recover-attempt ATTEMPT_ID` looks up only that exact unknown attempt and reuses its saved JSON. It cannot invoke Codex or retry generation. Run it on the VM as `saqi` with the private access environment and the pool's cache-maintenance service active. Existing source, attempt, version, and output validation still gate publication; verify the public page and cleared cache flag afterward. Active dispatches and unmatched attempts are refused, and their files stay preserved.

## Capacity estimate

The measurements below used high reasoning before the xhigh change; they do not estimate xhigh consumption or latency. Synthetic benchmarks on this VM used the real rig prompt and output schema, GPT-6.1 Sol High, Standard speed, translation plus per-word meanings, and no production writes. Both line counts and word counts validated. The synthetic text was original, simple modern Arabic; it is not a sample of the live classical corpus.

| Arabic lines      | Input tokens | Output tokens | Reasoning token breakdown | Generation seconds | Estimated credits |
| ----------------- | -----------: | ------------: | ------------------------: | -----------------: | ----------------: |
| 4                 |       10,249 |           293 |                       143 |              15.08 |             0.586 |
| 20                |       10,964 |         1,012 |                       149 |              25.27 |             0.801 |
| 20, repeated test |       10,964 |         1,120 |                       262 |              27.90 |             0.828 |

The first live four-line poem additionally used 10,344 input tokens, 1,193 output tokens (including a 1,034-token reasoning breakdown), zero cached input, and about 51 seconds for generation. Estimated consumption was 0.815 credits, roughly 73,600 equally sized calls from 60,000 credits; this single poem is not a corpus average.

All three synthetic benchmarks reported zero cached input. At the published Standard rate, estimated credits are `(50 * uncached input + 2.5 * cached input + 250 * output) / 1,000,000`. Reasoning is part of billed output; do not charge its breakdown twice. These samples suggest approximately 72,000–102,000 similar short poems from 60,000 credits alone. Allow substantially more tokens for difficult classical poems, longer poems, retries, or extra context. This is a small synthetic benchmark, not a live-corpus average or a guarantee.

A later live-corpus sample of 254 completed GPT-6.1 Sol xhigh Standard generations used 2,420,373 input tokens (255,744 cached) and 3,076,305 output tokens. At the Standard rate, that is about 3.456 credits per generation, or roughly 17,400 similar generations from 60,000 credits. At Fast's doubled credit rate, the same token mix would cover about 8,700. Poem length and reasoning vary; measure the current Standard pool's throughput separately.

A full weekly Pro allowance adds capacity, but its fixed token/credit equivalent is not published and cannot be inferred from the credit rate card. The original account read showed Pro, 5% weekly use, and about 62,497 credits before these tests and the later device-account replacement. Other work shares that account allowance.

Budget capacity and seven days of throughput are different. The historical high-reasoning runs used a 30-second interval after each completed invocation. With that interval and the observed 15–28-second generation time, a single sequential worker has a theoretical ceiling around 10,400–13,400 short poems/week, before Operations API latency, outages, retries and longer poems. The first live invocation took about 60 seconds end to end; adding the 30-second interval would yield about 6,700 similar invocations/week. The current eighty-worker pool uses a 5-second interval per worker to reduce idle time, but its xhigh throughput must be measured separately. Difficult or longer poems take longer.

## Cost and operations

US list prices were verified through Google's Pricing API on 2026-10-06: E2 CPU $0.02181159/vCPU-hour, RAM $0.00292353/GiB-hour, standard disk $0.04/GiB-month beyond shared free storage, and external IPv4 $0.005/hour. At 744 hours, compute is `(0.25 * 0.02181159 + 0.00292353) * 744 = $6.23`, disk at most $4.00, and IPv4 $3.72: **about $13.95/month**, plus traffic and taxes, before account discounts. There is no separate US Cloud NAT gateway.

GCP's Free Tier includes one month's e2-micro hours across `us-east1`, `us-central1`, and `us-west1`, plus 30 GB-months of standard persistent disk, per eligible billing account. The same billing account already runs the `sarj-1password` e2-micro bridge in `us-central1`, so budget for paid Saqi compute rather than assuming a second free VM. Some standard disk capacity may remain free. With a completely unused eligible allowance, this configuration's base cost would be approximately $6.52/month for IPv4 and 70 GiB of disk beyond the free allowance. The original Dammam e2-small cost about $24.18/month.

The existing $35 project-wide alerts-only budget also includes Atuin and archive costs; it may alert with this added VM. That budget is not a spending cap and was not changed.

The [startup script](typescript/scripts/rig-vm/startup.sh) pins Node and verifies its SHA256, installs the pinned Codex CLI, preserves existing login configuration, and configures security updates and bounded journald storage. Journal logs record model, field names, token usage, and publication status without printing poem output or secrets.

Stop and disable the pool, let it drain all active invocations, and wait for any legacy invocation to finish before stopping the VM. Compute charges stop when the VM is stopped; disk charges continue. To restart, use `gcloud compute instances start saqi-codex --project=sarj-nasr-dev --zone=us-east1-b`. An enabled pool resumes after boot.

Sources: [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex credit pricing](https://learn.chatgpt.com/docs/pricing), [GCP Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features#compute), [GCP Pricing API](https://docs.cloud.google.com/billing/docs/reference/pricing-api/rest), and [network pricing](https://cloud.google.com/vpc/network-pricing).

Authenticated `GET /api/rig/state?diagnostics=1` reports canonical in-flight counts, occupied slots, the current isolate's scan hint, and at most eighty expired dispatches using the active-state index. This is a read-only diagnostic for empty claim responses; an expired dispatch may still be running. Correlate each attempt with live workers before recovering it. The diagnostic never expires work, publishes, or starts a model turn.

The scoped fetch wrapper in `rig-queue-hints.mjs` only adds scan hints to concurrent claim requests at the configured Operations endpoint. It leaves paid model turns and all publication writes untouched. Out-of-order responses cannot rewind the saved client hint. The same exported installer can be loaded into a running Node pool through its temporary loopback inspector after the module hash and deployment are verified; close the inspector immediately afterward. This applies the performance wrapper without draining paid turns. Future pool starts install it from `rig-lite.mjs`.
