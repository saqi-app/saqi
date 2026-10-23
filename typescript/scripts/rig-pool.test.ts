import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { rigPoolHealth } from "./rig-pool-health.ts";

test("health snapshots serialize writes and keep all callers until the newest requested state is durable", async () => {
  const firstStarted = Promise.withResolvers();
  const latestStarted = Promise.withResolvers();
  const firstWrite = Promise.withResolvers();
  const latestWrite = Promise.withResolvers();
  const written = [];
  let value = "first";
  let durable;
  let active = 0;
  const snapshot = rigPoolHealth(async () => {
    assert.equal(active++, 0, "Health writes must never overlap");
    const captured = value;
    written.push(captured);
    const first = written.length === 1;
    (first ? firstStarted : latestStarted).resolve();
    await (first ? firstWrite : latestWrite).promise;
    durable = captured;
    active -= 1;
  });
  const first = snapshot();
  await firstStarted.promise;
  value = "superseded";
  const second = snapshot();
  value = "latest";
  const third = snapshot();
  let settled = 0;
  const completed = [first, second, third].map(async (task) => {
    await task;
    assert.equal(durable, "latest");
    settled += 1;
  });
  assert.deepEqual(written, ["first"]);
  firstWrite.resolve();
  await latestStarted.promise;
  assert.deepEqual(written, ["first", "latest"]);
  assert.equal(settled, 0, "No caller may resume after only the older write");
  assert.equal(durable, "first");
  latestWrite.resolve();
  await Promise.all(completed);
  assert.equal(settled, 3);
  assert.equal(durable, "latest");
  assert.equal(active, 0);
});

for (const synchronous of [false, true]) {
  test(`a ${synchronous ? "synchronous" : "rejected"} health write failure reaches shared callers and a later snapshot can recover`, async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const failure = new Error("HEALTH_WRITE_FAILED");
    let attempts = 0;
    let value = "first";
    let durable;
    const snapshot = rigPoolHealth(() => {
      attempts += 1;
      if (attempts === 1) {
        entered.resolve();
        if (synchronous) throw failure;
        return release.promise;
      }
      durable = value;
    });
    const first = snapshot();
    value = "newer";
    const second = snapshot();
    const results = Promise.allSettled([first, second]);
    await entered.promise;
    if (!synchronous) release.reject(failure);
    for (const result of await results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason, failure);
    }
    assert.equal(attempts, 1, "A failed health write must not retry silently");
    assert.equal(durable, undefined);
    value = "recovered";
    await snapshot();
    assert.equal(attempts, 2);
    assert.equal(durable, "recovered");
  });
}

for (const concurrency of [20, 40, 80]) {
  test(
    `${concurrency} pool workers publish distinct poems and SIGTERM drains without another claim`,
    { timeout: 45_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "saqi-pool-test-"));
      await writeFile(
        join(directory, "codex"),
        String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
let sequence=0;
let turns=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if (!m.id) return;
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-'+ ++sequence},model:'gpt-6.1-sol',reasoningEffort:'xhigh',serviceTier:m.params.serviceTier}});
 else if(m.method==='turn/start') {
  if(m.params.serviceTierForTurn!=='default') throw new Error('Standard tier missing');
  const width=Number(process.env.SAQI_RIG_CONCURRENCY);
  const wave=Math.floor(turns++/width)+1;
  if (turns%width===0) fs.writeFileSync(path.join(__dirname,'all-turns-'+wave),'ready');
  send({id:m.id,result:{turn:{id:'turn'}}});
  const release=setInterval(()=>{
   if (!fs.existsSync(path.join(__dirname,'release-'+wave))) return;
   clearInterval(release);
   const threadId=m.params.threadId;
   send({method:'item/completed',params:{threadId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({translation:{lines:['A verse']},wordMeanings:{line_1:['verse']}})}}});
   send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
  },10);
 } else send({id:m.id,result:{}});
});
`,
        { mode: 0o700 }
      );
      const states = new Map();
      let dispatches = 0;
      let publications = 0;
      let claims = 0;
      let scheduling = 0;
      let peakScheduling = 0;
      let failedPurge = false;
      const cacheTimes = [];
      const cachePublications = [];
      const cacheRecovered = Promise.withResolvers();
      const ready = Promise.withResolvers();
      const http = createServer(async (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "GET") {
          const poemId = new URL(
            request.url,
            "http://localhost"
          ).searchParams.get("poemId");
          response.end(
            JSON.stringify({ ok: true, state: states.get(poemId) ?? null })
          );
          return;
        }
        const body = JSON.parse(
          Buffer.concat(await Array.fromAsync(request)).toString()
        );
        let state = states.get(body.poemId);
        switch (body.action) {
          case "purge-cache": {
            cacheTimes.push(performance.now());
            cachePublications.push(publications);
            if (!failedPurge) {
              failedPurge = true;
              response.statusCode = 503;
              response.end(
                JSON.stringify({
                  ok: false,
                  code: "TEST_TRANSIENT_QUEUE_ERROR",
                })
              );
              return;
            }
            cacheRecovered.resolve();
            break;
          }
          case "claim-poem": {
            scheduling += 1;
            peakScheduling = Math.max(peakScheduling, scheduling);
            assert.ok(
              scheduling <= 2,
              "Queue setup must remain bounded to two lanes"
            );
            assert.equal(body.maxConcurrent, concurrency);
            claims += 1;
            state = {
              poemId: `poem-${String(claims)}`,
              status: "claimed",
              version: 1,
            };
            states.set(state.poemId, state);

            break;
          }
          case "source": {
            await delay(350);
            response.end(
              JSON.stringify({
                ok: true,
                poem: {
                  authorName: "شاعر",
                  titleArabic: "بيت",
                  linesArabic: ["بيت"],
                  required: ["translation", "wordMeanings"],
                },
              })
            );
            return;
          }
          case "dispatch": {
            scheduling -= 1;
            assert.equal(body.reasoningEffort, "xhigh");
            state.status = "dispatching";
            state.version = 2;
            state.attemptId = body.attemptId;
            dispatches += 1;
            if (dispatches === concurrency) ready.resolve();

            break;
          }
          case "acknowledge": {
            assert.equal(body.attemptId, state.attemptId);
            assert.equal(body.expectedVersion, 2);
            assert.deepEqual(body.output, {
              translation: { lines: ["A verse"] },
              wordMeanings: [["verse"]],
            });
            state.status = "claimed";
            state.version = 3;

            break;
          }
          case "publish": {
            assert.equal(body.deferCachePurge, true);
            assert.equal(body.expectedVersion, 3);
            state.status = "complete";
            state.version = 4;
            publications += 1;

            break;
          }
          // No default
        }
        response.end(JSON.stringify({ ok: true, state: state ?? null }));
      });
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const allTurns = Promise.withResolvers();
      const secondWave = Promise.withResolvers();
      // eslint-disable-next-line n/prefer-promises/fs -- Arm the callback watcher before process startup and close it synchronously during fixture teardown.
      const watcher = watch(directory, (_event, name) => {
        if (name === "all-turns-1") allTurns.resolve();
        if (name === "all-turns-2") secondWave.resolve();
      });
      const child = spawn(
        process.execPath,
        [new URL("rig-pool.ts", import.meta.url).pathname],
        {
          env: {
            ...process.env,
            PATH: directory + delimiter + process.env.PATH,
            CF_ACCESS_CLIENT_ID: "test",
            CF_ACCESS_CLIENT_SECRET: "test",
            SAQI_RIG_ACTIVE: "1",
            SAQI_RIG_CONCURRENCY: String(concurrency),
            SAQI_RIG_RESULT_DIR: directory,
            SAQI_RIG_ENDPOINT: `http://127.0.0.1:${http.address().port}/rig`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let diagnostic = "";
      const draining = Promise.withResolvers();
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("Pool draining;")) draining.resolve();
      });
      child.stderr.on("data", (chunk) => {
        diagnostic += chunk;
      });
      try {
        await ready.promise;
        await allTurns.promise;
        assert.equal(publications, 0);
        for (const state of states.values()) {
          await access(
            join(directory, `saqi-rig-${state.attemptId}.json.pending`)
          );
        }
        const running = JSON.parse(
          await readFile(join(directory, "pool-health.json"), "utf8")
        );
        assert.equal(running.activePoems.length, concurrency);
        assert.equal(running.setupConcurrency, 2);
        assert.equal(
          peakScheduling,
          2,
          "A slow source must not block the other setup lane"
        );
        assert.ok(
          running.activePoems.every((poem) => poem.serviceTier === "default")
        );
        const waves = concurrency === 20 ? 2 : 1;
        if (waves === 2) {
          await cacheRecovered.promise;
          await writeFile(join(directory, "release-1"), "ready");
          await secondWave.promise;
          assert.equal(publications, concurrency);
          assert.equal(claims, concurrency * 2);
          assert.equal(peakScheduling, 2);
        }
        child.kill("SIGTERM");
        await draining.promise;
        await writeFile(join(directory, `release-${waves}`), "ready");
        const [code] = await once(child, "exit");
        assert.equal(code, 0, diagnostic);
        assert.equal(claims, concurrency * waves);
        assert.equal(publications, concurrency * waves);
        for (const state of states.values()) {
          await assert.rejects(
            access(join(directory, `saqi-rig-${state.attemptId}.json.pending`)),
            { code: "ENOENT" }
          );
        }
        assert.equal(scheduling, 0);
        assert.equal(failedPurge, true);
        // The final drain purges immediately. Periodic calls must remain
        // independent of poem throughput even when a slow host spans more ticks.
        const periodicTimes = cacheTimes.slice(0, -1);
        for (let index = 1; index < periodicTimes.length; index += 1) {
          assert.ok(
            periodicTimes[index] - periodicTimes[index - 1] >= 14_000,
            "Cache maintenance must be independent of poem throughput"
          );
        }
        assert.equal(cachePublications.at(-1), concurrency * waves);
        const health = JSON.parse(
          await readFile(join(directory, "pool-health.json"), "utf8")
        );
        assert.equal(health.stopping, true);
        assert.equal(health.activePoems.length, 0);
        assert.equal(health.pausedWorkers.length, 0);
      } finally {
        watcher.close();
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}

test(
  "a worker ticket failure drains another paid turn before closing the shared server",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "saqi-pool-drain-"));
    const ticket = join(directory, "worker-2.json");
    const fifo = spawn("mkfifo", [ticket], { stdio: "ignore" });
    const [fifoCode] = await once(fifo, "close");
    assert.equal(fifoCode, 0);
    await writeFile(
      join(directory, "codex"),
      String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let release;
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'thread/start') {
    send({id:m.id,result:{thread:{id:'paid-thread'},model:'gpt-6.1-sol',reasoningEffort:'xhigh',serviceTier:'default'}});
  } else if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'paid-turn'}}});
    fs.writeFileSync(path.join(__dirname, 'paid-started'), 'ready');
    release = setInterval(() => {
      if (!fs.existsSync(path.join(__dirname, 'release-paid'))) return;
      clearInterval(release);
      const threadId = m.params.threadId;
      send({method:'item/completed',params:{threadId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({translation:{lines:['Saved verse']},wordMeanings:{line_1:['verse']}})}}});
      send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
    }, 10);
  } else send({id:m.id,result:{}});
});
process.stdin.on('end', () => {
  clearInterval(release);
  fs.writeFileSync(path.join(__dirname, 'stdin-ended'), 'closed');
});
`,
      { mode: 0o700 }
    );
    let state;
    let claims = 0;
    let publications = 0;
    const cachePublications = [];
    const http = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify({ ok: true, state: state ?? null }));
        return;
      }
      const body = JSON.parse(
        Buffer.concat(await Array.fromAsync(request)).toString()
      );
      switch (body.action) {
        case "purge-cache":
          cachePublications.push(publications);
          break;
        case "claim-poem":
          claims += 1;
          state = { poemId: "paid-poem", status: "claimed", version: 1 };
          break;
        case "source":
          response.end(
            JSON.stringify({
              ok: true,
              poem: {
                authorName: "شاعر",
                titleArabic: "بيت",
                linesArabic: ["بيت"],
              },
            })
          );
          return;
        case "dispatch":
          state = {
            ...state,
            status: "dispatching",
            version: 2,
            attemptId: body.attemptId,
          };
          break;
        case "acknowledge": {
          const saved = JSON.parse(
            await readFile(
              join(directory, `saqi-rig-${state.attemptId}.json`),
              "utf8"
            )
          );
          assert.deepEqual(saved.translation, { lines: ["Saved verse"] });
          assert.deepEqual(body.output, {
            translation: { lines: ["Saved verse"] },
            wordMeanings: [["verse"]],
          });
          state = { ...state, status: "claimed", version: 3 };
          break;
        }
        case "publish":
          assert.equal(body.deferCachePurge, true);
          state = { ...state, status: "complete", version: 4 };
          publications += 1;
          break;
        // No default
      }
      response.end(JSON.stringify({ ok: true, state: state ?? null }));
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const started = Promise.withResolvers();
    const draining = Promise.withResolvers();
    // eslint-disable-next-line n/prefer-promises/fs -- Arm the callback watcher before process startup and close it synchronously during fixture teardown.
    const watcher = watch(directory, (_event, name) => {
      if (name === "paid-started") started.resolve();
    });
    const child = spawn(
      process.execPath,
      [new URL("rig-pool.ts", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          PATH: directory + delimiter + process.env.PATH,
          CF_ACCESS_CLIENT_ID: "test",
          CF_ACCESS_CLIENT_SECRET: "test",
          SAQI_RIG_ACTIVE: "1",
          SAQI_RIG_CONCURRENCY: "2",
          SAQI_RIG_RESULT_DIR: directory,
          SAQI_RIG_ENDPOINT: `http://127.0.0.1:${http.address().port}/rig`,
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );
    const exited = once(child, "close");
    exited.catch(() => {
      /* The test and cleanup own spawn failures. */
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk;
      if (diagnostic.includes("pool draining:")) draining.resolve();
    });
    try {
      await Promise.race([
        started.promise,
        exited.then(() => assert.fail(diagnostic)),
      ]);
      await writeFile(ticket, "{");
      await Promise.race([
        draining.promise,
        exited.then(() => assert.fail(diagnostic)),
      ]);
      assert.equal(child.exitCode, null);
      assert.equal(claims, 1);
      assert.equal(publications, 0);
      await assert.rejects(access(join(directory, "stdin-ended")), {
        code: "ENOENT",
      });
      await writeFile(join(directory, "release-paid"), "ready");
      const [code] = await exited;
      assert.equal(code, 1, diagnostic);
      assert.equal(claims, 1);
      assert.equal(publications, 1);
      assert.equal(cachePublications.at(-1), 1);
      const preservedTicket = await lstat(ticket);
      assert.equal(
        preservedTicket.isFIFO(),
        true,
        "The invalid recovery ticket must not be deleted or replaced"
      );
      const health = JSON.parse(
        await readFile(join(directory, "pool-health.json"), "utf8")
      );
      assert.equal(health.stopping, true);
      assert.equal(health.activePoems.length, 0);
      assert.equal(health.pausedWorkers.length, 1);
      assert.equal(health.pausedWorkers[0].worker, 2);
    } finally {
      watcher.close();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
