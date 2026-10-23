import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { URL } from "node:url";
import vm from "node:vm";

const source = readFileSync(
  new URL("../chrome/saqi-collector/background.ts", import.meta.url),
  "utf8"
);
const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

function fixture(collector, createAlarm = async () => undefined) {
  const handlers = {};
  const warnings = [];
  const event = (name) => ({
    addListener(listener) {
      handlers[name] = listener;
    },
  });
  const chrome = {
    runtime: {
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessage: event("message"),
    },
    alarms: { create: createAlarm, onAlarm: event("alarm") },
  };
  const context = vm.createContext({
    SAQI_SOURCE_ORIGIN: "https://poetry.example",
    chrome,
    console: {
      warn: (...warning) => {
        warnings.push(warning);
      },
    },
    importScripts() {
      /* The real controller is injected without executing a browser service. */
    },
    projectSaqiPage() {
      /* Background startup only passes the extractor to the controller. */
    },
    createSaqiCollector: () => collector,
  });
  vm.runInContext(stripTypeScriptTypes(source), context);
  return { handlers, warnings };
}

test("a rejected controller command sends one structured response", async () => {
  const f = fixture({
    command: async () => {
      throw new Error("Storage unavailable");
    },
  });
  const replies = [];
  assert.equal(
    f.handlers.message({ command: "get-status" }, {}, (reply) => {
      replies.push(reply);
    }),
    true
  );
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error.code, "COLLECTOR_ERROR");
  assert.equal(replies[0].error.message, "Storage unavailable");
});

test("a closed response channel is reported without sending a second response", async () => {
  const f = fixture({ command: async () => ({ ok: true }) });
  let responses = 0;
  f.handlers.message({}, {}, () => {
    responses += 1;
    throw new Error("Popup closed");
  });
  await settle();
  assert.equal(responses, 1);
  assert.equal(f.warnings.length, 1);
});

test("a rejected command with a closed response channel still sends only once", async () => {
  const f = fixture({
    command: async () => {
      throw new Error("Storage unavailable");
    },
  });
  let responses = 0;
  f.handlers.message({}, {}, () => {
    responses += 1;
    throw new Error("Popup closed");
  });
  await settle();
  assert.equal(responses, 1);
  assert.equal(f.warnings.length, 1);
});

test("installed startup and alarm failures retain rejection ownership", async () => {
  let ticks = 0;
  const f = fixture(
    {
      tick: async () => {
        ticks += 1;
        throw new Error("Collector storage unavailable");
      },
    },
    async () => {
      throw new Error("Alarm unavailable");
    }
  );
  f.handlers.installed();
  f.handlers.startup();
  f.handlers.alarm({ name: "collect" });
  f.handlers.alarm({ name: "unrelated" });
  await settle();
  assert.equal(ticks, 3);
  assert.equal(f.warnings.length, 5);
});
