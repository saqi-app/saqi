import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { URL } from "node:url";
import { createContext, runInContext } from "node:vm";

const { Iterator, structuredClone } = globalThis;
const html = await readFile(new URL("popup.html", import.meta.url), "utf8");
const source = await readFile(new URL("popup.ts", import.meta.url), "utf8");

function node(attributes = "") {
  const listeners = {};
  const values = new Map(
    Array.from(attributes.matchAll(/([\w-]+)="([^"]*)"/g), (match) => [
      match[1],
      match[2],
    ])
  );
  let content = "";
  const target = {
    hidden: /\bhidden\b/.test(attributes),
    disabled: false,
    textWrites: 0,
    get textContent() {
      return content;
    },
    set textContent(value) {
      content = value;
      target.textWrites += 1;
    },
    value: "",
    children: [],
    append(...children) {
      target.children.push(...children);
    },
    replaceChildren(...children) {
      target.children = children;
    },
    dataset: {},
    listeners,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    setAttribute(name, value) {
      values.set(name, value);
    },
    getAttribute(name) {
      return values.get(name);
    },
  };
  return target;
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
    respond: null,
    projection: null,
    admission: null,
  };
  const document = {
    body: node(),
    createElement(tag) {
      const target = node();
      target.tagName = tag;
      return target;
    },
    getElementById(id) {
      assert.ok(elements.has(id), `Missing popup element ${id}`);
      return elements.get(id);
    },
    querySelectorAll(selector) {
      return selector === "button"
        ? buttons
        : buttons.filter((button) => button.dataset.command);
    },
  };
  document.activeElement = document.body;
  const targets = new Set(Iterator.concat(elements.values(), buttons));
  for (const target of targets)
    target.focus = () => {
      document.activeElement = target;
    };
  const context = createContext({
    URL,
    SAQI_SOURCE_ORIGIN: "https://poetry.example",
    document,
    chrome: {
      runtime: {
        async sendMessage(payload) {
          calls.push(payload);
          if (state.failure) throw new Error(state.failure);
          if (state.respond) return state.respond(payload);
          return {
            ok: true,
            status: structuredClone(state.status),
            admission: state.admission,
          };
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
                  : state.projection
                    ? await state.projection()
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
  runInContext(stripTypeScriptTypes(source), context);
  await setImmediate();
  return {
    context,
    elements,
    buttons,
    calls,
    projections,
    state,
    document,
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
    ["get-status"]
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
  assert.equal(f.get("state").textContent, "Collector disconnected");
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
      (id) => f.get(id).textContent
    ),
    ["1", "2", "3", "4"]
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
      sourceUrl: "https://poetry.example/cat-poet-Test",
    },
  });
  assert.match(f.get("review-detail").textContent, /23 poem/);
  const links = f
    .get("review-poems")
    .children[1].children.map((item) => item.children[0]);
  assert.equal(links.length, 20);
  assert.equal(links.at(-1).href, "https://poetry.example/poem20.html");
  assert.equal(links.at(-1).target, "_blank");
  assert.equal(links.at(-1).rel, "noopener noreferrer");
  const firstLink = links[0];
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
  assert.equal(
    f.get("review-poems").children[1].children[0].children[0],
    firstLink
  );
  await f.refresh({
    reviewWarning: {
      total: 7,
      poemIds: [
        "javascript:alert(1)",
        "1",
        "1",
        "0",
        "2/../3",
        "9007199254740992",
        3,
        null,
        { id: "4" },
        "2",
      ],
    },
  });
  assert.deepEqual(
    f
      .get("review-poems")
      .children[1].children.map((item) => item.children[0].href),
    ["https://poetry.example/poem1.html", "https://poetry.example/poem2.html"]
  );
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
  assert.equal(f.get("feedback").textContent, "");
  assert.equal(f.get("feedback").hidden, false);
});

test("author admission previews only the allowed host and sends a fresh manifest after explicit submit", async () => {
  const offsite = await fixture({}, "https://example.com/cat-poet-Test");
  assert.equal(offsite.projections.length, 0);
  assert.equal(offsite.get("admit-form").hidden, true);
  const f = await fixture({}, "https://poetry.example/cat-poet-Test");
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

test("a slow status request leaves Pause and Open available and cannot repaint their newer state", async () => {
  const f = await fixture({
    hasStarted: true,
    enabled: true,
    state: "collecting",
  });
  const status = Promise.withResolvers();
  const old = structuredClone(f.state.status);
  f.state.respond = async ({ command }) => {
    if (command === "get-status") return status.promise;
    return { ok: true, status: { ...old, state: "paused", enabled: false } };
  };
  const poll = f.context.command("get-status");
  await setImmediate();
  assert.equal(f.get("refresh").disabled, true);
  assert.equal(f.button("pause").disabled, false);
  assert.equal(f.button("open-collector").disabled, false);
  await f.context.command("pause");
  await f.context.command("open-collector");
  assert.equal(f.get("state").textContent, "Collection paused");
  status.resolve({ ok: true, status: old });
  await poll;
  assert.equal(f.get("state").textContent, "Collection paused");
  assert.equal(f.button("resume").hidden, false);
  assert.deepEqual(
    f.calls.slice(-3).map((call) => call.command),
    ["get-status", "pause", "open-collector"]
  );
});

test("a late Resume reply cannot replace newer Pause state or feedback", async () => {
  const f = await fixture({
    hasStarted: true,
    enabled: false,
    state: "paused",
  });
  const resume = Promise.withResolvers();
  f.state.respond = async ({ command }) =>
    command === "resume"
      ? resume.promise
      : {
          ok: true,
          status: { ...f.state.status, state: "paused", enabled: false },
        };
  const resuming = f.context.command("resume");
  await f.context.command("pause");
  resume.resolve({
    ok: true,
    status: { ...f.state.status, state: "collecting", enabled: true },
  });
  await resuming;
  assert.equal(f.get("state").textContent, "Collection paused");
  assert.match(f.get("feedback").textContent, /Collection paused/);
});

test("admission owns its extraction before awaiting and Pause does not unlock its submit button", async () => {
  const f = await fixture(
    { hasStarted: true, enabled: true, state: "collecting" },
    "https://poetry.example/cat-poet-Test"
  );
  const projection = Promise.withResolvers();
  const admitted = Promise.withResolvers();
  const old = structuredClone(f.state.status);
  f.state.projection = () => projection.promise;
  f.state.respond = async ({ command }) =>
    command === "admit-author"
      ? admitted.promise
      : { ok: true, status: { ...old, state: "paused", enabled: false } };
  const event = {
    preventDefault() {
      /* The fixture has no browser form submission to cancel. */
    },
  };
  const saving = f.context.admitAuthor(event);
  await f.context.admitAuthor(event);
  assert.equal(
    f.projections.length,
    2,
    "Only one fresh manifest may be extracted"
  );
  assert.equal(f.get("admit").disabled, true);
  assert.equal(f.get("admit-form").getAttribute("aria-busy"), "true");
  assert.match(f.get("feedback").textContent, /Saving author/);
  await f.context.command("pause");
  assert.equal(f.get("admit").disabled, true);
  projection.resolve({
    kind: "author_poem_manifest",
    sourceUrl: "https://poetry.example/cat-poet-Test",
  });
  await setImmediate();
  admitted.resolve({
    ok: true,
    status: old,
    admission: { result: { status: "updated" } },
  });
  await saving;
  assert.equal(
    f.calls.filter((call) => call.command === "admit-author").length,
    1
  );
  assert.equal(f.get("admit").disabled, false);
  assert.equal(f.get("admit-form").getAttribute("aria-busy"), "false");
  assert.equal(f.get("state").textContent, "Collection paused");
  assert.match(f.get("feedback").textContent, /Author details saved/);
  assert.doesNotMatch(f.get("feedback").textContent, /Author added/);
});

test("source cooldown hides Retry while network backoff offers an immediate retry", async () => {
  const f = await fixture({
    hasStarted: true,
    enabled: true,
    state: "cooldown",
    retryAt: new Date(Date.now() + 60000).toISOString(),
    error: { code: "SOURCE_COOLDOWN", message: "Wait for the source" },
  });
  assert.equal(f.get("state").textContent, "Waiting for the source");
  assert.equal(f.button("retry").hidden, true);
  assert.equal(f.button("pause").disabled, false);
  await f.refresh({
    error: { code: "NATIVE_TIMEOUT", message: "Network unavailable" },
  });
  assert.equal(f.get("state").textContent, "Waiting to retry");
  assert.equal(f.button("retry").hidden, false);
});

test("live status and Arabic names retain semantics without rewriting the same alert on every poll", async () => {
  const f = await fixture({
    state: "error",
    error: { message: "Check the bridge" },
  });
  const writes = f.get("status-error").textWrites;
  await f.refresh({});
  await f.refresh({});
  assert.equal(f.get("status-error").textWrites, writes);
  assert.equal(f.get("state").getAttribute("aria-live"), "polite");
  assert.equal(f.get("feedback").hidden, false);
  assert.equal(f.get("author").getAttribute("lang"), "ar");
  assert.equal(f.get("author-name").getAttribute("lang"), "ar");
  assert.equal(f.get("review-author").getAttribute("lang"), "ar");
});

test("explicit Start and Pause move focus to their counterpart while polling preserves input focus", async () => {
  const f = await fixture();
  f.state.respond = async ({ command }) => {
    if (command === "start")
      Object.assign(f.state.status, {
        state: "idle",
        hasStarted: true,
        enabled: true,
      });
    if (command === "pause")
      Object.assign(f.state.status, { state: "paused", enabled: false });
    return { ok: true, status: structuredClone(f.state.status) };
  };
  f.button("start").focus();
  await f.context.command("start");
  assert.equal(f.document.activeElement, f.button("pause"));
  await f.context.command("pause");
  assert.equal(f.document.activeElement, f.button("resume"));
  f.get("author-name").focus();
  await f.refresh({ enabled: true, state: "collecting" });
  assert.equal(f.document.activeElement, f.get("author-name"));
});

test("an old polling error cannot replace explicit pause feedback", async () => {
  const f = await fixture({
    hasStarted: true,
    enabled: true,
    state: "collecting",
  });
  const status = Promise.withResolvers();
  f.state.respond = async ({ command }) =>
    command === "get-status"
      ? status.promise
      : {
          ok: true,
          status: { ...f.state.status, state: "paused", enabled: false },
        };
  const poll = f.context.command("get-status");
  await f.context.command("pause");
  status.reject(new Error("Old bridge failure"));
  await poll;
  assert.match(f.get("feedback").textContent, /Collection paused/);
});

test("failed manifest extraction releases admission ownership and reports the failure", async () => {
  const f = await fixture({}, "https://poetry.example/cat-poet-Test");
  f.state.projection = async () => ({ error: "SOURCE_HUMAN_REQUIRED" });
  await f.context.admitAuthor({
    preventDefault() {
      /* The fixture has no browser form submission to cancel. */
    },
  });
  assert.equal(f.get("admit").disabled, false);
  assert.equal(f.get("admit-form").getAttribute("aria-busy"), "false");
  assert.equal(
    f.calls.some((call) => call.command === "admit-author"),
    false
  );
  assert.equal(f.get("feedback").textContent, "SOURCE_HUMAN_REQUIRED");
});
