import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installQueueScanHints } from "./rig-queue-hints.mjs";

const endpoint = "https://ops.example.test/api/rig/state";
const installation = Symbol.for("saqi.queueScanHints");
const claim = () => ({
  method: "POST",
  headers: { Origin: "https://ops.example.test" },
  body: JSON.stringify({
    action: "claim-poem",
    maxConcurrent: 80,
    token: "owner",
  }),
});

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "saqi-scan-test-"));
  const original = globalThis.fetch;
  try {
    await run(join(directory, "hint.json"));
  } finally {
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- The isolated fixture owns and restores its fake fetch implementation.
    globalThis.fetch = original;
    Reflect.deleteProperty(globalThis, installation);
    await rm(directory, { recursive: true, force: true });
  }
}

test("claims carry saved scan progress across fresh workers and process installations; other requests are untouched", async () =>
  fixture(async (path) => {
    const calls = [];
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- The isolated fixture owns and restores its fake fetch implementation.
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      let body;
      try {
        body = init?.body ? JSON.parse(init.body) : {};
      } catch {
        body = {};
      }
      return globalThis.Response.json({
        ok: true,
        state: null,
        scanHint: {
          afterPoemId: body?.scanHint?.afterPoemId ? "page-2" : "page-1",
          priority: 2,
        },
      });
    };
    await installQueueScanHints(endpoint, path);
    const first = await globalThis.fetch(endpoint, claim());
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true, "The canonical response remains readable");
    const native = globalThis[installation].originalFetch;
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- The isolated fixture owns and restores its fake fetch implementation.
    globalThis.fetch = native;
    Reflect.deleteProperty(globalThis, installation);
    await installQueueScanHints(endpoint, path);
    await globalThis.fetch(endpoint, claim());
    assert.deepEqual(JSON.parse(calls[1].init.body).scanHint, {
      afterPoemId: "page-1",
      priority: 2,
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      afterPoemId: "page-2",
      priority: 2,
    });
    const savedStat = await stat(path);
    assert.equal(savedStat.mode & 0o777, 0o600);
    for (const action of [
      "source",
      "dispatch",
      "acknowledge",
      "publish",
      "purge-cache",
    ]) {
      const init = { method: "POST", body: JSON.stringify({ action }) };
      await globalThis.fetch(endpoint, init);
      assert.equal(calls.at(-1).init, init);
    }
    for (const body of ["null", "42", "{", "[]"]) {
      const init = { method: "POST", body };
      await globalThis.fetch(endpoint, init);
      assert.equal(calls.at(-1).init, init);
    }
    const other = claim();
    await globalThis.fetch("https://elsewhere.example.test", other);
    assert.equal(calls.at(-1).init, other);
    const single = {
      method: "POST",
      body: JSON.stringify({ action: "claim-poem", maxConcurrent: 1 }),
    };
    await globalThis.fetch(endpoint, single);
    assert.equal(calls.at(-1).init, single);
    const repeatedInstallation = await installQueueScanHints(endpoint, path);
    assert.equal(repeatedInstallation.installed, false);
  }));

test("late concurrent replies cannot rewind the hint used by later claims or its saved file", async () =>
  fixture(async (path) => {
    const replies = [];
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- The isolated fixture owns and restores its fake fetch implementation.
    globalThis.fetch = async (_input, init) => {
      const completion = Promise.withResolvers();
      replies.push({ ...completion, body: JSON.parse(init.body) });
      return completion.promise;
    };
    await installQueueScanHints(endpoint, path);
    const one = globalThis.fetch(endpoint, claim()),
      two = globalThis.fetch(endpoint, claim());
    replies[1].resolve(
      globalThis.Response.json({
        ok: true,
        scanHint: { afterPoemId: "newer", priority: 2 },
      }),
    );
    await two;
    replies[0].resolve(
      globalThis.Response.json({
        ok: true,
        scanHint: { afterPoemId: "older", priority: 1 },
      }),
    );
    await one;
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      afterPoemId: "newer",
      priority: 2,
    });
    const three = globalThis.fetch(endpoint, claim());
    assert.deepEqual(replies[2].body.scanHint, {
      afterPoemId: "newer",
      priority: 2,
    });
    replies[2].resolve(globalThis.Response.json({ ok: true }));
    await three;
  }));

test("damaged files, invalid hints, and persistence failures preserve canonical claim responses", async () =>
  fixture(async (path) => {
    await writeFile(path, "{");
    const calls = [];
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- The isolated fixture owns and restores its fake fetch implementation.
    globalThis.fetch = async (_input, init) => {
      calls.push(JSON.parse(init.body));
      return globalThis.Response.json({
        ok: true,
        state: { poemId: "claimed" },
        scanHint: { afterPoemId: "x", priority: 9 },
      });
    };
    await installQueueScanHints(endpoint, path);
    const damagedResponse = await globalThis.fetch(endpoint, claim());
    const damagedBody = await damagedResponse.json();
    assert.equal(damagedBody.state.poemId, "claimed");
    assert.equal(calls[0].scanHint, undefined);
    assert.equal(await readFile(path, "utf8"), "{");
    const native = async () =>
      globalThis.Response.json({
        ok: true,
        state: { poemId: "claimed" },
        scanHint: { afterPoemId: "page", priority: 0 },
      });
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- The isolated fixture owns and restores its fake fetch implementation.
    globalThis.fetch = native;
    Reflect.deleteProperty(globalThis, installation);
    await installQueueScanHints(endpoint, join(path, "missing", "hint.json"));
    const unwritableResponse = await globalThis.fetch(endpoint, claim());
    const unwritableBody = await unwritableResponse.json();
    assert.equal(unwritableBody.state.poemId, "claimed");
  }));
