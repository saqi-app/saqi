import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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
        { mode: 0o700 },
      );
      const states = new Map();
      let dispatches = 0;
      let publications = 0;
      let claims = 0;
      let scheduling = 0;
      let peakScheduling = 0;
      let failedPurge = false;
      let cacheCalls = 0;
      const cachePublications = [];
      const cacheRecovered = Promise.withResolvers();
      const ready = Promise.withResolvers();
      const http = createServer(async (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "GET") {
          const poemId = new URL(
            request.url,
            "http://localhost",
          ).searchParams.get("poemId");
          response.end(
            JSON.stringify({ ok: true, state: states.get(poemId) ?? null }),
          );
          return;
        }
        const body = JSON.parse(
          Buffer.concat(await Array.fromAsync(request)).toString(),
        );
        let state = states.get(body.poemId);
        switch (body.action) {
          case "purge-cache": {
            cacheCalls += 1;
            cachePublications.push(publications);
            if (!failedPurge) {
              failedPurge = true;
              response.statusCode = 503;
              response.end(
                JSON.stringify({
                  ok: false,
                  code: "TEST_TRANSIENT_QUEUE_ERROR",
                }),
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
              "Queue setup must remain bounded to two lanes",
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
              }),
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
      const watcher = watch(directory, (_event, name) => {
        if (name === "all-turns-1") allTurns.resolve();
        if (name === "all-turns-2") secondWave.resolve();
      });
      const child = spawn(
        process.execPath,
        [new URL("rig-pool.mjs", import.meta.url).pathname],
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
        },
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
        const running = JSON.parse(
          await readFile(join(directory, "pool-health.json"), "utf8"),
        );
        assert.equal(running.activePoems.length, concurrency);
        assert.equal(running.setupConcurrency, 2);
        assert.equal(
          peakScheduling,
          2,
          "A slow source must not block the other setup lane",
        );
        assert.ok(
          running.activePoems.every((poem) => poem.serviceTier === "default"),
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
        assert.equal(scheduling, 0);
        assert.equal(failedPurge, true);
        assert.ok(
          cacheCalls <= (waves === 2 ? 4 : 3),
          "Cache maintenance must be independent of poem throughput",
        );
        assert.equal(cachePublications.at(-1), concurrency * waves);
        const health = JSON.parse(
          await readFile(join(directory, "pool-health.json"), "utf8"),
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
    },
  );
}
