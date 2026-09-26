importScripts("project.js");
function sendNative(port, message) {
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- Chrome Native Port uses an allowlisted host, not a window origin.
  port.postMessage(message);
}
let busy = false;
// Browser service workers do not provide node:timers/promises.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Collector disconnected"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
chrome.runtime.onInstalled.addListener(() =>
  chrome.alarms.create("collect", { periodInMinutes: 1 }),
);
chrome.runtime.onStartup.addListener(() =>
  chrome.alarms.create("collect", { periodInMinutes: 1 }),
);
chrome.alarms.onAlarm.addListener(() => {
  void collect();
});
chrome.action.onClicked.addListener(() => {
  void collect();
});
async function collect() {
  if (busy) return;
  busy = true;
  let port;
  let heartbeat;
  const pending = new Map();
  let serial = 0;
  const controller = new AbortController();
  // eslint-disable-next-line @sarj/no-fat-try-blocks -- The entire author session shares one error report and native-port cleanup boundary.
  try {
    port = chrome.runtime.connectNative("app.saqi.collector");
    port.onMessage.addListener((reply) => {
      const promise = pending.get(reply.id);
      if (!promise) return;
      pending.delete(reply.id);
      if (reply.ok) promise.resolve(reply);
      else promise.reject(new Error(reply.error));
    });
    port.onDisconnect.addListener(() => {
      controller.abort();
      for (const p of pending.values())
        p.reject(
          new Error(
            chrome.runtime.lastError?.message || "Native rig disconnected",
          ),
        );
      pending.clear();
    });
    const call = (action, data = {}) =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        sendNative(port, { id, action, ...data });
      });
    heartbeat = setInterval(() => {
      void call("heartbeat").catch((error) => {
        console.error(error);
        controller.abort();
      });
    }, 30000);
    const { author } = await call("begin");
    if (!author) return;
    let { collectorTab } = await chrome.storage.session.get("collectorTab");
    let tab = collectorTab
      ? await chrome.tabs.get(collectorTab).catch((error) => {
          console.warn("Collector tab closed", error);
          return null;
        })
      : null;
    if (!tab) {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      collectorTab = tab.id;
      await chrome.storage.session.set({ collectorTab });
    }
    const visit = async (url) => {
      await call("origin");
      await sleep(13000, controller.signal);
      await chrome.tabs.update(collectorTab, { url });
      for (let i = 0; i < 60; i++) {
        // eslint-disable-next-line no-await-in-loop -- Sequential source pacing and native session state must not overlap.
        await sleep(1000, controller.signal);
        // eslint-disable-next-line no-await-in-loop -- Sequential source pacing and native session state must not overlap.
        const current = await chrome.tabs.get(collectorTab);
        if (current.status !== "complete" || current.url !== url) continue;
        // eslint-disable-next-line no-await-in-loop -- Sequential source pacing and native session state must not overlap.
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: collectorTab },
          func: projectSaqiPage,
          args: [author.sourceUrl],
        });
        if (result?.error === "SOURCE_HUMAN_REQUIRED")
          throw new Error(
            "SOURCE_HUMAN_REQUIRED: verify in the personal Chrome collector tab",
          );
        if (result?.error === "SOURCE_CONTENT_NOT_READY") continue;
        if (result?.error) throw new Error(result.error);
        return result;
      }
      throw new Error("Source page did not become ready");
    };
    const { poems } = await call("manifest", {
      projection: await visit(author.sourceUrl),
    });
    for (const poem of poems) {
      // eslint-disable-next-line no-await-in-loop -- Sequential source pacing and native session state must not overlap.
      await call("prepare", { poemId: poem.numericId });
      // eslint-disable-next-line no-await-in-loop -- Sequential source pacing and native session state must not overlap.
      await call("poem", { projection: await visit(poem.href) });
    }
    await call("complete");
    await chrome.action.setBadgeText({ text: "" });
  } catch (error) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: `Saqi: ${error.message}` });
    if (port) {
      try {
        sendNative(port, {
          id: ++serial,
          action: "error",
          message: error.message,
        });
        await sleep(250);
      } catch (reportError) {
        console.error("Native error reporting failed", reportError);
        await chrome.action.setTitle({
          title: "Saqi native bridge disconnected; check the monitor",
        });
      }
    }
  } finally {
    clearInterval(heartbeat);
    port?.disconnect();
    busy = false;
  }
}
