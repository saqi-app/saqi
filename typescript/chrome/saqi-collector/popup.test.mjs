import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { URL } from "node:url";
import { createContext, runInContext } from "node:vm";

const html = await readFile(new URL("popup.html", import.meta.url), "utf8");
const source = await readFile(new URL("popup.js", import.meta.url), "utf8");

function node(attributes = "") {
  const listeners = {};
  return {
    hidden: /\bhidden\b/.test(attributes),
    disabled: false,
    textContent: "",
    value: "",
    dataset: {},
    listeners,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
}
async function fixture(patch = {}, activeUrl = undefined) {
  const elements = new Map();
  for (const match of html.matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g))
    elements.set(match[2], node(match[1]));
  const buttons = html
    .matchAll(/<button\b([^>]*)>/g)
    .map((match) => {
      const id = /\bid="([^"]+)"/.exec(match[1])?.[1];
      const button = elements.get(id) || node(match[1]);
      button.dataset.command = /\bdata-command="([^"]+)"/.exec(match[1])?.[1];
      return button;
    })
    .toArray();
  const calls = [],
    projections = [];
  const state = {
    status: {
      version: 1,
      state: "paused",
      enabled: false,
      hasStarted: false,
      seenAt: new Date().toISOString(),
      progressAt: null,
      current: null,
      error: null,
      reviewWarning: null,
      lastCompleted: null,
      ...patch,
    },
    failure: null,
  };
  const context = createContext({
    document: {
      getElementById(id) {
        assert.ok(elements.has(id), `Missing popup element ${id}`);
        return elements.get(id);
      },
      querySelectorAll(selector) {
        return selector === "button"
          ? buttons
          : buttons.filter((button) => button.dataset.command);
      },
    },
    chrome: {
      runtime: {
        async sendMessage(payload) {
          calls.push(payload);
          if (state.failure) throw new Error(state.failure);
          return { ok: true, status: state.status };
        },
      },
      tabs: {
        async query() {
          return activeUrl ? [{ id: 7, url: activeUrl }] : [];
        },
      },
      scripting: {
        async executeScript({ func, args }) {
          projections.push({ name: func.name, args });
          return [
            {
              result:
                func.name === "projectSaqiAuthorPreview"
                  ? { nameArabic: "شاعر", sourceUrl: activeUrl }
                  : { kind: "author_poem_manifest", sourceUrl: activeUrl },
            },
          ];
        },
      },
    },
    projectSaqiAuthorPreview() {
      /* Chrome serializes this stub by name. */
    },
    projectSaqiPage() {
      /* Chrome serializes this stub by name. */
    },
    setInterval() {
      /* Polling is driven explicitly by each test. */
    },
  });
  runInContext(source, context);
  await setImmediate();
  return {
    context,
    elements,
    buttons,
    calls,
    projections,
    state,
    get: (id) => elements.get(id),
    button: (command) =>
      buttons.find((button) => button.dataset.command === command),
    async refresh(nextPatch) {
      Object.assign(state.status, nextPatch);
      await context.command("get-status");
    },
  };
}

test("first install stays stopped and requires a fresh healthy bridge before showing Start", async () => {
  const f = await fixture({ seenAt: null });
  assert.equal(f.get("state").textContent, "Setup needed");
  assert.equal(f.button("start").hidden, true);
  assert.deepEqual(
    f.calls.map((call) => call.command),
    ["get-status"],
  );
  await f.refresh({ seenAt: new Date().toISOString() });
  assert.equal(f.get("state").textContent, "Ready to start");
  assert.equal(f.button("start").hidden, false);
  await f.refresh({
    error: { code: "KEYCHAIN_MISSING", message: "Install credentials" },
  });
  assert.equal(f.get("state").textContent, "Setup needed");
  assert.equal(f.get("status-error").textContent, "Install credentials");
  assert.equal(f.button("start").hidden, true);
  await f.refresh({ error: null, seenAt: "invalid date" });
  assert.equal(f.get("state").textContent, "Setup needed");
});

test("health expires while idle and heartbeat does not become collection progress", async () => {
  const f = await fixture({
    hasStarted: true,
    enabled: true,
    state: "idle",
    progressAt: "2026-01-01T00:00:00.000Z",
  });
  const progress = f.get("last-progress").textContent;
  await f.refresh({ seenAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(f.get("last-progress").textContent, progress);
  await f.refresh({ seenAt: new Date(Date.now() - 160000).toISOString() });
  assert.equal(f.get("state").textContent, "Collector disconnected");
});

test("current counters distinguish imported, unchanged and skipped poems", async () => {
  const f = await fixture({
    hasStarted: true,
    enabled: true,
    state: "collecting",
    current: {
      authorName: "شاعر",
      processed: 10,
      total: 17,
      added: 1,
      updated: 2,
      unchanged: 3,
      reviewRequired: 4,
    },
  });
  assert.equal(f.get("progress").textContent, "10 of 17 poems processed");
  assert.deepEqual(
    ["added", "updated", "unchanged", "reviewRequired"].map(
      (id) => f.get(id).textContent,
    ),
    ["1", "2", "3", "4"],
  );
  assert.equal(f.button("pause").hidden, false);
  assert.equal(f.button("start").hidden, true);
});

test("review warning uses native total and exposes only the first twenty source IDs", async () => {
  const f = await fixture({
    reviewWarning: {
      authorName: "شاعر",
      total: 23,
      poemIds: Array.from({ length: 23 }, (_, index) => String(index + 1)),
      sourceUrl: "https://www.aldiwan.net/cat-poet-Test",
    },
  });
  assert.match(f.get("review-detail").textContent, /23 poem/);
  assert.match(f.get("review-poems").textContent, /19, 20\./);
  assert.doesNotMatch(f.get("review-poems").textContent, /, 21/);
  await f.refresh({
    lastCompleted: {
      authorName: "آخر",
      added: 2,
      updated: 0,
      unchanged: 3,
      reviewRequired: 0,
    },
  });
  assert.equal(f.get("review").hidden, false);
  assert.match(f.get("completed-detail").textContent, /2 added/);
});

test("buttons send their explicit command; challenges offer Retry and pause offers Resume", async () => {
  const f = await fixture({
    hasStarted: true,
    enabled: true,
    state: "human_required",
  });
  assert.equal(f.button("retry").hidden, false);
  for (const action of [
    "retry",
    "pause",
    "resume",
    "open-collector",
    "ack-review",
    "start",
  ]) {
    f.button(action).listeners.click();
    await setImmediate();
    assert.equal(f.calls.at(-1).command, action);
  }
  await f.refresh({ state: "paused", enabled: false });
  assert.equal(f.button("resume").hidden, false);
  assert.equal(f.button("pause").hidden, true);
});

test("a recovered status request clears its stale communication error", async () => {
  const f = await fixture();
  f.state.failure = "Bridge unavailable";
  await f.context.command("get-status");
  assert.equal(f.get("feedback").textContent, "Bridge unavailable");
  f.state.failure = null;
  await f.context.command("get-status");
  assert.equal(f.get("feedback").hidden, true);
});

test("author admission previews only the allowed host and sends a fresh manifest after explicit submit", async () => {
  const offsite = await fixture({}, "https://example.com/cat-poet-Test");
  assert.equal(offsite.projections.length, 0);
  assert.equal(offsite.get("admit-form").hidden, true);
  const f = await fixture({}, "https://www.aldiwan.net/cat-poet-Test");
  assert.equal(f.get("author-name").value, "شاعر");
  assert.equal(f.projections.length, 1);
  assert.ok(f.calls.every((call) => call.command === "get-status"));
  await f.context.admitAuthor({
    preventDefault() {
      /* No browser default in the DOM fixture. */
    },
  });
  assert.equal(f.projections.length, 2);
  assert.equal(f.calls.at(-1).command, "admit-author");
  assert.equal(f.calls.at(-1).nameArabic, "شاعر");
  assert.equal(f.calls.at(-1).projection.kind, "author_poem_manifest");
});
