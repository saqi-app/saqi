import assert from "node:assert/strict";
import console from "node:console";
import { stripTypeScriptTypes } from "node:module";
import { URL } from "node:url";
const { AbortController, structuredClone } = globalThis;
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../chrome/saqi-collector/controller.ts", import.meta.url),
  "utf8"
);
const author = {
  nameArabic: "شاعر",
  sourceUrl: "https://poetry.example/cat-poet-Test",
};
const poems = [1, 2].map((id) => ({
  numericId: String(id),
  href: `https://poetry.example/poem${id}.html`,
}));
const settle = async () => {
  for (let i = 0; i < 80; i++) {
    await Promise.resolve();
  }
};
function fixture({
  enabled = false,
  fail,
  project,
  redirect,
  stored,
  authors = [author],
  storageFailure = {},
  admissionResult = { author, poemCount: 2, result: { status: "updated" } },
} = {}) {
  let time = Date.parse("2026-09-26T12:00:00Z"),
    serial = 0;
  const timers = new Map(),
    calls = [],
    navigations = [],
    badges = [],
    titles = [];
  const local = stored || {
      collectorControl: { enabled, hasStarted: enabled },
    },
    session = {};
  let status = {
    version: 1,
    state: "idle",
    seenAt: new Date(time).toISOString(),
    progressAt: null,
    error: null,
    current: null,
  };
  let authorIndex = 0;
  let connections = 0,
    closedConnections = 0,
    tab;
  const clock = {
    Date: { now: () => time },
    setTimeout(fn, ms) {
      const id = ++serial;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, ms) {
      const id = ++serial;
      timers.set(id, { fn, at: time + ms, interval: ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
  };
  const event = () => {
    const listeners = [];
    return {
      addListener(fn) {
        listeners.push(fn);
      },
      emit(value) {
        for (const fn of listeners) fn(value);
      },
    };
  };
  const storage = (values) => ({
    async get() {
      if (values === local && storageFailure.get) throw storageFailure.get;
      return values;
    },
    async set(update) {
      if (values === local && storageFailure.set) {
        const failure = storageFailure.set(update);
        if (failure) throw failure;
      }
      Object.assign(values, structuredClone(update));
    },
  });
  const browser = {
    storage: { local: storage(local), session: storage(session) },
    action: {
      async setBadgeText(value) {
        badges.push(value.text);
      },
      async setTitle(value) {
        titles.push(value.title);
      },
    },
    windows: {
      async update() {
        return null;
      },
    },
    tabs: {
      async create(options) {
        tab = { id: 1, windowId: 2, status: "complete", ...options };
        return tab;
      },
      async get() {
        if (!tab) throw new Error("No tab");
        return tab;
      },
      async update(_id, update) {
        Object.assign(tab, update);
        if (update.url) {
          navigations.push(update.url);
          tab.url = redirect ? redirect(update.url) : update.url;
        }
        return tab;
      },
    },
    scripting: {
      async executeScript() {
        return [
          { result: project ? project(tab.url) : { sourceUrl: tab.url } },
        ];
      },
    },
    runtime: {
      connectNative() {
        connections++;
        let closed = false;
        const onMessage = event(),
          onDisconnect = event();
        return {
          onMessage,
          onDisconnect,
          postMessage(message) {
            if (closed) throw new Error("Port is disconnected");
            calls.push(message);
            void (async () => {
              const failure = await fail?.(message);
              if (failure === "hang" || closed) return;
              if (failure) {
                onMessage.emit({ id: message.id, ok: false, error: failure });
                return;
              }
              const result = {};
              if (message.action === "hello") result.protocol = 1;
              if (message.action === "begin") {
                result.author = authors[authorIndex] || null;
                status.state = result.author ? "collecting" : "idle";
              }
              if (message.action === "manifest") result.poems = poems;
              if (message.action === "admit-author")
                Object.assign(result, admissionResult);
              if (message.action === "complete") {
                status.state = "idle";
                authorIndex++;
              }
              if (
                ["status", "set-control"].includes(message.action) &&
                message.state
              )
                status = { ...status, state: message.state };
              if (
                message.action === "status" &&
                ["idle", "paused"].includes(message.state)
              )
                status = { ...status, error: null, retryAt: null };
              if (message.action === "set-control")
                status = {
                  ...status,
                  error: message.error ?? null,
                  retryAt: message.retryAt ?? null,
                };
              status.seenAt = new Date(time).toISOString();
              onMessage.emit({
                id: message.id,
                ok: true,
                status: { ...status },
                ...result,
              });
            })();
          },
          disconnect() {
            if (!closed) {
              closed = true;
              closedConnections += 1;
              onDisconnect.emit();
            }
          },
        };
      },
    },
  };
  const context = vm.createContext({
    SAQI_SOURCE_ORIGIN: "https://poetry.example",
    console,
    URL,
    AbortController,
    Date,
  });
  vm.runInContext(stripTypeScriptTypes(source), context);
  const controller = context.createSaqiCollector(browser, () => null, clock);
  async function advance(ms) {
    const until = time + ms;
    while (true) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      time = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.fn();
      await settle();
    }
    time = until;
    await settle();
  }
  return {
    controller,
    advance,
    calls,
    navigations,
    badges,
    titles,
    local,
    storageFailure,
    connections: () => connections,
    openConnections: () => connections - closedConnections,
    timerCount: () => timers.size,
    closeTab: () => {
      tab = null;
    },
  };
}

test("installation is paused, health checks never select an author or navigate", async () => {
  const f = fixture();
  await f.controller.tick();
  const { status } = await f.controller.command({ command: "get-status" });
  assert.equal(status.state, "paused");
  assert.equal(status.hasStarted, false);
  assert.equal(
    f.calls.some((call) => call.action === "begin"),
    false
  );
  assert.equal(f.navigations.length, 0);
});

test("overlapping alarm checks share one run and pause cancels pacing", async () => {
  const f = fixture({ enabled: true });
  const first = f.controller.tick(),
    second = f.controller.tick();
  await settle();
  assert.equal(f.connections(), 1);
  await f.controller.command({ command: "pause" });
  await Promise.all([first, second]);
  await f.advance(60000);
  assert.equal(f.navigations.length, 0);
  assert.equal(f.local.collectorControl.enabled, false);
});

test("human verification blocks future alarms and survives worker restart", async () => {
  const f = fixture({
    enabled: true,
    project: () => ({ error: "SOURCE_HUMAN_REQUIRED" }),
  });
  const run = f.controller.tick();
  await settle();
  await f.advance(14000);
  await run;
  assert.equal(f.local.collectorStatus.state, "human_required");
  const restarted = fixture({ stored: f.local });
  await restarted.controller.tick();
  await restarted.controller.tick();
  assert.equal(
    restarted.calls.some((call) => call.action === "begin"),
    false
  );
  assert.equal(restarted.local.collectorStatus.state, "human_required");
});

test("a hung native call expires and reports bounded retry", async () => {
  const f = fixture({
    enabled: true,
    fail: (message) => (message.action === "begin" ? "hang" : null),
  });
  const run = f.controller.tick();
  await settle();
  await f.advance(75000);
  await run;
  assert.equal(f.local.collectorStatus.state, "cooldown");
  assert.equal(f.local.collectorStatus.error.code, "NATIVE_TIMEOUT");
  assert.equal(f.local.collectorControl.retryCount, 1);
});

test("transient errors retry after one, two and five minutes, then require action", async () => {
  const f = fixture({
    enabled: true,
    fail: (message) =>
      message.action === "begin"
        ? { code: "SOURCE_QUERY_UNAVAILABLE", message: "Try later" }
        : null,
  });
  await f.controller.tick();
  for (const delay of [60000, 120000, 300000]) {
    await f.advance(delay);
    await f.controller.tick();
  }
  assert.equal(f.local.collectorControl.blocked, true);
  assert.equal(f.local.collectorStatus.state, "error");
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 4);
  await f.controller.tick();
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 4);
});

test("server cooldown is honored without navigating or selecting more work", async () => {
  const f = fixture({
    enabled: true,
    fail: (message) =>
      message.action === "begin"
        ? {
            code: "SOURCE_COOLDOWN",
            retryAfter: Date.parse("2026-09-26T12:10:00Z") / 1000,
          }
        : null,
  });
  await f.controller.tick();
  await f.advance(60000);
  await f.controller.tick();
  assert.equal(f.local.collectorControl.retryAt, "2026-09-26T12:10:00.000Z");
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
  const retry = await f.controller.command({ command: "retry" });
  assert.equal(retry.status.state, "cooldown");
  await settle();
  await f.controller.command({ command: "pause" });
  const resumed = await f.controller.command({ command: "resume" });
  assert.equal(resumed.status.state, "cooldown");
  assert.equal(resumed.status.retryAt, "2026-09-26T12:10:00.000Z");
  await settle();
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
  assert.equal(f.navigations.length, 0);
  await f.advance(540000);
  await f.controller.command({ command: "retry" });
  await settle();
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 2);
});

test("pause lets a submitted poem write finish but prevents the next page", async () => {
  const write = Promise.withResolvers();
  const f = fixture({
    enabled: true,
    fail: (message) => (message.action === "poem" ? write.promise : null),
  });
  const run = f.controller.tick();
  await settle();
  await f.advance(28000);
  assert.equal(f.calls.filter((call) => call.action === "poem").length, 1);
  await f.controller.command({ command: "pause" });
  assert.equal(f.navigations.length, 2);
  write.resolve(null);
  await settle();
  await run;
  assert.equal(
    f.calls.some((call) => call.action === "complete"),
    false
  );
  assert.equal(f.navigations.length, 2);
  assert.equal(f.local.collectorStatus.state, "paused");
});

test("canonical same-source redirect works; foreign-origin redirect blocks before extraction", async () => {
  const good = fixture({ enabled: true, redirect: (url) => `${url}/` });
  const run = good.controller.tick();
  await settle();
  await good.advance(42000);
  await run;
  assert.equal(good.calls.filter((call) => call.action === "poem").length, 2);
  const bad = fixture({
    enabled: true,
    redirect: () => "https://example.com/poem1.html",
  });
  const failed = bad.controller.tick();
  await settle();
  await bad.advance(14000);
  await failed;
  assert.equal(
    bad.local.collectorStatus.error.code,
    "SOURCE_REDIRECT_MISMATCH"
  );
  assert.equal(
    bad.calls.some((call) => call.action === "manifest"),
    false
  );
});

test("pause then resume during a write finishes it and starts a fresh session without retry errors", async () => {
  const write = Promise.withResolvers();
  let delayFirstWrite = true;
  const f = fixture({
    enabled: true,
    fail: (message) => {
      if (message.action !== "poem" || !delayFirstWrite) return null;
      delayFirstWrite = false;
      return write.promise;
    },
  });
  const initial = f.controller.tick();
  await settle();
  await f.advance(28000);
  await f.controller.command({ command: "pause" });
  await f.controller.command({ command: "resume" });
  write.resolve(null);
  await initial;
  await settle();
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 2);
  assert.equal(f.local.collectorControl.retryCount, 0);
  await f.advance(42000);
  assert.equal(f.local.collectorStatus.state, "idle");
});

test("popup setup handshake is credential-free and cached between five-second polls", async () => {
  const f = fixture();
  const first = await f.controller.command({ command: "get-status" });
  await f.advance(5000);
  await f.controller.command({ command: "get-status" });
  assert.equal(first.status.state, "paused");
  assert.equal(f.connections(), 1);
  assert.equal(
    f.calls.some((call) => call.action === "begin"),
    false
  );
});

test("successful explicit retry replaces the old error badge and tooltip", async () => {
  let failed = false;
  const f = fixture({
    enabled: true,
    project: () => {
      if (failed) return {};
      failed = true;
      return { error: "SOURCE_HUMAN_REQUIRED" };
    },
  });
  const initial = f.controller.tick();
  await settle();
  await f.advance(14000);
  await initial;
  assert.equal(f.badges.at(-1), "!");
  await f.controller.command({ command: "retry" });
  await settle();
  await f.advance(42000);
  assert.equal(f.badges.at(-1), "");
  assert.equal(f.titles.at(-1), "Saqi: idle");
});

test("authors continue immediately on one bridge and one paced tab", async () => {
  const f = fixture({ enabled: true, authors: [author, author] });
  const run = f.controller.tick();
  await settle();
  await f.advance(84000);
  await run;
  assert.equal(f.calls.filter((call) => call.action === "complete").length, 2);
  assert.equal(f.connections(), 1);
  assert.equal(f.navigations.length, 6);
  assert.equal(f.local.collectorStatus.state, "idle");
});

test("a persisted source conflict clears when there is no unfinished author", async () => {
  const stored = {
    collectorControl: {
      enabled: true,
      hasStarted: true,
      blocked: true,
      sourceConflictRetried: true,
      error: { code: "SOURCE_CHANGED" },
    },
    collectorStatus: { state: "error", error: { code: "SOURCE_CHANGED" } },
  };
  const f = fixture({ stored, authors: [] });
  await f.controller.tick();
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
  assert.equal(f.local.collectorStatus.state, "idle");
  assert.equal(f.local.collectorStatus.error, null);
  assert.equal(f.local.collectorControl.blocked, false);
  assert.equal(f.navigations.length, 0);
});

test("a source conflict retries from a fresh source page and then completes", async () => {
  let conflicts = 0;
  const f = fixture({
    enabled: true,
    fail: (message) => {
      if (message.action === "poem" && conflicts++ === 0)
        return { code: "SOURCE_CHANGED" };
      return null;
    },
  });
  const initial = f.controller.tick();
  await settle();
  await f.advance(28000);
  await initial;
  assert.equal(f.local.collectorStatus.state, "cooldown");
  assert.equal(f.local.collectorControl.retryCount, 1);
  await f.advance(60000);
  const retry = f.controller.tick();
  await settle();
  await f.advance(42000);
  await retry;
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 3);
  assert.equal(
    f.navigations.filter((url) => url === author.sourceUrl).length,
    2
  );
  assert.equal(f.calls.filter((call) => call.action === "complete").length, 1);
  assert.equal(f.local.collectorControl.retryCount, 0);
  assert.equal(f.local.collectorStatus.state, "idle");
});

test("repeated source conflicts stop after bounded fresh sessions", async () => {
  const f = fixture({
    enabled: true,
    fail: (message) =>
      message.action === "poem" ? { code: "SOURCE_CHANGED" } : null,
  });
  for (const delay of [0, 60000, 120000, 300000]) {
    await f.advance(delay);
    const run = f.controller.tick();
    await settle();
    await f.advance(28000);
    await run;
  }
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 4);
  assert.equal(f.local.collectorControl.blocked, true);
  assert.equal(
    f.local.collectorStatus.error.code,
    "SOURCE_CONFLICT_RETRY_EXHAUSTED"
  );
  const restarted = fixture({ stored: f.local });
  await restarted.controller.tick();
  assert.equal(
    restarted.calls.some((call) => call.action === "begin"),
    false
  );
});

test("storage initialization failures return structured command errors without connecting", async () => {
  const failure = new Error("Collector storage unavailable");
  const f = fixture({ storageFailure: { get: failure } });
  await settle();
  const reply = await f.controller.command({ command: "get-status" });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.message, failure.message);
  assert.equal(reply.error.code, "COLLECTOR_ERROR");
  assert.equal(f.connections(), 0);
  await assert.rejects(f.controller.tick(), (error) => error === failure);
});

test("paused session cleanup closes its bridge even when status persistence fails", async () => {
  const failure = new Error("Collector status storage unavailable");
  const f = fixture({
    storageFailure: {
      set: (update) => (update.collectorStatus ? failure : null),
    },
  });
  await assert.rejects(f.controller.tick(), (error) => error === failure);
  assert.equal(f.openConnections(), 0);
  assert.equal(f.timerCount(), 0);
  f.storageFailure.set = null;
  const status = await f.controller.command({ command: "get-status" });
  assert.equal(status.ok, true);
  assert.equal(f.openConnections(), 0);
});

test("command-launched session failures are owned after the command response", async () => {
  const failure = new Error("Collector status storage unavailable");
  let writes = 0;
  const f = fixture({
    storageFailure: {
      set: (update) =>
        update.collectorStatus && ++writes > 1 ? failure : null,
    },
  });
  const started = await f.controller.command({ command: "start" });
  assert.equal(started.ok, true);
  await settle();
  assert.equal(f.openConnections(), 0);
  assert.equal(f.timerCount(), 0);
});

test("Pause and Open complete while a standalone native health request is pending", async () => {
  const health = Promise.withResolvers();
  let first = true;
  const f = fixture({
    enabled: true,
    fail: (message) => {
      if (message.action !== "status" || !first) return null;
      first = false;
      return health.promise;
    },
  });
  const checking = f.controller.command({ command: "get-status" });
  await settle();
  const paused = await f.controller.command({ command: "pause" });
  assert.equal(paused.ok, true);
  assert.equal(paused.status.enabled, false);
  assert.equal(paused.status.state, "paused");
  const opened = await f.controller.command({ command: "open-collector" });
  assert.equal(opened.ok, true);
  assert.equal(
    f.calls.some((call) => call.action === "begin"),
    false
  );
  health.resolve(null);
  await checking;
  await settle();
  assert.equal(f.local.collectorStatus.state, "paused");
  assert.equal(f.openConnections(), 0);
});

test("isolated commands queued behind health retain one native client at a time", async () => {
  const health = Promise.withResolvers();
  const admission = Promise.withResolvers();
  let firstStatus = true;
  const f = fixture({
    fail: (message) => {
      if (message.action === "status" && firstStatus) {
        firstStatus = false;
        return health.promise;
      }
      return message.action === "admit-author" ? admission.promise : null;
    },
  });
  const checking = f.controller.command({ command: "get-status" });
  await settle();
  const saving = f.controller.command({
    command: "admit-author",
    projection: {},
    nameArabic: "شاعر",
  });
  const acknowledging = f.controller.command({ command: "ack-review" });
  health.resolve(null);
  await checking;
  await settle();
  assert.equal(f.openConnections(), 1);
  assert.equal(
    f.calls.some((call) => call.action === "acknowledge-review"),
    false
  );
  admission.resolve(null);
  const saved = await saving;
  const acknowledged = await acknowledging;
  assert.equal(saved.ok, true);
  assert.equal(acknowledged.ok, true);
  assert.equal(f.openConnections(), 0);
});

test("created author admission keeps stopped collection stopped", () =>
  verifyAdmission({ enabled: false, status: "created" }));

test("updated author admission keeps stopped collection stopped", () =>
  verifyAdmission({ enabled: false, status: "updated" }));

test("created author admission keeps enabled collection enabled", () =>
  verifyAdmission({ enabled: true, status: "created" }));

test("updated author admission keeps enabled collection enabled", () =>
  verifyAdmission({ enabled: true, status: "updated" }));

async function verifyAdmission({ enabled, status }) {
  const result = { author, poemCount: 2, result: { status } };
  const f = fixture({ enabled, admissionResult: result });
  const admitted = await f.controller.command({
    command: "admit-author",
    projection: {},
    nameArabic: "شاعر",
  });
  assert.equal(admitted.ok, true);
  assert.deepEqual(structuredClone(admitted.admission), result);
  assert.equal(admitted.status.enabled, enabled);
  assert.equal(admitted.status.hasStarted, enabled);
  assert.equal(
    f.calls.some((call) => call.action === "begin"),
    false
  );
  assert.equal(f.navigations.length, 0);
}
