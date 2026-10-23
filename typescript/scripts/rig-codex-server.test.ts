import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout } from "node:timers";

import { RigCodexServer } from "./rig-codex-server.ts";

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
`
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
        })
      )
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
      /CODEX_SERVER_EXITED/u
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
      /CODEX_MODEL_CONFIGURATION_MISMATCH/u
    );
  } finally {
    server.close();
  }
});

async function protocolFixture(context, turnBody) {
  const directory = await mkdtemp(join(tmpdir(), "saqi-server-lifecycle-"));
  const script = join(directory, "fake.mjs");
  await writeFile(
    script,
    String.raw`
import { createInterface } from "node:readline";
let sequence = 0;
let release = () => {};
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const final = (m, text, status = "completed") => {
  send({method:"item/completed",params:{threadId:m.params.threadId,item:{type:"agentMessage",phase:"final_answer",text}}});
  send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{status}}});
};
createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "test/release") return release();
  if (m.method === "test/disconnect") return process.exit(1);
  if (!m.id) return;
  if (m.method === "thread/start") {
    send({id:m.id,result:{thread:{id:"thread-" + ++sequence},model:"gpt-6.1-sol",reasoningEffort:"xhigh",serviceTier:"default"}});
  } else if (m.method === "turn/start") {
    ${turnBody}
  } else send({id:m.id,result:{}});
});
`
  );
  const server = new RigCodexServer(process.execPath, [script]);
  const closed = once(server.child, "close");
  closed.catch(() => {
    /* Cleanup still owns child spawn/exit failures. */
  });
  const calls = [];
  const started = Promise.withResolvers();
  const startTimedOut = Promise.withResolvers();
  const operations = [];
  const call = server.call.bind(server);
  server.call = (method, ...args) => {
    const pending = call(method, ...args);
    calls.push(method);
    if (method === "turn/start") {
      started.resolve();
      pending.catch((error) => {
        if (error.message === "CODEX_REQUEST_TIMEOUT") startTimedOut.resolve();
      });
    }
    return pending;
  };
  context.after(async () => {
    server.close();
    try {
      await Promise.allSettled(operations);
      await closed;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await server.initialize();
  return {
    server,
    directory,
    calls,
    started: started.promise,
    startTimedOut: startTimedOut.promise,
    closed,
    track(promise) {
      operations.push(promise);
      promise.catch(() => {
        /* The test assertion owns the operation's rejection. */
      });
      return promise;
    },
  };
}

for (const olderSaveFails of [false, true]) {
  test(
    `final saves remain ordered when the older write ${olderSaveFails ? "fails" : "finishes"}`,
    { timeout: 10_000 },
    async (context) => {
      const fixture = await protocolFixture(
        context,
        `
send({id:m.id,result:{turn:{id:"turn"}}});
send({method:"item/completed",params:{threadId:m.params.threadId,item:{type:"agentMessage",phase:"final_answer",text:JSON.stringify({value:"older"})}}});
final(m, JSON.stringify({value:"latest"}));
`
      );
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const saves = [];
      const path = join(fixture.directory, "saved.json");
      let settled = false;
      const generated = fixture.track(
        fixture.server.generate("test", {}, async (text) => {
          const { value } = JSON.parse(text);
          saves.push(value);
          if (value === "older") {
            entered.resolve();
            await release.promise;
            if (olderSaveFails) throw new Error("OLDER_SAVE_FAILED");
          }
          await writeFile(path, text);
        })
      );
      generated
        .then(() => {
          settled = true;
        })
        .catch(() => {
          settled = true;
        });
      try {
        await entered.promise;
        await fixture.server.call("test/barrier", {});
        assert.deepEqual(saves, ["older"]);
        assert.equal(settled, false);
      } finally {
        release.resolve();
      }
      await generated;
      assert.deepEqual(saves, ["older", "latest"]);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        value: "latest",
      });
      assert.equal(fixture.server.turns.size, 0);
      assert.equal(fixture.server.pending.size, 0);
      assert.equal(
        fixture.calls.filter((method) => method === "thread/unsubscribe")
          .length,
        1
      );
    }
  );
}

test(
  "synchronous and asynchronous latest-save failures reject only their own turn",
  { timeout: 10_000 },
  async (context) => {
    const fixture = await protocolFixture(
      context,
      `
send({id:m.id,result:{turn:{id:"turn"}}});
final(m, JSON.stringify({value:m.params.input[0].text}));
`
    );
    for (const asynchronous of [false, true]) {
      const failure = new Error("FINAL_SAVE_FAILED");
      const generated = fixture.track(
        fixture.server.generate("failed", {}, () => {
          if (asynchronous) return Promise.reject(failure);
          throw failure;
        })
      );
      await assert.rejects(generated, (error) => error === failure);
      assert.equal(fixture.server.alive, true);
      assert.equal(fixture.server.turns.size, 0);
      assert.equal(fixture.server.pending.size, 0);
    }
    let saved;
    await fixture.track(
      fixture.server.generate("healthy", {}, (text) => {
        saved = JSON.parse(text);
      })
    );
    assert.deepEqual(saved, { value: "healthy" });
  }
);

test("a failed newer final never confirms the earlier saved final", async (context) => {
  const fixture = await protocolFixture(
    context,
    `
send({id:m.id,result:{turn:{id:"turn"}}});
send({method:"item/completed",params:{threadId:m.params.threadId,item:{type:"agentMessage",phase:"final_answer",text:JSON.stringify({value:"older"})}}});
final(m, JSON.stringify({value:"latest"}));
`
  );
  const path = join(fixture.directory, "saved.json");
  const generated = fixture.track(
    fixture.server.generate("test", {}, async (text) => {
      if (JSON.parse(text).value === "latest")
        throw new Error("LATEST_SAVE_FAILED");
      await writeFile(path, text);
    })
  );
  await assert.rejects(generated, /LATEST_SAVE_FAILED/u);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    value: "older",
  });
  assert.equal(fixture.server.turns.size, 0);
});

for (const disconnect of [false, true]) {
  test(
    `${disconnect ? "disconnect" : "failed terminal"} drains an already-started final save before rejecting`,
    { timeout: 10_000 },
    async (context) => {
      const fixture = await protocolFixture(
        context,
        `
send({id:m.id,result:{turn:{id:"turn"}}});
${
  disconnect
    ? 'send({method:"item/completed",params:{threadId:m.params.threadId,item:{type:"agentMessage",phase:"final_answer",text:"saved output"}}}); process.stdout.write("", () => process.exit(1));'
    : 'final(m, "saved output", "failed");'
}
`
      );
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      let settled = false;
      let saved;
      const generated = fixture.track(
        fixture.server.generate("test", {}, async (text) => {
          entered.resolve();
          await release.promise;
          saved = text;
        })
      );
      generated
        .then(() => {
          settled = true;
        })
        .catch(() => {
          settled = true;
        });
      try {
        await entered.promise;
        if (disconnect) await fixture.closed;
        else await fixture.server.call("test/barrier", {});
        assert.equal(settled, false);
      } finally {
        release.resolve();
      }
      await assert.rejects(
        generated,
        disconnect ? /CODEX_SERVER_EXITED/u : /CODEX_TURN_FAILED/u
      );
      assert.equal(saved, "saved output");
      assert.equal(fixture.server.turns.size, 0);
      assert.equal(fixture.server.pending.size, 0);
    }
  );
}

test(
  "an ambiguous turn-start timeout retains the worker and persists later output without replay",
  { timeout: 10_000 },
  async (context) => {
    const fixture = await protocolFixture(
      context,
      `
release = () => {
  final(m, JSON.stringify({value:"late paid output"}));
  send({id:m.id,result:{turn:{id:"late-response"}}});
};
`
    );
    const path = join(fixture.directory, "late.json");
    let settled = false;
    const generated = fixture.track(
      fixture.server.generate("test", {}, (text) => writeFile(path, text), {
        startTimeoutMs: 25,
      })
    );
    generated
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });
    await fixture.started;
    await fixture.startTimedOut;
    await fixture.server.call("test/barrier", {});
    assert.equal(settled, false);
    assert.equal(fixture.server.pending.size, 0);
    assert.equal(fixture.server.turns.size, 1);
    assert.equal(fixture.calls.includes("thread/unsubscribe"), false);
    fixture.server.send({ method: "test/release" });
    await generated;
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      value: "late paid output",
    });
    assert.equal(
      fixture.calls.filter((method) => method === "turn/start").length,
      1
    );
    assert.equal(
      fixture.calls.filter((method) => method === "thread/unsubscribe").length,
      1
    );
    assert.equal(fixture.server.turns.size, 0);
    assert.equal(fixture.server.pending.size, 0);
  }
);

test(
  "terminal output preceding an unanswered turn-start response survives its RPC timeout",
  { timeout: 10_000 },
  async (context) => {
    const fixture = await protocolFixture(
      context,
      'final(m, "already complete");'
    );
    let saved;
    await fixture.track(
      fixture.server.generate(
        "test",
        {},
        (text) => {
          saved = text;
        },
        { startTimeoutMs: 25 }
      )
    );
    assert.equal(saved, "already complete");
    assert.equal(
      fixture.calls.filter((method) => method === "turn/start").length,
      1
    );
    assert.equal(
      fixture.calls.filter((method) => method === "thread/unsubscribe").length,
      1
    );
    assert.equal(fixture.server.turns.size, 0);
    assert.equal(fixture.server.pending.size, 0);
  }
);

test(
  "a definitive turn-start rejection unsubscribes once without waiting for a terminal event",
  { timeout: 10_000 },
  async (context) => {
    const fixture = await protocolFixture(
      context,
      "send({id:m.id,error:{code:-32602}});"
    );
    await assert.rejects(
      fixture.track(
        fixture.server.generate("test", {}, () =>
          assert.fail("Rejected turn cannot save")
        )
      ),
      /CODEX_REQUEST_REJECTED_-32602/u
    );
    assert.equal(
      fixture.calls.filter((method) => method === "turn/start").length,
      1
    );
    assert.equal(
      fixture.calls.filter((method) => method === "thread/unsubscribe").length,
      1
    );
    assert.equal(fixture.server.turns.size, 0);
    assert.equal(fixture.server.pending.size, 0);
  }
);

test(
  "a disconnect after an ambiguous start rejects its retained turn without another invocation",
  { timeout: 10_000 },
  async (context) => {
    const fixture = await protocolFixture(
      context,
      "release = () => process.exit(1);"
    );
    const generated = fixture.track(
      fixture.server.generate(
        "test",
        {},
        () => assert.fail("No output received"),
        { startTimeoutMs: 25 }
      )
    );
    await fixture.started;
    await fixture.startTimedOut;
    assert.equal(fixture.server.turns.size, 1);
    fixture.server.send({ method: "test/release" });
    await assert.rejects(generated, /CODEX_SERVER_EXITED/u);
    assert.equal(
      fixture.calls.filter((method) => method === "turn/start").length,
      1
    );
    assert.equal(fixture.calls.includes("thread/unsubscribe"), false);
    assert.equal(fixture.server.turns.size, 0);
    assert.equal(fixture.server.pending.size, 0);
  }
);
