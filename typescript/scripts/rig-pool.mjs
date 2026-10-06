import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

import { RigCodexServer } from "./rig-codex-server.mjs";
import { translateNext } from "./rig-lite.mjs";
import { generationSchema, normalizeWordMeanings } from "./rig-output.mjs";

const concurrency = Number(process.env.SAQI_RIG_CONCURRENCY ?? 20);
if (!Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 20)
  throw new Error("INVALID_POOL_CONCURRENCY");
const directory =
  process.env.SAQI_RIG_RESULT_DIR ??
  join(homedir(), ".local", "state", "saqi", "results");
await mkdir(directory, { recursive: true, mode: 0o700 });
const template = JSON.parse(
  await readFile(
    new URL("rig-publication-output.schema.json", import.meta.url),
    "utf8",
  ),
);
const active = new Map();
const paused = new Map();
const sampledWindows = new Set();
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  process.stdout.write("Pool draining; no new poems will be claimed.\n");
});
process.on("SIGINT", () => {
  stopping = true;
});
const server = new RigCodexServer();
await server.initialize();
process.stdout.write(
  `Translation pool started: ${concurrency} workers; gpt-6.1-sol xhigh; standard speed.\n`,
);
const health = setInterval(
  () =>
    snapshot().catch(() => {
      stopping = true;
    }),
  10_000,
);
let serverFailed = false;
try {
  await Promise.all(
    Array.from({ length: concurrency }, (_, index) => worker(index + 1)),
  );
} finally {
  clearInterval(health);
  serverFailed = !server.alive;
  server.close();
  await snapshot();
}
if (serverFailed) process.exitCode = 1;

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

async function snapshot() {
  await durableWrite(
    join(directory, "pool-health.json"),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      concurrency,
      stopping,
      activePoems: active.values().toArray(),
      pausedWorkers: paused.values().toArray(),
    }),
  );
}

async function worker(id) {
  const ticket = join(directory, `worker-${id}.json`);
  let ownedPoemId;
  try {
    ownedPoemId = JSON.parse(await readFile(ticket, "utf8")).poemId;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await delay((id - 1) * 250);
  while (!stopping && server.alive) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Each worker persists and publishes its current poem before claiming another.
      await translateNext(undefined, {
        maxConcurrent: concurrency,
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
          const outputPath = join(directory, `saqi-rig-${attemptId}.json`);
          await writeFile(outputPath, "", { mode: 0o600, flag: "wx" });
          active.set(id, {
            worker: id,
            poemId: ownedPoemId,
            arabicLines: lines.length,
            model: "gpt-6.1-sol",
            reasoningEffort: "xhigh",
            startedAt: new Date().toISOString(),
          });
          await snapshot();
          try {
            const metrics = await server.generate(
              prompt,
              generationSchema(template, lines, required),
              (text) => durableWrite(outputPath, text),
            );
            const usage = metrics.usage;
            process.stdout.write(
              `Codex usage: ${JSON.stringify(usage ? { input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens, output_tokens: usage.outputTokens, reasoning_output_tokens: usage.reasoningOutputTokens } : {})}\n`,
            );
            process.stdout.write(
              `Codex timing: ${JSON.stringify({ worker: id, poemId: ownedPoemId, ...metrics, usage: undefined })}\n`,
            );
            const output = normalizeWordMeanings(
              JSON.parse(await readFile(outputPath, "utf8")),
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
                  linesArabic: lines,
                  output,
                }),
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
      paused.set(id, {
        worker: id,
        poemId: ownedPoemId,
        code:
          error.message?.match(/^[A-Z_0-9]+$/u)?.[0] ??
          "TRANSLATION_REQUIRES_RECOVERY",
        checkedAt: new Date().toISOString(),
      });
      if (!server.alive) stopping = true;
      console.error(
        `Worker ${id} paused: ${error.message?.match(/^[A-Z_0-9]+$/u)?.[0] ?? "TRANSLATION_REQUIRES_RECOVERY"}`,
      );
    }
    // eslint-disable-next-line no-await-in-loop -- Backoff is per worker and must not create overlapping invocations.
    await delay(5_000);
  }
}
