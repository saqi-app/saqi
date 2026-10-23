import console from "node:console";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { RigCodexServer } from "./rig-codex-server.ts";
import { purgeCache, translateNext } from "./rig-lite.ts";
import { generationSchema, normalizeWordMeanings } from "./rig-output.ts";
import { rigPoolHealth } from "./rig-pool-health.ts";
import { resultDirectory as directory, resultPath } from "./rig-results.ts";

const concurrency = Number(process.env.SAQI_RIG_CONCURRENCY ?? 80);
if (!Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 80)
  throw new Error("INVALID_POOL_CONCURRENCY");
await mkdir(directory, { recursive: true, mode: 0o700 });
const template = JSON.parse(
  await readFile(
    new URL("rig-publication-output.schema.json", import.meta.url),
    "utf8"
  )
);
const active = new Map();
const paused = new Map();
const sampledWindows = new Set();
let stopping = false;
let cacheTask = Promise.resolve();
let cacheRunning = false;
let cacheMaintenanceError = null;
const setupConcurrency = 2;
const schedulingWaiters = [];
let schedulingActive = 0;
const snapshot = rigPoolHealth(() =>
  durableWrite(
    join(directory, "pool-health.json"),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      concurrency,
      setupConcurrency,
      stopping,
      cacheMaintenanceError,
      activePoems: active.values().toArray(),
      pausedWorkers: paused.values().toArray(),
    })
  )
);

process.on("SIGTERM", () => {
  stopping = true;
  process.stdout.write("Pool draining; no new poems will be claimed.\n");
});
process.on("SIGINT", () => {
  stopping = true;
});
const server = new RigCodexServer();
let health;
let cacheTimer;
let serverFailed;
let workerFailed;
try {
  await server.initialize();
  process.stdout.write(
    `Translation pool started: ${concurrency} workers; gpt-6.1-sol xhigh; Standard speed; ${setupConcurrency} setup lanes.\n`
  );
  health = setInterval(
    () =>
      snapshot().catch(() => {
        stopping = true;
      }),
    10_000
  );
  cacheTimer = setInterval(maintainCache, 15_000);
  maintainCache();
  const workers = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, index) =>
      worker(index + 1).catch((error) => {
        stopping = true;
        const id = index + 1;
        const code = workerFailureCode(error);
        paused.set(id, {
          worker: id,
          code,
          checkedAt: new Date().toISOString(),
        });
        console.error(`Worker ${id} failed; pool draining: ${code}`);
        throw error;
      })
    )
  );
  workerFailed = workers.some(({ status }) => status === "rejected");
} finally {
  stopping = true;
  clearInterval(health);
  clearInterval(cacheTimer);
  await cacheTask;
  if (cacheTimer) await maintainCache();
  serverFailed = !server.alive;
  server.close();
  await snapshot();
}
if (serverFailed || workerFailed) process.exitCode = 1;

async function durableWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function worker(id) {
  const ticket = join(directory, `worker-${id}.json`);
  let ownedPoemId;
  try {
    const saved = JSON.parse(await readFile(ticket, "utf8"));
    // eslint-disable-next-line no-restricted-syntax -- Persisted worker tickets are untrusted JSON; reject missing or non-string identities before resuming paid work.
    if (typeof saved?.poemId !== "string" || !saved.poemId)
      throw new Error("POOL_TICKET_INVALID");
    ownedPoemId = saved.poemId;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await delay((id - 1) * 250);
  while (!stopping && server.alive) {
    // Two setup lanes keep workers fed; canonical dispatch still fences paid concurrency.
    // eslint-disable-next-line no-await-in-loop -- Each worker enters the shared scheduling gate before claiming.
    const releaseScheduling = await acquireScheduling();
    if (stopping || !server.alive) {
      releaseScheduling();
      break;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- Each worker persists and publishes its current poem before claiming another.
      await translateNext(undefined, {
        maxConcurrent: concurrency,
        deferCachePurge: true,
        ownedPoemId,
        remember: async (poemId) => {
          if (poemId) await durableWrite(ticket, JSON.stringify({ poemId }));
          else
            await unlink(ticket).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          ownedPoemId = poemId ?? undefined;
        },
        generate: async (prompt, attemptId, lines, required) => {
          const outputPath = resultPath(attemptId);
          await writeFile(outputPath, "", { mode: 0o600, flag: "wx" });
          // Persist before inference: a saved earlier final must not become
          // recoverable if a newer final or terminal confirmation cannot persist.
          await durableWrite(
            `${outputPath}.pending`,
            "Awaiting turn completion\n"
          );
          paused.delete(id);
          active.set(id, {
            worker: id,
            poemId: ownedPoemId,
            arabicLines: lines.length,
            model: "gpt-6.1-sol",
            reasoningEffort: "xhigh",
            serviceTier: "default",
            startedAt: new Date().toISOString(),
          });
          try {
            await snapshot();
            releaseScheduling();
            const metrics = await server.generate(
              prompt,
              generationSchema(template, lines, required),
              (text) => durableWrite(outputPath, text)
            );
            await unlink(`${outputPath}.pending`);
            const usage = metrics.usage;
            // Preserve the quoted telemetry wire keys.
            // prettier-ignore
            process.stdout.write(
              `Codex usage: ${JSON.stringify(usage ? { "service_tier": "default", "input_tokens": usage.inputTokens, "cached_input_tokens": usage.cachedInputTokens, "output_tokens": usage.outputTokens, "reasoning_output_tokens": usage.reasoningOutputTokens } : {})}\n`,
            );
            process.stdout.write(
              `Codex timing: ${JSON.stringify({ worker: id, poemId: ownedPoemId, ...metrics, usage: undefined })}\n`
            );
            const output = normalizeWordMeanings(
              JSON.parse(await readFile(outputPath, "utf8"))
            );
            const window = Math.floor(Date.now() / 1_200_000);
            if (!sampledWindows.has(window)) {
              sampledWindows.add(window);
              await durableWrite(
                join(directory, `quality-sample-${window}.json`),
                JSON.stringify({
                  poemId: ownedPoemId,
                  model: "gpt-6.1-sol",
                  reasoningEffort: "xhigh",
                  serviceTier: "default",
                  linesArabic: lines,
                  output,
                })
              ).catch(() => console.error("QUALITY_SAMPLE_UNAVAILABLE"));
            }
            return output;
          } finally {
            active.delete(id);
            await snapshot();
          }
        },
      });
      paused.delete(id);
    } catch (error) {
      const code = workerFailureCode(error);
      paused.set(id, {
        worker: id,
        poemId: ownedPoemId,
        code,
        checkedAt: new Date().toISOString(),
      });
      if (!server.alive) stopping = true;
      console.error(`Worker ${id} paused: ${code}`);
    } finally {
      releaseScheduling();
    }
    // eslint-disable-next-line no-await-in-loop -- Backoff is per worker and must not create overlapping invocations.
    await delay(5_000);
  }
}

async function acquireScheduling() {
  if (schedulingActive === setupConcurrency)
    await new Promise((resolve) => {
      schedulingWaiters.push(resolve);
    });
  else schedulingActive += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const waiting = schedulingWaiters.shift();
    if (waiting) waiting();
    else schedulingActive -= 1;
  };
}

function workerFailureCode(error) {
  if (error?.name === "TimeoutError") return "RIG_API_TIMEOUT";
  const httpStatus = error.message?.match(/^Rig API(?: GET)? (\d{3})/u)?.[1];
  if (httpStatus) return `RIG_API_HTTP_${httpStatus}`;
  return (
    error.message?.match(/^[A-Z_0-9]+$/u)?.[0] ??
    "TRANSLATION_REQUIRES_RECOVERY"
  );
}

function maintainCache() {
  if (cacheRunning) return cacheTask;
  cacheRunning = true;
  cacheTask = purgeCache()
    .then(() => {
      cacheMaintenanceError = null;
    })
    .catch((error) => {
      cacheMaintenanceError = workerFailureCode(error);
      console.error(`Cache maintenance paused: ${cacheMaintenanceError}`);
    })
    .finally(() => {
      cacheRunning = false;
    });
  return cacheTask;
}
