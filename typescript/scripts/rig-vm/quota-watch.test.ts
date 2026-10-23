/* global structuredClone -- Node isolates the durable-state fake for each test. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  quotaSummary,
  reconcileQuota,
  recoverQuotaAttempt,
} from "./quota-watch.ts";

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

function fixture({
  available = true,
  state = "inactive",
  enabled = true,
  previous = {},
} = {}) {
  const control = { available, state, enabled };
  const events = [];
  const reports = [];
  let saved = structuredClone(previous);
  const dependencies = {
    readQuota: async () => {
      events.push("quota");
      return limits(control.available);
    },
    serviceEnabled: async () => control.enabled,
    serviceState: async () => control.state,
    stop: async () => {
      events.push("stop");
      control.state = "inactive";
    },
    start: async () => {
      events.push("start");
      control.state = "active";
    },
    capturePending: async (pending) => {
      events.push("capture");
      return pending;
    },
    recover: async (pending) => {
      events.push(`recover-${pending.poemId}`);
      return "unresolved";
    },
    load: async () => saved,
    save: async (report) => {
      events.push(`save-${report.status}`);
      saved = structuredClone(report);
      reports.push(saved);
    },
  };
  return { dependencies, control, events, reports };
}

test("an exhausted quota records resume intent before stopping and captures only after drain", async () => {
  const f = fixture({ available: false, state: "active" });
  f.dependencies.stop = async () => {
    assert.equal(f.reports.at(-1).resumeAfterQuota, true);
    f.events.push("stop");
    f.control.state = "inactive";
  };
  f.dependencies.capturePending = async () => {
    assert.equal(f.control.state, "inactive");
    f.events.push("capture");
    return [record];
  };
  assert.equal(await reconcileQuota(f.dependencies), "waiting_for_quota");
  assert.deepEqual(f.events, [
    "quota",
    "save-draining_for_quota",
    "stop",
    "capture",
    "save-waiting_for_quota",
  ]);
  assert.deepEqual(f.reports.at(-1).pending, [record]);
  assert.equal(f.reports.at(-1).automaticResume, true);
});

test("a failed intent save cannot stop the pool", async () => {
  const f = fixture({ available: false, state: "active" });
  f.dependencies.save = async () => {
    throw new Error("disk unavailable");
  };
  await assert.rejects(reconcileQuota(f.dependencies), /disk unavailable/u);
  assert.equal(f.control.state, "active");
  assert.equal(f.events.includes("stop"), false);
});

test("an enabled watcher-owned pause keeps unresolved and saved records while other work resumes", async () => {
  const pending = ["unresolved", "saved", "resolved"].map((poemId) => ({
    ...record,
    poemId,
  }));
  const f = fixture({ previous: { resumeAfterQuota: true, pending } });
  f.dependencies.recover = async (entry) => {
    f.events.push(`recover-${entry.poemId}`);
    return entry.poemId;
  };
  f.dependencies.start = async () => {
    assert.ok(f.events.includes("capture"));
    for (const entry of pending)
      assert.ok(f.events.includes(`recover-${entry.poemId}`));
    assert.equal(f.events.at(-1), "save-starting");
    assert.equal(f.reports.at(-1).resumeAfterQuota, true);
    f.events.push("start");
    f.control.state = "active";
  };
  assert.equal(await reconcileQuota(f.dependencies), "running");
  assert.deepEqual(f.reports.at(-1).pending, pending.slice(0, 2));
  assert.equal(f.reports.at(-1).resumeAfterQuota, false);
  assert.equal(f.reports.at(-1).automaticResume, false);
  assert.equal(await reconcileQuota(f.dependencies), "running");
  assert.equal(f.events.filter((event) => event === "start").length, 1);
});

for (const state of ["inactive", "failed", "deactivating"])
  for (const available of [false, true])
    await test(`a ${state} pool without owned intent stays stopped with quota available=${available}, including legacy reports`, async () => {
      const f = fixture({
        state,
        available,
        previous: { automaticResume: true, pending: [record] },
      });
      assert.equal(await reconcileQuota(f.dependencies), "stopped");
      assert.equal(f.events.includes("start"), false);
      assert.equal(f.events.includes("stop"), false);
      assert.equal(f.events.includes("capture"), false);
      assert.equal(
        f.events.some((event) => event.startsWith("recover-")),
        false
      );
      assert.equal(f.reports.at(-1).resumeAfterQuota, false);
      assert.equal(f.reports.at(-1).automaticResume, false);
      assert.deepEqual(f.reports.at(-1).pending, [record]);
    });

for (const state of ["inactive", "active", "deactivating"])
  await test(`a disabled ${state} unit clears stale intent without probing or controlling the pool`, async () => {
    const f = fixture({
      state,
      enabled: false,
      previous: { resumeAfterQuota: true, pending: [record] },
    });
    assert.equal(await reconcileQuota(f.dependencies), "disabled");
    assert.deepEqual(f.events, ["save-disabled"]);
    assert.equal(f.reports.at(-1).resumeAfterQuota, false);
    assert.equal(f.reports.at(-1).automaticResume, false);
    assert.deepEqual(f.reports.at(-1).pending, [record]);
  });

test("a disable or explicit stop during the quota probe is respected", async () => {
  for (const action of ["disable", "stop"]) {
    const f = fixture({ state: "active", previous: { pending: [record] } });
    f.dependencies.readQuota = async () => {
      if (action === "disable") f.control.enabled = false;
      else f.control.state = "inactive";
      return limits(true);
    };
    assert.equal(
      await reconcileQuota(f.dependencies),
      action === "disable" ? "disabled" : "stopped"
    );
    assert.equal(f.events.includes("start"), false);
    assert.equal(f.events.includes("stop"), false);
    assert.equal(f.reports.at(-1).resumeAfterQuota, false);
    assert.deepEqual(f.reports.at(-1).pending, [record]);
  }
});

test("stale quota intent is cleared before a running pool can be stopped during the probe", async () => {
  const f = fixture({
    state: "active",
    previous: { resumeAfterQuota: true, pending: [record] },
  });
  f.dependencies.readQuota = async () => {
    const durable = await f.dependencies.load();
    assert.equal(durable.resumeAfterQuota, false);
    f.control.state = "inactive";
    return limits(true);
  };
  assert.equal(await reconcileQuota(f.dependencies), "stopped");
  assert.equal(f.events.includes("start"), false);
  assert.equal(f.events.includes("stop"), false);
  assert.equal(f.reports.at(-1).automaticResume, false);
  assert.deepEqual(f.reports.at(-1).pending, [record]);
});

test("a failed probe cannot leave stale active-pool intent to undo a later stop", async () => {
  const f = fixture({
    state: "active",
    previous: { resumeAfterQuota: true, pending: [record] },
  });
  f.dependencies.readQuota = async () => {
    throw new Error("quota unavailable");
  };
  await assert.rejects(reconcileQuota(f.dependencies), /quota unavailable/u);
  const durable = await f.dependencies.load();
  assert.equal(durable.resumeAfterQuota, false);
  f.control.state = "inactive";
  f.dependencies.readQuota = async () => limits(true);
  assert.equal(await reconcileQuota(f.dependencies), "stopped");
  assert.equal(f.events.includes("start"), false);
  assert.deepEqual(f.reports.at(-1).pending, [record]);
});

test("stale active-pool intent must be durably cleared before any quota control", async () => {
  const f = fixture({
    state: "active",
    previous: { resumeAfterQuota: true, pending: [record] },
  });
  f.dependencies.save = async () => {
    throw new Error("intent save unavailable");
  };
  await assert.rejects(
    reconcileQuota(f.dependencies),
    /intent save unavailable/u
  );
  assert.equal(f.events.includes("quota"), false);
  assert.equal(f.events.includes("start"), false);
  assert.equal(f.events.includes("stop"), false);
  const durable = await f.dependencies.load();
  assert.deepEqual(durable.pending, [record]);
});

test("a disable during recovery cancels the recorded restart intent", async () => {
  const f = fixture({
    previous: { resumeAfterQuota: true, pending: [record] },
  });
  f.dependencies.recover = async () => {
    f.control.enabled = false;
    return "unresolved";
  };
  assert.equal(await reconcileQuota(f.dependencies), "disabled");
  assert.equal(f.events.includes("start"), false);
  assert.equal(f.reports.at(-1).resumeAfterQuota, false);
  assert.deepEqual(f.reports.at(-1).pending, [record]);
});

test("a quota reset during drain captures tickets before the eventual restart", async () => {
  const f = fixture({ available: false, state: "active" });
  f.dependencies.stop = async () => {
    f.events.push("stop");
    f.control.state = "deactivating";
  };
  f.dependencies.capturePending = async () => {
    assert.equal(f.control.state, "inactive");
    f.events.push("capture");
    return [record];
  };
  assert.equal(await reconcileQuota(f.dependencies), "draining_for_quota");
  assert.equal(f.events.includes("capture"), false);
  f.control.available = true;
  assert.equal(await reconcileQuota(f.dependencies), "draining_for_quota");
  assert.equal(f.reports.at(-1).resumeAfterQuota, true);
  assert.equal(f.events.includes("start"), false);
  f.control.state = "inactive";
  assert.equal(await reconcileQuota(f.dependencies), "running");
  assert.ok(f.events.indexOf("capture") < f.events.indexOf("start"));
  assert.deepEqual(f.reports.at(-1).pending, [record]);
});

test("live leases defer restart while unresolved outcomes remain fenced after expiry", async () => {
  const f = fixture({
    previous: { resumeAfterQuota: true, pending: [record] },
  });
  f.dependencies.recover = async () => "leased";
  assert.equal(await reconcileQuota(f.dependencies), "waiting_for_recovery");
  assert.equal(f.events.includes("start"), false);
  assert.equal(f.reports.at(-1).resumeAfterQuota, true);
  assert.deepEqual(f.reports.at(-1).pending, [record]);
  f.dependencies.recover = async () => "unresolved";
  assert.equal(await reconcileQuota(f.dependencies), "running");
  assert.deepEqual(f.reports.at(-1).pending, [record]);
});

test("quota, recovery and start failures propagate without losing recorded intent", async () => {
  for (const action of ["readQuota", "recover", "start"]) {
    const f = fixture({
      previous: { resumeAfterQuota: true, pending: [record] },
    });
    f.dependencies[action] = async () => {
      throw new Error(`${action} unavailable`);
    };
    await assert.rejects(reconcileQuota(f.dependencies), /unavailable/u);
    assert.equal(f.events.includes("start"), false);
    const retained = await f.dependencies.load();
    assert.equal(retained.resumeAfterQuota, true);
    assert.deepEqual(retained.pending, [record]);
    assert.equal(f.control.state, "inactive");
  }
});

test("unknown service state cannot start even with recorded quota intent", async () => {
  const f = fixture({ state: "unknown", previous: { resumeAfterQuota: true } });
  assert.equal(await reconcileQuota(f.dependencies), "waiting_for_service");
  assert.equal(f.events.includes("start"), false);
});

test("spend controls and invalid quota responses cannot authorize generation", () => {
  assert.equal(
    quotaSummary({
      ...limits(true),
      rateLimits: { ...limits(true).rateLimits, spendControlReached: true },
    }).available,
    false
  );
  assert.throws(
    () => quotaSummary({ rateLimits: { limitId: "base_model_inference" } }),
    /STATUS_UNAVAILABLE/u
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
        assert.fail("Quota recovery must never mutate or retry a paid attempt");
      },
    },
  };
}

test("expired dispatches and unknown paid outcomes remain unchanged and unresolved", async () => {
  for (const state of [dispatched, { ...dispatched, status: "unknown" }]) {
    const before = structuredClone(state);
    const { calls, dependencies } = recovery(state);
    assert.equal(await recoverQuotaAttempt(record, dependencies), "unresolved");
    assert.deepEqual(calls, []);
    assert.deepEqual(state, before);
  }
});

test("saved output, partial files, changed attempts and live leases are never regenerated", async () => {
  for (const [state, bytes, expected] of [
    [dispatched, () => 100, "saved"],
    [
      {
        ...dispatched,
        checkpointJson: JSON.stringify({
          ...JSON.parse(dispatched.checkpointJson),
          outputs: { generation: { translation: { lines: ["saved"] } } },
        }),
      },
      () => assert.fail("Checkpoint output must be preserved directly"),
      "saved",
    ],
    [{ ...dispatched, leaseExpiresAt: 101 }, () => 100, "leased"],
    [{ ...dispatched, leaseExpiresAt: null }, () => 0, "leased"],
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
    [
      {
        ...dispatched,
        checkpointJson: JSON.stringify({
          sourceHash: "changed",
          invocation: { attemptId: "attempt" },
        }),
      },
      () => 0,
      "resolved",
    ],
    [{ status: "complete", checkpointJson: null }, () => 0, "resolved"],
    [null, () => 0, "resolved"],
  ]) {
    const before = structuredClone(state);
    const { calls, dependencies } = recovery(state, bytes);
    assert.equal(await recoverQuotaAttempt(record, dependencies), expected);
    assert.deepEqual(calls, []);
    assert.deepEqual(state, before);
  }
});

test("unreadable paid checkpoints and result files fail without mutating attempts", async () => {
  const malformed = recovery({ ...dispatched, checkpointJson: "{" });
  await assert.rejects(recoverQuotaAttempt(record, malformed.dependencies));
  assert.deepEqual(malformed.calls, []);
  const unreadable = recovery(dispatched, () => {
    throw new Error("result unreadable");
  });
  await assert.rejects(
    recoverQuotaAttempt(record, unreadable.dependencies),
    /result unreadable/u
  );
  assert.deepEqual(unreadable.calls, []);
});
