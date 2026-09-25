import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

const script = new URL("publication-projection.mjs", import.meta.url);

test("remote projection resumes by cursor and sends no poem payload", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = await Array.fromAsync(request);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        afterId: requests.length % 2 === 1 ? "poem-1" : "poem-2",
        complete: requests.length % 2 === 0,
        scanned: 1,
        eligible: 1,
        shadowed: 0,
        skipped: [],
        mismatched: [],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address()?.port;
    assert.ok(Number.isSafeInteger(port));
    const result = await runScript([], {
      SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, [
      { action: "backfill", afterId: "", limit: 10 },
      { action: "backfill", afterId: "poem-1", limit: 10 },
    ]);
    assert.match(result.stdout, /"totalEligible":2/u);
    assert.doesNotMatch(result.stdout, /test-secret/u);
    const incomplete = await runScript(["--expect-empty"], {
      SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
    });
    assert.notEqual(incomplete.code, 0);
    assert.match(incomplete.stderr, /still need backfill/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an apply pass refuses to start without a D1 restore bookmark", async () => {
  const result = await runScript(["--apply"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Time Travel bookmark is required/u);
});

test("verify-empty rejects skipped publication candidates", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        afterId: "poem-skipped",
        complete: true,
        scanned: 1,
        eligible: 0,
        shadowed: 0,
        skipped: ["poem-skipped"],
        mismatched: [],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address()?.port;
    const result = await runScript(["--expect-empty"], {
      SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /1 candidate skipped/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("read-only cursor resumes after a transient Worker failure", async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        afterId: "poem-2",
        complete: true,
        scanned: 1,
        eligible: 1,
        shadowed: 0,
        skipped: [],
        mismatched: [],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address()?.port;
    const result = await runScript([], {
      SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
      SAQI_PROJECTION_AFTER_ID: "poem-1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls, 2);
    assert.match(result.stdout, /"startAfterId":"poem-1"/u);
    const rejected = await runScript(["--apply"], {
      SAQI_PROJECTION_AFTER_ID: "poem-1",
      SAQI_D1_RESTORE_BOOKMARK: "00002985-00000012-000050f1-cca58d46ad469dbc234dba8ef3ada66e",
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /only for read-only/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function runScript(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, ...args], {
      env: {
        ...process.env,
        CF_ACCESS_CLIENT_ID: "test-id",
        CF_ACCESS_CLIENT_SECRET: "test-secret",
        SAQI_D1_RESTORE_BOOKMARK: "",
        ...environment,
      },
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
