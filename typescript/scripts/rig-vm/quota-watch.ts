/* global fetch, AbortSignal -- Node provides fetch and request cancellation. */
import { execFile } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import {
  chown,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { RigCodexServer } from "../rig-codex-server.ts";

const execute = promisify(execFile);
const unit = "saqi-translate-standard.service";
const directory =
  process.env.SAQI_RIG_RESULT_DIR ??
  "/home/saqi/.local/state/saqi/results-standard";
const endpoint = "https://ops.saqi.app/api/rig/state";

export function quotaSummary(result) {
  const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  if (
    bucket?.limitId !== "codex" ||
    ![true, false].includes(result.ordinaryUsageAllowed)
  )
    throw new Error("CODEX_QUOTA_STATUS_UNAVAILABLE");
  return {
    available:
      result.ordinaryUsageAllowed && bucket.spendControlReached !== true,
    usedPercent: bucket.primary?.usedPercent ?? null,
    resetsAt: bucket.primary?.resetsAt ?? null,
    credits: bucket.credits?.balance ?? null,
  };
}

// Quota observations cannot prove that a paid invocation never ran. Keep its
// result and canonical checkpoint intact for the normal recovery path.
export async function recoverQuotaAttempt(
  record,
  { readState, resultBytes, now }
) {
  const state = await readState(record.poemId);
  const checkpoint = JSON.parse(state?.checkpointJson ?? "{}");
  if (
    !state ||
    !["dispatching", "unknown"].includes(state.status) ||
    checkpoint.invocation?.attemptId !== record.attemptId ||
    checkpoint.sourceHash !== record.sourceHash
  )
    return "resolved";
  if (
    state.status === "dispatching" &&
    (state.leaseExpiresAt == null || state.leaseExpiresAt > now())
  )
    return "leased";
  // A nonempty partial result also belongs to the normal recovery path.
  if (
    checkpoint.outputs?.generation != null ||
    (await resultBytes(record.attemptId)) > 0
  )
    return "saved";
  return "unresolved";
}

// eslint-disable-next-line @sarj/no-excessive-cognitive-complexity -- This serialized lifecycle owns durable resume intent and rechecks explicit service controls between each slow external operation.
export async function reconcileQuota({
  readQuota,
  serviceEnabled,
  serviceState,
  stop,
  start,
  capturePending,
  recover,
  load,
  save,
  now = () => new Date().toISOString(),
}) {
  const previous = await load();
  let pending = previous.pending ?? [];
  let resumeAfterQuota = previous.resumeAfterQuota === true;
  let quota = previous.quota ?? null;
  const report = (status) =>
    save({
      checkedAt: now(),
      quota,
      pending,
      resumeAfterQuota,
      automaticResume: resumeAfterQuota,
      status,
    });
  if (!(await serviceEnabled())) {
    resumeAfterQuota = false;
    await report("disabled");
    return "disabled";
  }
  if (
    resumeAfterQuota &&
    ["active", "activating", "reloading"].includes(await serviceState())
  ) {
    // A successful start can precede a failed final report save. Clear that
    // stale intent before a slow probe can overlap the user's next stop.
    resumeAfterQuota = false;
    await report("running");
  }
  quota = quotaSummary(await readQuota());
  // Probing Codex can take time. Honor a disable or stop issued while it ran.
  if (!(await serviceEnabled())) {
    resumeAfterQuota = false;
    await report("disabled");
    return "disabled";
  }
  const state = await serviceState();
  const running = ["active", "activating", "reloading"].includes(state);
  if (!running && !resumeAfterQuota) {
    await report("stopped");
    return "stopped";
  }
  if (!quota.available) {
    if (running) {
      resumeAfterQuota = true;
      // The intent must survive a watcher restart after its stop succeeds.
      await report("draining_for_quota");
      await stop();
    }
    const stopped = await serviceState();
    if (["inactive", "failed"].includes(stopped))
      pending = await capturePending(pending);
    const status =
      stopped === "deactivating" ? "draining_for_quota" : "waiting_for_quota";
    await report(status);
    return status;
  }
  if (running) {
    resumeAfterQuota = false;
    await report("running");
    return "running";
  }
  if (state === "deactivating") {
    await report("draining_for_quota");
    return "draining_for_quota";
  }
  if (!["inactive", "failed"].includes(state)) {
    await report("waiting_for_service");
    return "waiting_for_service";
  }
  // A quota reset can arrive while the pool is still draining. Capture its
  // tickets after it stops, even if no exhausted-quota check observed the stop.
  pending = await capturePending(pending);
  const outcomes = await mapBounded(pending, recover);
  const leased = outcomes.includes("leased");
  pending = pending.filter((_record, index) => outcomes[index] !== "resolved");
  if (leased) {
    await report("waiting_for_recovery");
    return "waiting_for_recovery";
  }
  await report("starting");
  if (!(await serviceEnabled())) {
    resumeAfterQuota = false;
    await report("disabled");
    return "disabled";
  }
  const current = await serviceState();
  if (["active", "activating", "reloading"].includes(current)) {
    resumeAfterQuota = false;
    await report("running");
    return "running";
  }
  if (current === "deactivating") {
    await report("draining_for_quota");
    return "draining_for_quota";
  }
  if (!["inactive", "failed"].includes(current)) {
    await report("waiting_for_service");
    return "waiting_for_service";
  }
  await start();
  resumeAfterQuota = false;
  await report("running");
  return "running";
}

async function mapBounded(items, action) {
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        // eslint-disable-next-line no-await-in-loop -- Bound independent D1 requests to four concurrent operations.
        results[index] = await action(items[index]);
      }
    })
  );
  return results;
}

async function readAccountQuota() {
  const server = new RigCodexServer("/usr/bin/sudo", [
    "-H",
    "-u",
    "saqi",
    "/usr/local/bin/codex",
    "--disable",
    "fast_mode",
    "--disable",
    "multi_agent",
    "--disable",
    "shell_tool",
    "--disable",
    "standalone_web_search",
    "--disable",
    "apps",
    "app-server",
    "--stdio",
  ]);
  try {
    await server.initialize();
    const { account } = await server.call("account/read", {
      refreshToken: false,
    });
    if (
      account?.type !== "chatgpt" ||
      account.email !== "nasrmaswood@gmail.com"
    )
      throw new Error("CODEX_QUOTA_ACCOUNT_MISMATCH");
    return await server.call("account/rateLimits/read", {});
  } finally {
    server.close();
  }
}

async function readRigState(poemId) {
  const headers = {
    "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
  };
  if (!headers["CF-Access-Client-Id"] || !headers["CF-Access-Client-Secret"])
    throw new Error("QUOTA_ACCESS_CONFIGURATION_MISSING");
  const options = {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(30_000),
  };
  const response = await fetch(
    `${endpoint}?poemId=${encodeURIComponent(poemId)}`,
    options
  );
  if (!response.ok) throw new Error(`QUOTA_RIG_HTTP_${response.status}`);
  const result = await response.json();
  if (result.ok !== true) throw new Error("QUOTA_RIG_RESPONSE_INVALID");
  return result.state;
}

async function readResultBytes(attemptId) {
  const sizes = await Promise.all(
    [directory, "/tmp"].map(async (path) => {
      try {
        const result = await stat(join(path, `saqi-rig-${attemptId}.json`));
        return result.size;
      } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
    })
  );
  return Math.max(...sizes);
}

async function captureInterrupted(previous) {
  const records = new Map(previous.map((record) => [record.poemId, record]));
  const files = await readdir(directory);
  const tickets = files.filter((name) => /^worker-\d+\.json$/u.test(name));
  await mapBounded(tickets, async (name) => {
    const { poemId } = JSON.parse(
      await readFile(join(directory, name), "utf8")
    );
    const state = await readRigState(poemId);
    const checkpoint = JSON.parse(state?.checkpointJson ?? "{}");
    const attemptId = checkpoint.invocation?.attemptId;
    if (
      ["dispatching", "unknown"].includes(state?.status) &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(attemptId) &&
      /^[0-9a-f]{64}$/u.test(checkpoint.sourceHash) &&
      checkpoint.outputs?.generation == null &&
      (await readResultBytes(attemptId)) === 0
    )
      records.set(poemId, {
        poemId,
        attemptId,
        sourceHash: checkpoint.sourceHash,
      });
  });
  return records.values().toArray();
}

async function saveReport(report) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "quota-health.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(report));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const owner = await stat(directory);
  await chown(temporary, owner.uid, owner.gid);
  await rename(temporary, path);
}

async function main() {
  const status = await reconcileQuota({
    readQuota: readAccountQuota,
    serviceEnabled: async () => {
      const result = await execute("systemctl", [
        "show",
        unit,
        "-p",
        "UnitFileState",
        "--value",
      ]);
      return ["enabled", "enabled-runtime"].includes(result.stdout.trim());
    },
    serviceState: async () => {
      const result = await execute("systemctl", [
        "show",
        unit,
        "-p",
        "ActiveState",
        "--value",
      ]);
      return result.stdout.trim();
    },
    stop: () => execute("systemctl", ["stop", "--no-block", unit]),
    start: () => execute("systemctl", ["start", unit]),
    capturePending: captureInterrupted,
    recover: (record) =>
      recoverQuotaAttempt(record, {
        readState: readRigState,
        resultBytes: readResultBytes,
        now: () => Math.floor(Date.now() / 1000),
      }),
    load: async () => {
      try {
        return JSON.parse(
          await readFile(join(directory, "quota-health.json"), "utf8")
        );
      } catch (error) {
        if (error.code === "ENOENT") return {};
        throw error;
      }
    },
    save: saveReport,
  });
  console.warn(`Quota watcher: ${status}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
