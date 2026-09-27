import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { statusStore } from "./rig-chrome-status.mjs";

test("heartbeats do not claim progress and warnings survive successful authors", () => {
  const directory = mkdtempSync(join(tmpdir(), "saqi-status-"));
  try {
    let tick = "2026-09-26T12:00:00.000Z";
    const store = statusStore(directory, () => tick);
    store.update({
      state: "collecting",
      progress: true,
      reviewWarning: { count: 1 },
    });
    tick = "2026-09-26T12:01:00.000Z";
    store.update();
    assert.equal(store.get().seenAt, tick);
    assert.equal(store.get().progressAt, "2026-09-26T12:00:00.000Z");
    store.update({ state: "idle", lastCompleted: { reviewRequired: 0 } });
    assert.deepEqual(store.get().reviewWarning, { count: 1 });
    assert.deepEqual(statusStore(directory).get(), store.get());
    assert.equal("progress" in store.get(), false);
    store.update({ reviewWarning: null });
    assert.equal(store.get().reviewWarning, null);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("invalid snapshots never prove connection; oversized updates preserve last good file", () => {
  const directory = mkdtempSync(join(tmpdir(), "saqi-status-"));
  try {
    const file = join(directory, "collector-status.json");
    writeFileSync(file, '{"version":1,');
    assert.equal(statusStore(directory).get().seenAt, null);
    const store = statusStore(directory);
    store.update({ state: "paused" });
    const previous = readFileSync(file, "utf8");
    assert.throws(
      () => store.update({ message: "x".repeat(65536) }),
      /TOO_LARGE/,
    );
    assert.equal(readFileSync(file, "utf8"), previous);
    assert.throws(() => store.update({ state: "made-up" }), /INVALID/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
