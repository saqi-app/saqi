# Saqi Codex VM

Provisioned 2026-10-06 in `sarj-nasr-dev`: `saqi-codex`, zone `us-east1-b`, e2-micro (2 burstable vCPUs, 0.25 sustained CPU, 1 GiB RAM), 20 GiB standard disk, Ubuntu 24.04, and 2 GiB swap. It has an ephemeral external IPv4 address for outbound access and no GCP service account. The `saqi-us-east1` subnet belongs to `nasr-dev-private`. No public application ports are open. The original Dammam VM is being retired after replacement verification. `saqi-codex-iap-ssh` allows TCP 22 only from Google IAP to the `saqi-codex` network tag. Atuin is a separate VM.

Codex CLI 0.159.3 and Node 24.21.0 are installed. The dedicated `saqi` Unix account uses GPT-6.1 Sol, high reasoning, Standard speed, and ChatGPT login. The initial login was copied securely over IAP SSH from the existing authenticated device; credentials are private files, never metadata or source files. For a separate device session, use the device login command below. The translation job has no quota reserve or local spending cap. It consumes included allowance and available account credits until Codex rejects further usage.

## Connect and authenticate

```sh
gcloud compute ssh saqi-codex --project=sarj-nasr-dev --zone=us-east1-b --tunnel-through-iap
sudo -iu saqi
codex login status
# To create a fresh headless device session:
codex login --device-auth
# To keep a manual Codex session alive after SSH disconnects:
cd /home/saqi/work/saqi
tmux new -A -s codex
codex -m gpt-6.1-sol -c 'model_reasoning_effort="high"'
```

Enable device login in ChatGPT security settings if required. Follow the browser link and enter the one-time code. Codex refreshes the cached session during use. The VM's minimal translator directory contains the rig entrypoints, output schema, compiled word-gloss contracts, and Zod 4.6.5. It is not a full development checkout.

## Background job

The [service](typescript/scripts/rig-vm/saqi-translate.service) runs one invocation. The [timer](typescript/scripts/rig-vm/saqi-translate.timer) starts the next invocation 30 seconds after the previous one exits. Jobs never overlap. D1 remains the queue, and unknown prior calls are fenced by the existing recovery logic. Pending result files live in `/home/saqi/.local/state/saqi/results`; do not delete an unresolved attempt's file.

The service loads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from the private mode-0600 file `/home/saqi/.config/saqi/access.env`. Login is in `/home/saqi/.codex/auth.json`, mode 0600. These files are outside the runtime code directory. Never copy their contents into chat, source control, instance metadata, or command arguments.

```sh
# These commands run on the VM:
sudo systemctl enable --now saqi-translate.timer
sudo systemctl status saqi-translate.timer saqi-translate.service
sudo journalctl -u saqi-translate.service -f
# Stop scheduling new work; let the current invocation finish:
sudo systemctl disable --now saqi-translate.timer
```

Disable the Mac translation LaunchAgent before enabling the VM job so the Mac cannot resume a second translator at login. Collection in personal Chrome is independent and can continue.

Production queue, publication, and cache writes were authorized on 2026-10-06. Initial starts exposed a cache-purge failure before generation. The production timer remains disabled until the write-path canary and an actual `Published POEM_ID` journal entry succeed. The Mac translator must be disabled before cutover. Cloudflare deployment uses the protected GitHub production workflow because the current local CLI account cannot access Saqi's resources.

## Capacity estimate

Synthetic benchmarks on this VM used the real rig prompt and output schema, GPT-6.1 Sol High, Standard speed, translation plus per-word meanings, and no production writes. Both line counts and word counts validated. The synthetic text was original, simple modern Arabic; it is not a sample of the live classical corpus.

| Arabic lines | Input tokens | Output tokens | Reasoning token breakdown | Generation seconds | Estimated credits |
|---|---:|---:|---:|---:|---:|
| 4 | 10,249 | 293 | 143 | 15.08 | 0.586 |
| 20 | 10,964 | 1,012 | 149 | 25.27 | 0.801 |
| 20, repeated test | 10,964 | 1,120 | 262 | 27.90 | 0.828 |

All three reported zero cached input. At the published Standard rate, estimated credits are `(50 * uncached input + 2.5 * cached input + 250 * output) / 1,000,000`. Reasoning is part of billed output; do not charge its breakdown twice. These samples suggest approximately 72,000–102,000 similar short poems from 60,000 credits alone. Allow substantially more tokens for difficult classical poems, longer poems, retries, or extra context. This is a small synthetic benchmark, not a live-corpus average or a guarantee.

A full weekly Pro allowance adds capacity, but its fixed token/credit equivalent is not published and cannot be inferred from the credit rate card. The account read showed Pro, 5% weekly use, and about 62,497 credits before these tests. Other work shares that account allowance.

Budget capacity and seven days of throughput are different. With a 30-second interval after each completed invocation and the observed 15–28-second generation time, a single sequential worker has a theoretical ceiling around 10,400–13,400 short poems/week, before Operations API latency, outages, retries and longer poems. The current production 503 prevents real throughput until resolved.

## Cost and operations

GCP's Free Tier includes one month's e2-micro hours across `us-east1`, `us-central1`, and `us-west1`, plus 30 GB-months of standard persistent disk, per eligible billing account. With that allowance available, compute and this 20 GB standard disk are free. External IPv4 costs $0.005/hour: **$3.72 for 744 hours**, plus traffic, taxes, and any usage outside the free allowances. This VM avoids a separate US Cloud NAT gateway. Free-tier availability is shared across the billing account and is not guaranteed by provisioning a matching VM.

Without free-tier credits, published US list rates put this configuration around $11/month, still substantially cheaper than the original Dammam e2-small at about $24/month. Actual billing depends on account pricing and discounts.

The existing $35 project-wide alerts-only budget also includes Atuin and archive costs; it may alert with this added VM. That budget is not a spending cap and was not changed.

The [startup script](typescript/scripts/rig-vm/startup.sh) pins Node and verifies its SHA256, installs the pinned Codex CLI, preserves existing login configuration, and configures security updates and bounded journald storage. Journal logs record model, field names, token usage, and publication status without printing poem output or secrets.

Stop the timer and wait for any active invocation to finish before stopping the VM. Compute charges stop when the VM is stopped; disk charges continue. To restart, use `gcloud compute instances start saqi-codex --project=sarj-nasr-dev --zone=us-east1-b`. An enabled timer resumes after boot.

Sources: [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex credit pricing](https://learn.chatgpt.com/docs/pricing), [GCP Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features#compute), and [network pricing](https://cloud.google.com/vpc/network-pricing).
