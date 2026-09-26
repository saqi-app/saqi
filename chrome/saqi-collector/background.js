importScripts("project.js");
let busy = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  try {
    port = chrome.runtime.connectNative("app.saqi.collector");
    port.onMessage.addListener((reply) => {
      const promise = pending.get(reply.id);
      if (!promise) return;
      pending.delete(reply.id);
      reply.ok
        ? promise.resolve(reply)
        : promise.reject(new Error(reply.error));
    });
    port.onDisconnect.addListener(() => {
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
        port.postMessage({ id, action, ...data });
      });
    heartbeat = setInterval(() => {
      void call("heartbeat").catch(() => {});
    }, 30000);
    const { author } = await call("begin");
    if (!author) return;
    let { collectorTab } = await chrome.storage.session.get("collectorTab");
    let tab = collectorTab
      ? await chrome.tabs.get(collectorTab).catch(() => null)
      : null;
    if (!tab) {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      collectorTab = tab.id;
      await chrome.storage.session.set({ collectorTab });
    }
    const visit = async (url) => {
      await call("origin");
      await sleep(13000);
      await chrome.tabs.update(collectorTab, { url });
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const current = await chrome.tabs.get(collectorTab);
        if (current.status !== "complete" || current.url !== url) continue;
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
      await call("prepare", { poemId: poem.numericId });
      await call("poem", { projection: await visit(poem.href) });
    }
    await call("complete");
    await chrome.action.setBadgeText({ text: "" });
  } catch (error) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: `Saqi: ${error.message}` });
    if (port) {
      try {
        port.postMessage({
          id: ++serial,
          action: "error",
          message: error.message,
        });
        await sleep(250);
      } catch {}
    }
  } finally {
    clearInterval(heartbeat);
    port?.disconnect();
    busy = false;
  }
}
