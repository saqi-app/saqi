import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const script = new URL("rig-lite.mjs", import.meta.url);
const localScript = new URL("rig-local.mjs", import.meta.url);

test(
  "killing the runner before acknowledgement recovers the exact result without another invocation",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "saqi-rig-crash-"));
    const callsPath = join(directory, "calls");
    const output = {
      translation: { lines: ["Recovered English"] },
      wordMeanings: [["line"]],
    };
    await writeFile(
      join(directory, "codex"),
      String.raw`#!/usr/bin/env node
{
const fs = require("node:fs");
require("node:assert/strict").equal(process.argv[process.argv.indexOf("--model") + 1], "gpt-6.1-sol");
require("node:assert/strict").ok(process.argv.includes('model_reasoning_effort="xhigh"'));
require("node:assert/strict").ok(process.argv.includes('service_tier="default"'));
process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,cached_input_tokens:40,output_tokens:200}}) + "\n");
fs.appendFileSync(process.env.SAQI_TEST_CALLS, "call\n");
fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], ${JSON.stringify(JSON.stringify({ ...output, wordMeanings: { line_1: ["line"] } }))});
process.stdin.resume();
}
`,
      { mode: 0o700 },
    );
    let state = null;
    let attemptId;
    let acknowledgeCount = 0;
    let publishCount = 0;
    const reachedAcknowledgement = Promise.withResolvers();
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify({ ok: true, state }));
        return;
      }
      const body = JSON.parse(
        Buffer.concat(await Array.fromAsync(request)).toString("utf8"),
      );
      switch (body.action) {
        case "claim-poem":
          state = { poemId: "crash-poem", status: "claimed", version: 1 };
          break;
        case "source":
          response.end(
            JSON.stringify({
              ok: true,
              poem: {
                authorName: "Author",
                titleArabic: "عنوان",
                linesArabic: ["سطر"],
              },
            }),
          );
          return;
        case "dispatch":
          assert.equal(body.reasoningEffort, "xhigh");
          attemptId = body.attemptId;
          state = {
            poemId: "crash-poem",
            status: "dispatching",
            version: 2,
            checkpointJson: JSON.stringify({ invocation: { attemptId } }),
          };
          break;
        case "acknowledge":
          acknowledgeCount += 1;
          assert.equal(body.attemptId, attemptId);
          assert.equal(body.expectedVersion, 2);
          assert.deepEqual(body.output, output);
          if (acknowledgeCount === 1) {
            reachedAcknowledgement.resolve();
            return;
          }
          state = { poemId: "crash-poem", status: "claimed", version: 3 };
          break;
        case "publish":
          assert.equal(body.expectedVersion, 3);
          publishCount += 1;
          state = null;
          break;
      }
      response.end(JSON.stringify({ ok: true, state, cachePending: false }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const environment = {
      CF_ACCESS_CLIENT_ID: "test-id",
      CF_ACCESS_CLIENT_SECRET: "test-secret",
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      SAQI_TEST_CALLS: callsPath,
      SAQI_RIG_RESULT_DIR: directory,
      SAQI_RIG_ACTIVE: "1",
      SAQI_RIG_ENDPOINT: `http://127.0.0.1:${server.address().port}/rig`,
    };
    const child = spawn(process.execPath, [script.pathname], {
      env: { ...process.env, ...environment },
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    try {
      await reachedAcknowledgement.promise;
      child.kill("SIGKILL");
      await exited;
      const result = await runScript(environment);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(acknowledgeCount, 2);
      assert.equal(publishCount, 1);
      assert.equal(await readFile(callsPath, "utf8"), "call\n");
      await assert.rejects(
        access(join(directory, `saqi-rig-${attemptId}.json`)),
        { code: "ENOENT" },
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (attemptId)
        await rm(join(tmpdir(), `saqi-rig-${attemptId}.json`), { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a durable Codex result is acknowledged and published after restart without another call", async () => {
  const attemptId = randomUUID();
  const outputPath = join(tmpdir(), `saqi-rig-${attemptId}.json`);
  const output = {
    translation: { lines: ["A translated line"] },
    wordMeanings: [["line"]],
  };
  await writeFile(outputPath, JSON.stringify(output));
  try {
    const run = await exerciseUnknown(attemptId);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.actions, ["purge-cache", "acknowledge", "publish"]);
    assert.equal(run.codexCalled, false);
    await assert.rejects(access(outputPath), { code: "ENOENT" });
  } finally {
    await rm(outputPath, { force: true });
  }
});

test("an unknown Codex outcome without a result leaves that poem unresolved and checks other work", async () => {
  const attemptId = randomUUID();
  const run = await exerciseUnknown(attemptId);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /remains unresolved/u);
  assert.deepEqual(run.actions, ["purge-cache", "claim-poem"]);
  assert.equal(run.codexCalled, false);
});

test("the Keychain-backed entrypoint leaves the unknown poem untouched", async () => {
  const run = await exerciseUnknown(randomUUID(), localScript, ["translate"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.actions, ["purge-cache", "claim-poem"]);
  assert.equal(run.codexCalled, false);
});

test("manual retry reads the exact unknown poem when another unknown is older", async () => {
  const attemptId = randomUUID();
  const requests = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      const poemId = new URL(request.url, "http://localhost").searchParams.get(
        "poemId",
      );
      requests.push({ method: "GET", poemId });
      response.end(
        JSON.stringify({
          ok: true,
          state:
            poemId === "target-poem"
              ? {
                  poemId,
                  status: "unknown",
                  version: 4,
                  checkpointJson: JSON.stringify({ invocation: { attemptId } }),
                }
              : { poemId: "older-poem", status: "unknown", version: 2 },
        }),
      );
      return;
    }
    const body = JSON.parse(
      Buffer.concat(await Array.fromAsync(request)).toString("utf8"),
    );
    requests.push(body);
    response.end(JSON.stringify({ ok: true, state: null }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const run = await runScript(
      {
        CF_ACCESS_CLIENT_ID: "test-id",
        CF_ACCESS_CLIENT_SECRET: "test-secret",
        SAQI_RIG_ENDPOINT: `http://127.0.0.1:${server.address().port}/rig`,
      },
      script,
      ["retry-unknown", "target-poem", attemptId],
    );
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(requests, [
      { method: "GET", poemId: "target-poem" },
      {
        action: "retry-unknown",
        poemId: "target-poem",
        attemptId,
        expectedVersion: 4,
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a targeted smoke run sends only the requested poem ID to the D1 claim", async () => {
  const actions = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ ok: true, state: null }));
      return;
    }
    const chunks = await Array.fromAsync(request);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    actions.push(body);
    response.end(JSON.stringify({ ok: true, state: null }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address()?.port;
    const run = await runScript(
      {
        CF_ACCESS_CLIENT_ID: "test-id",
        CF_ACCESS_CLIENT_SECRET: "test-secret",
        SAQI_RIG_ACTIVE: "1",
        SAQI_RIG_ENDPOINT: `http://127.0.0.1:${port}/rig`,
      },
      script,
      ["poem-2"],
    );
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      actions.map((item) => item.action),
      ["purge-cache", "claim-poem"],
    );
    assert.equal(actions[1].poemId, "poem-2");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function exerciseUnknown(
  attemptId,
  entry = script,
  args = [],
  initialStatus = "unknown",
) {
  const directory = await mkdtemp(join(tmpdir(), "saqi-rig-test-"));
  const markerPath = join(directory, "codex-called");
  const fakeCodex = join(directory, "codex");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node\n{ require("node:fs").writeFileSync(process.env.SAQI_TEST_CODEX_MARKER, "called"); process.exit(97); }\n`,
    { mode: 0o700 },
  );
  const actions = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      if (args[0] === "recover-attempt") {
        const query = new URL(request.url, "http://localhost").searchParams;
        assert.equal(query.get("attemptId"), attemptId);
        assert.equal(query.get("poemId"), null);
      }
      response.end(
        JSON.stringify({
          ok: true,
          state: {
            poemId: "poem-1",
            status: initialStatus,
            leaseExpiresAt: 0,
            version: 2,
            checkpointJson: JSON.stringify({ invocation: { attemptId } }),
          },
        }),
      );
      return;
    }
    const chunks = await Array.fromAsync(request);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    actions.push(body.action);
    if (body.action === "acknowledge") {
      assert.equal(body.attemptId, attemptId);
      assert.equal(body.expectedVersion, 2);
      response.end(
        JSON.stringify({
          ok: true,
          state: { poemId: "poem-1", status: "claimed", version: 3 },
        }),
      );
      return;
    }
    if (body.action === "publish") {
      assert.equal(body.expectedVersion, 3);
      if (args[0] === "recover-attempt")
        assert.equal(body.deferCachePurge, true);
      response.end(JSON.stringify({ ok: true, cachePending: false }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address()?.port;
    const result = await runScript(
      {
        CF_ACCESS_CLIENT_ID: "test-id",
        CF_ACCESS_CLIENT_SECRET: "test-secret",
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        SAQI_RIG_ACTIVE: "1",
        SAQI_RIG_ENDPOINT: `http://127.0.0.1:${port}/rig`,
        SAQI_TEST_CODEX_MARKER: markerPath,
      },
      entry,
      args,
    );
    let codexCalled = true;
    try {
      await access(markerPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      codexCalled = false;
    }
    return { ...result, actions, codexCalled };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function runScript(environment, entry = script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry.pathname, ...args], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("new work is claimed without a quota check while unresolved work stays fenced", async () => {
  const run = await exerciseUnknown(randomUUID());
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.actions, ["purge-cache", "claim-poem"]);
  assert.equal(run.codexCalled, false);
});

test("truncated paid JSON stays preserved and fenced while other work is checked", async () => {
  const attemptId = randomUUID();
  const path = join(tmpdir(), `saqi-rig-${attemptId}.json`);
  const partial = '{"translation":{"lines":["A saved line"]},"wordMeanings":';
  await writeFile(path, partial);
  try {
    const run = await exerciseUnknown(attemptId);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.actions, ["purge-cache", "claim-poem"]);
    assert.equal(run.codexCalled, false);
    assert.equal(await readFile(path, "utf8"), partial);
    assert.match(run.stderr, /preserving the result for review/u);
  } finally {
    await rm(path, { force: true });
  }
});

test("an expired truncated invocation is marked unknown without deletion, publication, or regeneration", async () => {
  const attemptId = randomUUID();
  const path = join(tmpdir(), `saqi-rig-${attemptId}.json`);
  const partial = '{"translation":{"lines":["A saved line"]},"wordMeanings":';
  await writeFile(path, partial);
  try {
    const run = await exerciseUnknown(attemptId, script, [], "dispatching");
    assert.equal(run.code, 1);
    assert.deepEqual(run.actions, ["purge-cache", "mark-unknown"]);
    assert.equal(run.codexCalled, false);
    assert.equal(await readFile(path, "utf8"), partial);
  } finally {
    await rm(path, { force: true });
  }
});

test("recover-attempt publishes the exact saved unknown result with zero Codex calls", async () => {
  const attemptId = randomUUID();
  const path = join(tmpdir(), `saqi-rig-${attemptId}.json`);
  await writeFile(
    path,
    JSON.stringify({
      translation: { lines: ["A saved verse"] },
      wordMeanings: [["verse"]],
    }),
  );
  try {
    const run = await exerciseUnknown(attemptId, script, [
      "recover-attempt",
      attemptId,
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.actions, ["acknowledge", "publish"]);
    assert.equal(run.codexCalled, false);
    await assert.rejects(access(path), { code: "ENOENT" });
  } finally {
    await rm(path, { force: true });
  }
});

test("recover-attempt refuses an active dispatch and preserves the saved file", async () => {
  const attemptId = randomUUID();
  const path = join(tmpdir(), `saqi-rig-${attemptId}.json`);
  const saved = JSON.stringify({
    translation: { lines: ["A saved verse"] },
    wordMeanings: [["verse"]],
  });
  await writeFile(path, saved);
  try {
    const run = await exerciseUnknown(
      attemptId,
      script,
      ["recover-attempt", attemptId],
      "dispatching",
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /SAVED_ATTEMPT_NOT_UNKNOWN/u);
    assert.deepEqual(run.actions, []);
    assert.equal(run.codexCalled, false);
    assert.equal(await readFile(path, "utf8"), saved);
  } finally {
    await rm(path, { force: true });
  }
});
