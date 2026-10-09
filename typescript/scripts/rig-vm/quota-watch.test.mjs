import assert from "node:assert/strict";
import { test } from "node:test";

import {
  quotaSummary,
  reconcileQuota,
  recoverQuotaAttempt,
} from "./quota-watch.mjs";

function limits(available) {
  return {
    ordinaryUsageAllowed: available,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: available ? 0 : 100, resetsAt: 1234 },
      credits: { balance: "0" },
      spendControlReached: false,
    },
  };
}

test("an exhausted quota stops new generation and records the interrupted queue", async () => {
  let state = "active";
  const events = [];
  const record = { poemId: "poem", attemptId: "attempt", sourceHash: "source" };
  const status = await reconcileQuota({
    readQuota: async () => limits(false),
    serviceState: async () => state,
    stop: async () => {
      events.push("stop");
      state = "inactive";
    },
    start: async () => assert.fail("Must not start without quota"),
    capturePending: async () => {
      assert.equal(state, "inactive");
      events.push("capture");
      return [record];
    },
    recover: async () => assert.fail("Must not retry without quota"),
    load: async () => ({}),
    save: async (r) => {
      events.push("save");
      assert.deepEqual(r.pending, [record]);
      assert.equal(r.status, "waiting_for_quota");
    },
  });
  assert.equal(status, "waiting_for_quota");
  assert.deepEqual(events, ["stop", "capture", "save"]);
});

test("a quota reset recovers the queue before automatically starting the service", async () => {
  const events = [];
  const records = [1, 2].map((id) => ({ poemId: String(id) }));
  assert.equal(
    await reconcileQuota({
      readQuota: async () => limits(true),
      serviceState: async () => "inactive",
      stop: async () => assert.fail("Quota is available"),
      start: async () => {
        assert.ok(events.includes("recover-1"));
        assert.ok(events.includes("recover-2"));
        assert.ok(events.includes("save-starting"));
        events.push("start");
      },
      capturePending: async () => assert.fail("Already recorded"),
      recover: async (record) => {
        events.push(`recover-${record.poemId}`);
        return "requeued";
      },
      load: async () => ({ pending: records }),
      save: async (r) => {
        assert.equal(r.pending.length, 0);
        events.push(`save-${r.status}`);
      },
    }),
    "running",
  );
  assert.equal(events.at(-1), "save-running");
});

test("quota lookup failures, spend controls, and live leases cannot start the service", async () => {
  assert.equal(
    quotaSummary({
      ...limits(true),
      rateLimits: { ...limits(true).rateLimits, spendControlReached: true },
    }).available,
    false,
  );
  assert.throws(
    () => quotaSummary({ rateLimits: { limitId: "base_model_inference" } }),
    /STATUS_UNAVAILABLE/u,
  );
  const dependencies = {
    readQuota: async () => {
      throw new Error("offline");
    },
    serviceState: async () => "inactive",
    stop: async () => assert.fail("Must not stop on an unreadable quota"),
    start: async () => assert.fail("Must not start"),
    capturePending: async () => [],
    recover: async () => "leased",
    load: async () => ({ pending: [{ poemId: "poem" }] }),
    save: async () => undefined,
  };
  await assert.rejects(reconcileQuota(dependencies), /offline/u);
  assert.equal(
    await reconcileQuota({
      ...dependencies,
      readQuota: async () => limits(true),
    }),
    "waiting_for_recovery",
  );
  await assert.rejects(
    reconcileQuota({
      ...dependencies,
      readQuota: async () => limits(true),
      recover: async () => {
        throw new Error("changed");
      },
    }),
    /changed/u,
  );
});

function recovery(state, bytes = () => 0) {
  const calls = [];
  return {
    calls,
    dependencies: {
      readState: async () => state,
      resultBytes: async () => bytes(),
      now: () => 100,
      request: async (body) => {
        calls.push(body);
        if (body.action === "mark-unknown")
          return { state: { ...state, status: "unknown", version: 3 } };
        return { ok: true };
      },
    },
  };
}

const record = { poemId: "poem", attemptId: "attempt", sourceHash: "source" };
const dispatched = {
  status: "dispatching",
  version: 2,
  leaseExpiresAt: 90,
  checkpointJson: JSON.stringify({
    sourceHash: "source",
    invocation: { attemptId: "attempt" },
  }),
};

test("an expired, empty, recorded attempt is requeued with the current version", async () => {
  const { calls, dependencies } = recovery(dispatched);
  assert.equal(await recoverQuotaAttempt(record, dependencies), "requeued");
  assert.deepEqual(calls, [
    { action: "mark-unknown", poemId: "poem" },
    {
      action: "retry-unknown",
      poemId: "poem",
      attemptId: "attempt",
      expectedVersion: 3,
    },
  ]);
});

test("saved output, changed attempts, and live leases are never regenerated", async () => {
  for (const [state, bytes, expected] of [
    [dispatched, () => 100, "saved"],
    [{ ...dispatched, leaseExpiresAt: 101 }, () => 0, "leased"],
    [
      {
        ...dispatched,
        checkpointJson: JSON.stringify({
          sourceHash: "source",
          invocation: { attemptId: "new" },
        }),
      },
      () => 0,
      "resolved",
    ],
  ]) {
    const { calls, dependencies } = recovery(state, bytes);
    assert.equal(await recoverQuotaAttempt(record, dependencies), expected);
    assert.deepEqual(calls, []);
  }
  let reads = 0;
  const { calls, dependencies } = recovery(
    { ...dispatched, status: "unknown" },
    () => (++reads === 1 ? 0 : 100),
  );
  assert.equal(await recoverQuotaAttempt(record, dependencies), "saved");
  assert.deepEqual(calls, []);
});
