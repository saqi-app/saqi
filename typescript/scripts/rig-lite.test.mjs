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

test("killing the runner before acknowledgement recovers the exact result without another invocation", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "saqi-rig-crash-"));
  const callsPath = join(directory, "calls");
  const output = { translation: { lines: ["Recovered English"] } };
  await writeFile(join(directory, "codex"), String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.SAQI_TEST_CALLS, "call\n");
fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], ${JSON.stringify(JSON.stringify(output))});
process.stdin.resume();
`, { mode: 0o700 });
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
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8"));
    switch (body.action) {
      case "claim-poem":
        state = { poemId: "crash-poem", status: "claimed", version: 1 };
        break;
      case "source":
        response.end(JSON.stringify({ ok: true, poem: { authorName: "Author", titleArabic: "عنوان", linesArabic: ["سطر"] } }));
        return;
      case "dispatch":
        attemptId = body.attemptId;
        state = { poemId: "crash-poem", status: "dispatching", version: 2, checkpointJson: JSON.stringify({ invocation: { attemptId } }) };
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
    SAQI_RIG_ACTIVE: "1",
    SAQI_RIG_ENDPOINT: `http://127.0.0.1:${server.address().port}/rig`,
  };
  const child = spawn(process.execPath, [script.pathname], { env: { ...process.env, ...environment }, stdio: "ignore" });
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
    await assert.rejects(access(join(tmpdir(), `saqi-rig-${attemptId}.json`)), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (attemptId) await rm(join(tmpdir(), `saqi-rig-${attemptId}.json`), { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a durable Codex result is acknowledged and published after restart without another call", async () => {
  const attemptId = randomUUID();
  const outputPath = join(tmpdir(), `saqi-rig-${attemptId}.json`);
  const output = { translation: { lines: ["A translated line"] } };
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

test("an unknown Codex outcome without a result blocks instead of replaying", async () => {
  const attemptId = randomUUID();
  const run = await exerciseUnknown(attemptId);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /no durable result/u);
  assert.deepEqual(run.actions, ["purge-cache"]);
  assert.equal(run.codexCalled, false);
});

test("the Keychain-backed entrypoint preserves unknown-outcome blocking", async () => {
  const run = await exerciseUnknown(randomUUID(), localScript, ["translate"]);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /no durable result/u);
  assert.deepEqual(run.actions, ["purge-cache"]);
  assert.equal(run.codexCalled, false);
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
    const run = await runScript({
      CF_ACCESS_CLIENT_ID: "test-id",
      CF_ACCESS_CLIENT_SECRET: "test-secret",
      SAQI_RIG_ACTIVE: "1",
      SAQI_RIG_ENDPOINT: `http://127.0.0.1:${port}/rig`,
    }, script, ["poem-2"]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(actions.map((item) => item.action), ["purge-cache", "claim-poem"]);
    assert.equal(actions[1].poemId, "poem-2");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function exerciseUnknown(attemptId, entry = script, args = []) {
  const directory = await mkdtemp(join(tmpdir(), "saqi-rig-test-"));
  const markerPath = join(directory, "codex-called");
  const fakeCodex = join(directory, "codex");
  await writeFile(
    fakeCodex,
    '#!/bin/sh\necho called > "$SAQI_TEST_CODEX_MARKER"\nexit 97\n',
    { mode: 0o700 },
  );
  const actions = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(
        JSON.stringify({
          ok: true,
          state: {
            poemId: "poem-1",
            status: "unknown",
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
      response.end(JSON.stringify({ ok: true, cachePending: false }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address()?.port;
    const result = await runScript({
      CF_ACCESS_CLIENT_ID: "test-id",
      CF_ACCESS_CLIENT_SECRET: "test-secret",
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      SAQI_RIG_ACTIVE: "1",
      SAQI_RIG_ENDPOINT: `http://127.0.0.1:${port}/rig`,
      SAQI_TEST_CODEX_MARKER: markerPath,
    }, entry, args);
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

function runScript(environment, entry = script, args = []) {
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
