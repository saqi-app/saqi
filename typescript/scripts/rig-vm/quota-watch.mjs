import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chown,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { RigCodexServer } from "../rig-codex-server.mjs";

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
    typeof result.ordinaryUsageAllowed !== "boolean"
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

// Only a known, recorded attempt with no durable output may be requeued.
export async function recoverQuotaAttempt(
  record,
  { readState, resultBytes, request, now },
) {
  let state = await readState(record.poemId);
  const checkpoint = JSON.parse(state?.checkpointJson ?? "{}");
  if (
    !state ||
    !["dispatching", "unknown"].includes(state.status) ||
    checkpoint.invocation?.attemptId !== record.attemptId ||
    checkpoint.sourceHash !== record.sourceHash
  )
    return "resolved";
  // Completed output belongs to the normal publication recovery path. A
  // nonempty partial result also remains intact for review; never regenerate it.
  if (
    checkpoint.outputs?.generation != null ||
    (await resultBytes(record.attemptId)) > 0
  )
    return "saved";
  if (state.status === "dispatching") {
    if (state.leaseExpiresAt == null || state.leaseExpiresAt > now())
      return "leased";
    state = (await request({ action: "mark-unknown", poemId: record.poemId }))
      .state;
  }
  const current = JSON.parse(state?.checkpointJson ?? "{}");
  if (
    state?.status !== "unknown" ||
    current.invocation?.attemptId !== record.attemptId ||
    current.sourceHash !== record.sourceHash
  )
    throw new Error("QUOTA_RECOVERY_CHANGED");
  // Check again immediately before the version-fenced retry.
  if ((await resultBytes(record.attemptId)) > 0) return "saved";
  await request({
    action: "retry-unknown",
    poemId: record.poemId,
    attemptId: record.attemptId,
    expectedVersion: state.version,
  });
  return "requeued";
}

export async function reconcileQuota({
  readQuota,
  serviceState,
  stop,
  start,
  capturePending,
  recover,
  load,
  save,
  now = () => new Date().toISOString(),
}) {
  const quota = quotaSummary(await readQuota());
  const previous = await load();
  const state = await serviceState();
  let pending = previous.pending ?? [];
  const report = { checkedAt: now(), quota, pending, automaticResume: true };
  if (!quota.available) {
    if (["active", "activating", "reloading"].includes(state)) await stop();
    const stopped = await serviceState();
    if (["inactive", "failed"].includes(stopped))
      pending = await capturePending(pending);
    await save({
      ...report,
      pending,
      status:
        stopped === "deactivating" ? "draining_for_quota" : "waiting_for_quota",
    });
    return "waiting_for_quota";
  }
  if (["active", "activating", "reloading"].includes(state)) {
    await save({ ...report, status: "running" });
    return "running";
  }
  if (state === "deactivating") {
    await save({ ...report, status: "draining_for_quota" });
    return "draining_for_quota";
  }
  const outcomes = await mapBounded(pending, recover);
  pending = pending.filter((_record, index) => outcomes[index] === "leased");
  // Persist recovery before starting; a restart cannot requeue an already
  // resolved attempt even if a previous timer invocation stopped midway.
  await save({
    ...report,
    pending,
    status: pending.length ? "waiting_for_recovery" : "starting",
  });
  if (pending.length) return "waiting_for_recovery";
  await start();
  await save({ ...report, pending, status: "running" });
  return "running";
}

async function mapBounded(items, action) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        // eslint-disable-next-line no-await-in-loop -- Bound independent D1 requests to four concurrent operations.
        results[index] = await action(items[index]);
      }
    }),
  );
  return results;
}

async function readQuota() {
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

async function request(body, poemId) {
  const headers = {
    "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
  };
  if (!headers["CF-Access-Client-Id"] || !headers["CF-Access-Client-Secret"])
    throw new Error("QUOTA_ACCESS_CONFIGURATION_MISSING");
  if (body)
    Object.assign(headers, {
      "content-type": "application/json",
      Origin: "https://ops.saqi.app",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    });
  const response = await fetch(
    poemId ? `${endpoint}?poemId=${encodeURIComponent(poemId)}` : endpoint,
    {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`QUOTA_RIG_HTTP_${response.status}`);
  const result = await response.json();
  if (result.ok !== true) throw new Error("QUOTA_RIG_RESPONSE_INVALID");
  return result;
}

async function resultBytes(attemptId) {
  const sizes = await Promise.all(
    [directory, "/tmp"].map(async (path) => {
      try {
        return (await stat(join(path, `saqi-rig-${attemptId}.json`))).size;
      } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
      }
    }),
  );
  return Math.max(...sizes);
}

async function capturePending(previous) {
  const records = new Map(previous.map((record) => [record.poemId, record]));
  const tickets = (await readdir(directory)).filter((name) =>
    /^worker-\d+\.json$/u.test(name),
  );
  await mapBounded(tickets, async (name) => {
    const { poemId } = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    );
    const { state } = await request(undefined, poemId);
    const checkpoint = JSON.parse(state?.checkpointJson ?? "{}");
    const attemptId = checkpoint.invocation?.attemptId;
    if (
      ["dispatching", "unknown"].includes(state?.status) &&
      typeof attemptId === "string" &&
      typeof checkpoint.sourceHash === "string" &&
      checkpoint.outputs?.generation == null &&
      (await resultBytes(attemptId)) === 0
    )
      records.set(poemId, {
        poemId,
        attemptId,
        sourceHash: checkpoint.sourceHash,
      });
  });
  return [...records.values()];
}

async function save(report) {
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
    readQuota,
    serviceState: async () =>
      (
        await execute("systemctl", [
          "show",
          unit,
          "-p",
          "ActiveState",
          "--value",
        ])
      ).stdout.trim(),
    stop: () => execute("systemctl", ["stop", "--no-block", unit]),
    start: () => execute("systemctl", ["start", unit]),
    capturePending,
    recover: (record) =>
      recoverQuotaAttempt(record, {
        readState: async (poemId) => (await request(undefined, poemId)).state,
        resultBytes,
        request,
        now: () => Math.floor(Date.now() / 1000),
      }),
    load: async () => {
      try {
        return JSON.parse(
          await readFile(join(directory, "quota-health.json"), "utf8"),
        );
      } catch (error) {
        if (error.code === "ENOENT") return {};
        throw error;
      }
    },
    save,
  });
  console.log(`Quota watcher: ${status}`);
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
