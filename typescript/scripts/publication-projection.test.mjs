import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { assertKnownSkippedCandidates } from "./known-publication-skips.mjs";

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

test("a bounded audit stops after crossing its cursor and rejects a write range", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = await Array.fromAsync(request);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        afterId: requests.length === 1 ? "2" : "4",
        complete: false,
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
    const environment = {
      SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
      SAQI_PROJECTION_STOP_AFTER_ID: "3",
    };
    const result = await runScript(["--audit"], environment);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, [
      { action: "audit", afterId: "", limit: 10 },
      { action: "audit", afterId: "2", limit: 10 },
    ]);
    assert.match(result.stdout, /"stopAfterId":"3"/u);
    const rejected = await runScript(["--apply"], {
      ...environment,
      SAQI_D1_RESTORE_BOOKMARK:
        "00002985-00000012-000050f1-cca58d46ad469dbc234dba8ef3ada66e",
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /only for a read-only audit/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
    assert.match(result.stderr, /Skipped publication candidates changed/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the reviewed skip gate accepts only the exact ID set", () => {
  const digest =
    "59a2230df75ce83ab2c2ed288c3eeb8ea770f746790fa930496c7f71fcaca48a";
  assert.equal(
    assertKnownSkippedCandidates(["poem-b", "poem-a"], 2, digest),
    digest,
  );
  assert.throws(
    () => assertKnownSkippedCandidates(["poem-a", "poem-c"], 2, digest),
    /Skipped publication candidates changed/u,
  );
  assert.throws(
    () => assertKnownSkippedCandidates(["poem-a"], 2, digest),
    /Skipped publication candidates changed/u,
  );
});

test("read-only cursor resumes after a transient Worker failure", async () => {
  let calls = 0;
  const requests = [];
  const server = createServer(async (request, response) => {
    calls += 1;
    const chunks = await Array.fromAsync(request);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
    const audit = await runScript(["--audit"], {
      SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
      SAQI_PROJECTION_AFTER_ID: "poem-1",
    });
    assert.equal(audit.code, 0, audit.stderr);
    assert.match(audit.stdout, /"action":"audit"/u);
    assert.match(audit.stdout, /"startAfterId":"poem-1"/u);
    assert.deepEqual(requests.at(-1), {
      action: "audit",
      afterId: "poem-1",
      limit: 10,
    });
    const rejected = await runScript(["--apply"], {
      SAQI_PROJECTION_AFTER_ID: "poem-1",
      SAQI_D1_RESTORE_BOOKMARK:
        "00002985-00000012-000050f1-cca58d46ad469dbc234dba8ef3ada66e",
    });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /only for read-only/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("read-only audit survives a burst of four Worker 503 responses", async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    if (calls <= 4) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        afterId: "poem-1",
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
    const result = await runScript(["--audit"], {
      SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls, 5);
    assert.match(result.stdout, /"totalEligible":1/u);
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
