import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout } from "node:timers";

import { RigCodexServer } from "./rig-codex-server.mjs";

test("concurrent turns keep outputs separate and persist before completion even when notifications precede responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saqi-server-test-"));
  const script = join(directory, "fake.mjs");
  await writeFile(
    script,
    `
import { createInterface } from "node:readline";
let sequence = 0;
function send(message) { console.log(JSON.stringify(message)); }
createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === "thread/start") {
    if (m.params.model !== "gpt-6.1-sol" || m.params.config.model_reasoning_effort !== "xhigh" || m.params.serviceTier !== "default" || !m.params.ephemeral) throw new Error("configuration");
    send({id:m.id,result:{thread:{id:"thread-" + ++sequence},model:"gpt-6.1-sol",reasoningEffort:"xhigh",serviceTier:sequence === 1 ? null : "default"}});
  } else if (m.method === "turn/start") {
    if (m.params.serviceTierForTurn !== "default") throw new Error("turn-tier");
    const threadId = m.params.threadId;
    const text = JSON.stringify({value:m.params.input[0].text});
    setTimeout(() => {
      send({method:"item/agentMessage/delta",params:{threadId,delta:text}});
      send({method:"thread/tokenUsage/updated",params:{threadId,tokenUsage:{total:{inputTokens:20,outputTokens:10}}}});
      send({method:"item/completed",params:{threadId,item:{type:"agentMessage",phase:"final_answer",text}}});
      send({method:"turn/completed",params:{threadId,turn:{status:"completed"}}});
      send({id:m.id,result:{turn:{id:"turn-1"}}});
    },threadId === "thread-1" ? 30 : 5);
  } else send({id:m.id,result:{}});
});
`,
  );
  const server = new RigCodexServer(process.execPath, [script]);
  try {
    await server.initialize();
    const saved = [];
    const results = await Promise.all(
      ["one", "two"].map((prompt) =>
        server.generate(prompt, {}, async (text) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          saved.push(JSON.parse(text).value);
        }),
      ),
    );
    assert.deepEqual(saved.toSorted(), ["one", "two"]);
    assert.equal(results.length, 2);
    assert.equal(results[0].usage.inputTokens, 20);
    assert.ok(results.every((result) => result.outputBytes > 0));
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a server disconnect rejects every pending turn instead of hanging or retrying inference", async () => {
  const server = new RigCodexServer(process.execPath, [
    "-e",
    "process.stdin.resume(); setTimeout(()=>process.exit(1),100)",
  ]);
  try {
    await assert.rejects(server.call("initialize", {}), /CODEX_SERVER_EXITED/u);
    await assert.rejects(
      server.call("thread/start", {}),
      /CODEX_SERVER_EXITED/u,
    );
  } finally {
    server.close();
  }
});

test("a Fast configuration is rejected before starting paid inference", async () => {
  const server = new RigCodexServer(process.execPath, [
    "-e",
    `
    const readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(!m.id) return;
      if(m.method==='turn/start') throw new Error('inference must not start');
      console.log(JSON.stringify({id:m.id,result:m.method==='thread/start'?{thread:{id:'wrong-tier'},model:'gpt-6.1-sol',reasoningEffort:'xhigh',serviceTier:'priority'}:{}}));
    });
  `,
  ]);
  try {
    await server.initialize();
    await assert.rejects(
      server.generate("test", {}, async () => {
        assert.fail("Fast configuration must not produce output");
      }),
      /CODEX_MODEL_CONFIGURATION_MISMATCH/u,
    );
  } finally {
    server.close();
  }
});
