/* global console -- Chrome service-worker diagnostics. */
// The popup, toolbar and native monitor describe the same current operation.
// No queue or corpus content is stored in the browser.
/* exported createSaqiCollector -- Loaded by the extension service worker and VM lifecycle tests. */
function createSaqiCollector(browser, project, clock = globalThis) {
  const now = () => clock.Date.now();
  let control = {
    enabled: false,
    hasStarted: false,
    blocked: false,
    retryAt: null,
    retryCount: 0,
  };
  let snapshot = { version: 1, state: "paused", seenAt: null, current: null };
  let running, bridge, cancellation, standalone;
  const ready = browser.storage.local
    .get(["collectorControl", "collectorStatus"])
    .then((stored) => {
      control = { ...control, ...stored.collectorControl };
      snapshot = stored.collectorStatus || snapshot;
    });
  function currentStatus() {
    return {
      ...snapshot,
      enabled: control.enabled,
      hasStarted: control.hasStarted,
      disconnected:
        !snapshot.seenAt || now() - Date.parse(snapshot.seenAt) > 150000,
    };
  }
  async function saveControl(next) {
    control = { ...control, ...next };
    await browser.storage.local.set({ collectorControl: control });
  }
  async function display(status) {
    if (status) snapshot = status;
    await browser.storage.local.set({ collectorStatus: snapshot });
    const attention = ["error", "human_required"].includes(snapshot.state);
    await browser.action.setBadgeText({
      text: attention
        ? "!"
        : snapshot.reviewWarning
          ? "?"
          : snapshot.state === "paused"
            ? "Ⅱ"
            : "",
    });
    await browser.action.setTitle({
      title: `Saqi: ${snapshot.error?.message || snapshot.state.replaceAll("_", " ")}`,
    });
  }
  function connect(disconnected) {
    const port = browser.runtime.connectNative("app.saqi.collector");
    const pending = new Map();
    let serial = 0;
    const rejectAll = (failure) => {
      for (const waiter of pending.values()) {
        clock.clearTimeout(waiter.timer);
        waiter.reject(failure);
      }
      pending.clear();
    };
    port.onMessage.addListener((reply) => {
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      clock.clearTimeout(waiter.timer);
      if (reply.ok) waiter.resolve(reply);
      else {
        const detail = reply.error;
        waiter.reject(
          error(
            detail?.code || detail || "NATIVE_ERROR",
            detail?.message || detail,
            detail?.retryAfter ?? reply.retryAfter,
          ),
        );
      }
    });
    port.onDisconnect.addListener(() => {
      rejectAll(
        error(
          "NATIVE_DISCONNECTED",
          browser.runtime.lastError?.message ||
            "Native bridge disconnected. Check the Saqi installation.",
        ),
      );
      disconnected?.();
    });
    return {
      call(action, data = {}) {
        return new Promise((resolve, reject) => {
          const id = ++serial;
          const timer = clock.setTimeout(() => {
            rejectAll(
              error(
                "NATIVE_TIMEOUT",
                "The native bridge did not respond within 75 seconds.",
              ),
            );
            port.disconnect();
          }, 75000);
          pending.set(id, { resolve, reject, timer });
          try {
            // eslint-disable-next-line unicorn/require-post-message-target-origin -- A Chrome native port has no window target origin.
            port.postMessage({ id, action, ...data });
          } catch (failure) {
            clock.clearTimeout(timer);
            pending.delete(id);
            reject(error("NATIVE_DISCONNECTED", failure.message));
          }
        });
      },
      close() {
        port.disconnect();
      },
    };
  }
  async function call(action, data = {}) {
    const reply = await bridge.call(action, data);
    if (reply.status) await display(reply.status);
    return reply;
  }
  function checkEnabled() {
    if (!control.enabled) throw error("COLLECTOR_PAUSED");
    if (cancellation?.signal.aborted) throw cancellation.signal.reason;
  }
  function sleep(ms) {
    return new Promise((resolve, reject) => {
      const signal = cancellation.signal;
      const abort = () => {
        clock.clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = clock.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function collectorTab(active = false) {
    const stored = await browser.storage.session.get("collectorTab");
    let tab = stored.collectorTab
      ? await browser.tabs.get(stored.collectorTab).catch((failure) => {
          console.warn("Collector tab closed", failure.message);
          return null;
        })
      : null;
    if (!tab) {
      tab = await browser.tabs.create({
        url: active
          ? snapshot.current?.sourceUrl || "https://www.aldiwan.net/"
          : "about:blank",
        active,
      });
      await browser.storage.session.set({ collectorTab: tab.id });
    }
    if (active) {
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
    }
    return tab;
  }
  async function visit(tab, url, authorUrl) {
    await sleep(13000);
    checkEnabled();
    await call("origin");
    checkEnabled();
    await browser.tabs.update(tab.id, { url });
    for (let attempt = 0; attempt < 60; attempt++) {
      // eslint-disable-next-line no-await-in-loop -- Serial navigation waits preserve source pacing.
      await sleep(1000);
      checkEnabled();
      // eslint-disable-next-line no-await-in-loop -- Serial navigation waits preserve source pacing.
      const current = await browser.tabs.get(tab.id);
      if (current.status !== "complete") continue;
      if (!sameSource(current.url, url))
        throw error(
          "SOURCE_REDIRECT_MISMATCH",
          "Collector page redirected to an unexpected source page.",
        );
      // eslint-disable-next-line no-await-in-loop -- Extract only the completed expected source navigation.
      const [{ result }] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: project,
        args: [authorUrl],
      });
      if (result?.error === "SOURCE_CONTENT_NOT_READY") continue;
      if (result?.error) throw error(result.error);
      return result;
    }
    throw error(
      "SOURCE_CONTENT_NOT_READY",
      "Source page did not become ready. Open the collector tab before resuming.",
    );
  }
  async function collect() {
    const { author } = await call("begin");
    if (!author) return;
    const tab = await collectorTab();
    const { poems } = await call("manifest", {
      projection: await visit(tab, author.sourceUrl, author.sourceUrl),
    });
    for (const poem of poems) {
      checkEnabled();
      // eslint-disable-next-line no-await-in-loop -- Preserve one pre-fetch hash and one source request at a time.
      await call("prepare", { poemId: poem.numericId });
      // eslint-disable-next-line no-await-in-loop -- Pause cannot interrupt an already submitted corpus write.
      await call("poem", {
        // eslint-disable-next-line no-await-in-loop -- Fetch and publish each poem in source order.
        projection: await visit(tab, poem.href, author.sourceUrl),
      });
    }
    checkEnabled();
    await call("complete");
    await saveControl({ retryCount: 0, retryAt: null });
  }
  async function failed(failure) {
    if (!control.enabled || failure.code === "COLLECTOR_PAUSED") return;
    const code = failure.code || failure.message || "COLLECTOR_ERROR";
    let state = "error",
      retryAt = null;
    const network =
      /NETWORK|TIMEOUT|DISCONNECTED|UNAVAILABLE|fetch failed/iu.test(code);
    if (code === "SOURCE_HUMAN_REQUIRED" || code === "SOURCE_CHALLENGE")
      state = "human_required";
    else if (code === "SOURCE_COOLDOWN" && failure.retryAfter) {
      const time =
        // eslint-disable-next-line no-restricted-syntax -- Native protocol permits epoch seconds or an ISO timestamp at this external boundary.
        typeof failure.retryAfter === "number"
          ? failure.retryAfter * 1000
          : Date.parse(failure.retryAfter);
      if (Number.isFinite(time) && time > now()) {
        state = "cooldown";
        retryAt = new Date(time).toISOString();
      }
    } else if (network && control.retryCount < 3) {
      state = "cooldown";
      retryAt = new Date(
        now() + [60000, 120000, 300000][control.retryCount],
      ).toISOString();
    }
    const detail = { code, message: failure.message || code };
    await saveControl({
      blocked: state !== "cooldown",
      retryAt,
      retryCount: control.retryCount + (network ? 1 : 0),
      error: detail,
    });
    await display({ ...snapshot, state, error: detail, retryAt });
    await call("set-control", { state, error: detail, retryAt }).catch(
      (reportFailure) => {
        console.warn("Native status unavailable", reportFailure.message);
      },
    );
  }
  async function session() {
    cancellation = new AbortController();
    let heartbeat;
    // eslint-disable-next-line @sarj/no-fat-try-blocks -- Every operation belongs to one native session with shared cleanup and failure state.
    try {
      const sessionCancellation = cancellation;
      bridge = connect(() =>
        sessionCancellation.abort(error("NATIVE_DISCONNECTED")),
      );
      const hello = await call("hello");
      if (hello.protocol !== 1)
        throw error(
          "NATIVE_PROTOCOL_MISMATCH",
          "Update the native bridge and reload the Saqi extension.",
        );
      const state = desiredState();
      await call("status", { state });
      if (state !== "idle") return;
      heartbeat = clock.setInterval(() => {
        void call("status").catch((failure) => cancellation?.abort(failure));
      }, 30000);
      await collect();
    } catch (failure) {
      await failed(failure);
      if (!control.enabled && failure.code !== "COLLECTOR_PAUSED")
        await display({
          ...snapshot,
          state: "paused",
          error: {
            code: failure.code || "NATIVE_SETUP_REQUIRED",
            message: failure.message,
          },
        });
    } finally {
      clock.clearInterval(heartbeat);
      if (!control.enabled) {
        await display({ ...snapshot, state: "paused" });
        await call("set-control", { state: "paused" }).catch(
          (reportFailure) => {
            console.warn("Native status unavailable", reportFailure.message);
          },
        );
      }
      bridge?.close();
      bridge = null;
      cancellation = null;
    }
  }
  function desiredState() {
    if (!control.enabled) return "paused";
    if (control.blocked)
      return ["SOURCE_HUMAN_REQUIRED", "SOURCE_CHALLENGE"].includes(
        control.error?.code,
      )
        ? "human_required"
        : "error";
    return control.retryAt && Date.parse(control.retryAt) > now()
      ? "cooldown"
      : "idle";
  }
  async function tick() {
    await ready;
    if (standalone) await standalone;
    if (!running)
      running = session().finally(() => {
        running = null;
      });
    await running;
  }
  async function oneShot(action, data) {
    if (bridge) return call(action, data);
    if (standalone) await standalone;
    if (bridge) return call(action, data);
    standalone = isolatedCall(action, data).finally(() => {
      standalone = null;
    });
    return standalone;
  }
  async function isolatedCall(action, data) {
    const client = connect();
    try {
      const hello = await client.call("hello");
      if (hello.protocol !== 1) throw error("NATIVE_PROTOCOL_MISMATCH");
      const reply = await client.call(action, data);
      if (reply.status) await display(reply.status);
      return reply;
    } finally {
      client.close();
    }
  }
  async function command(input) {
    await ready;
    try {
      switch (input.command) {
        case "get-status":
          if (
            !running &&
            (!snapshot.seenAt || now() - Date.parse(snapshot.seenAt) > 60000)
          )
            await oneShot("status", { state: desiredState() });
          break;
        case "start":
        case "resume":
        case "retry":
          await saveControl({
            enabled: true,
            hasStarted: true,
            blocked: false,
            retryAt: null,
            retryCount: 0,
            error: null,
          });
          await display({
            ...snapshot,
            state: "idle",
            error: null,
            retryAt: null,
          });
          if (running && cancellation?.signal.aborted)
            void running.then(() => tick());
          else void tick();
          break;
        case "pause":
          await saveControl({ enabled: false });
          cancellation?.abort(error("COLLECTOR_PAUSED"));
          await display({ ...snapshot, state: "paused", error: null });
          if (!running) await oneShot("set-control", { state: "paused" });
          break;
        case "open-collector":
          await collectorTab(true);
          break;
        case "ack-review":
          await oneShot("acknowledge-review");
          break;
        case "admit-author":
          await oneShot("admit-author", {
            projection: input.projection,
            nameArabic: input.nameArabic,
          });
          break;
        default:
          throw error("UNKNOWN_COMMAND");
      }
      return { ok: true, status: currentStatus() };
    } catch (failure) {
      return {
        ok: false,
        error: {
          code: failure.code || "COLLECTOR_ERROR",
          message: failure.message,
        },
        status: currentStatus(),
      };
    }
  }
  return { command, tick };
}

function error(code, message, retryAfter) {
  return Object.assign(new Error(message || code), { code, retryAfter });
}

function sameSource(actual, expected) {
  return (
    canonicalSource(actual) !== null &&
    canonicalSource(actual) === canonicalSource(expected)
  );
}

function canonicalSource(value) {
  const url = new URL(value);
  if (url.origin !== "https://www.aldiwan.net") return null;
  return decodeURIComponent(url.pathname).trim().replace(/\/$/u, "");
}
