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
    .then(async (stored) => {
      control = { ...control, ...stored.collectorControl };
      snapshot = stored.collectorStatus || snapshot;
      // Older workers left source conflicts blocked. A fresh session re-reads
      // the source and D1 hash; exhausted conflicts use a distinct code below.
      if (control.blocked && control.error?.code === "SOURCE_CHANGED")
        await saveControl({
          blocked: false,
          retryAt: null,
          retryCount: 0,
          error: null,
        });
    });
  ready.catch(() => {
    /* Commands and alarm ticks report the original initialization failure. */
  });
  async function command(input) {
    try {
      await ready;
      let admission;
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
          await resumeCollection();
          break;
        case "pause":
          await pauseCollection();
          break;
        case "open-collector":
          await collectorTab(true);
          break;
        case "ack-review":
          await oneShot("acknowledge-review");
          break;
        case "admit-author": {
          const { author, poemCount, result } = await oneShot("admit-author", {
            projection: input.projection,
            nameArabic: input.nameArabic,
          });
          admission = { author, poemCount, result };
          break;
        }
        default:
          throw error("UNKNOWN_COMMAND");
      }
      const reply = {
        ok: true,
        status: currentStatus(),
      };
      if (admission) reply.admission = admission;
      return reply;
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

  function currentStatus() {
    const contactAge = now() - Date.parse(snapshot.seenAt);
    return {
      ...controlledStatus(snapshot),
      enabled: control.enabled,
      hasStarted: control.hasStarted,
      disconnected:
        !Number.isFinite(contactAge) || contactAge < 0 || contactAge > 150000,
    };
  }

  async function resumeCollection() {
    const sourceCooldown =
      control.error?.code === "SOURCE_COOLDOWN" &&
      Date.parse(control.retryAt) > now();
    const next = { enabled: true, hasStarted: true, blocked: false };
    if (!sourceCooldown) {
      next.retryAt = null;
      next.retryCount = 0;
      next.error = null;
    }
    await saveControl(next);
    await display({
      ...snapshot,
      state: sourceCooldown ? "cooldown" : "idle",
      error: sourceCooldown ? control.error : null,
      retryAt: sourceCooldown ? control.retryAt : null,
    });
    scheduleTick();
  }

  function scheduleTick() {
    const task =
      running && cancellation?.signal.aborted
        ? running.then(() => tick())
        : tick();
    task.catch(reportCollectorFailure);
  }

  async function pauseCollection() {
    await saveControl({ enabled: false });
    cancellation?.abort(error("COLLECTOR_PAUSED"));
    await display({ ...snapshot, state: "paused", error: null });
    if (running) return;
    if (standalone) {
      standalone
        .then(() => {
          if (!control.enabled && !running)
            return oneShot("set-control", { state: "paused" });
        })
        .catch(reportCollectorFailure);
    } else await oneShot("set-control", { state: "paused" });
  }

  async function tick() {
    await ready;
    // eslint-disable-next-line no-await-in-loop -- Recheck ownership when multiple queued commands finish the same native request.
    while (standalone) await standalone;
    if (!running)
      running = session().finally(() => {
        running = null;
      });
    await running;
  }

  async function session() {
    cancellation = new AbortController();
    let heartbeat;
    // eslint-disable-next-line @sarj/no-fat-try-blocks -- Every operation belongs to one native session with shared cleanup and failure state.
    try {
      const sessionCancellation = cancellation;
      bridge = connect(() =>
        sessionCancellation.abort(error("NATIVE_DISCONNECTED"))
      );
      const hello = await call("hello");
      if (hello.protocol !== 1)
        throw error(
          "NATIVE_PROTOCOL_MISMATCH",
          "Update the native bridge and reload the Saqi extension."
        );
      const state = desiredState();
      await call("status", { state });
      if (state !== "idle") return;
      heartbeat = clock.setInterval(() => {
        void call("status").catch((failure) => cancellation?.abort(failure));
      }, 30000);
      // eslint-disable-next-line no-empty, no-await-in-loop -- Completing one author immediately selects the next; source navigation remains serial and paced.
      while (control.enabled && (await collect())) {}
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
      try {
        if (!control.enabled) {
          await display({ ...snapshot, state: "paused" });
          await call("set-control", { state: "paused" }).catch(
            reportCollectorFailure
          );
        }
      } finally {
        const client = bridge;
        bridge = null;
        cancellation = null;
        client?.close();
      }
    }
  }

  async function collect() {
    const { author } = await call("begin");
    if (!author) return false;
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
    return true;
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
          "Collector page redirected to an unexpected source page."
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
      "Source page did not become ready. Open the collector tab before resuming."
    );
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

  async function failed(failure) {
    if (!control.enabled || failure.code === "COLLECTOR_PAUSED") return;
    const code = failure.code || failure.message || "COLLECTOR_ERROR";
    let state = "error",
      retryAt = null;
    const network =
      /NETWORK|TIMEOUT|DISCONNECTED|UNAVAILABLE|fetch failed/iu.test(code);
    const retryable = network || code === "SOURCE_CHANGED";
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
    } else if (retryable && control.retryCount < 3) {
      state = "cooldown";
      retryAt = new Date(
        now() + [60000, 120000, 300000][control.retryCount]
      ).toISOString();
    }
    const detail =
      code === "SOURCE_CHANGED" && state === "error"
        ? {
            code: "SOURCE_CONFLICT_RETRY_EXHAUSTED",
            message:
              "The source changed during collection and three retries. Review the source, then retry.",
          }
        : { code, message: failure.message || code };
    await saveControl({
      blocked: state !== "cooldown",
      retryAt,
      retryCount: control.retryCount + (retryable ? 1 : 0),
      error: detail,
    });
    await display({ ...snapshot, state, error: detail, retryAt });
    await call("set-control", { state, error: detail, retryAt }).catch(
      (nativeFailure) => {
        console.warn("Native status unavailable", nativeFailure.message);
      }
    );
  }

  async function oneShot(action, data) {
    if (bridge) return call(action, data);
    // eslint-disable-next-line no-await-in-loop -- Every isolated native call owns its client until cleanup completes.
    while (standalone) await standalone;
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
          ? snapshot.current?.sourceUrl || `${SAQI_SOURCE_ORIGIN}/`
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

  async function call(action, data = {}) {
    const reply = await bridge.call(action, data);
    if (reply.status) await display(reply.status);
    return reply;
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
            detail?.retryAfter ?? reply.retryAfter
          )
        );
      }
    });
    port.onDisconnect.addListener(() => {
      rejectAll(
        error(
          "NATIVE_DISCONNECTED",
          browser.runtime.lastError?.message ||
            "Native bridge disconnected. Check the Saqi installation."
        )
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
                "The native bridge did not respond within 75 seconds."
              )
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

  async function display(status) {
    if (status) snapshot = controlledStatus(status);
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
      title: `Saqi: ${snapshot.error?.message || snapshot.state.replaceAll("_", " ")}${snapshot.reviewWarning ? "; source poems need review. Open the popup for details." : ""}`,
    });
  }

  function controlledStatus(status) {
    if (!control.enabled && control.hasStarted)
      return { ...status, state: "paused" };
    if (desiredState() === "cooldown")
      return {
        ...status,
        state: "cooldown",
        retryAt: control.retryAt,
        error: control.error,
      };
    return status;
  }

  function desiredState() {
    if (!control.enabled) return "paused";
    if (control.blocked)
      return ["SOURCE_HUMAN_REQUIRED", "SOURCE_CHALLENGE"].includes(
        control.error?.code
      )
        ? "human_required"
        : "error";
    return control.retryAt && Date.parse(control.retryAt) > now()
      ? "cooldown"
      : "idle";
  }

  async function saveControl(next) {
    control = { ...control, ...next };
    await browser.storage.local.set({ collectorControl: control });
  }

  function checkEnabled() {
    if (!control.enabled) throw error("COLLECTOR_PAUSED");
    if (cancellation?.signal.aborted) throw cancellation.signal.reason;
  }

  return { command, tick };
}

function reportCollectorFailure(failure) {
  console.warn("Collector operation unavailable", failure.message);
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
  if (url.origin !== SAQI_SOURCE_ORIGIN) return null;
  return decodeURIComponent(url.pathname).trim().replace(/\/$/u, "");
}
