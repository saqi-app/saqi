/* global projectSaqiAuthorPreview -- The shared project.ts exposes the serialized author preview. */
const element = (id) => document.getElementById(id);
const pending = new Set();
const controlActions = ["start", "pause", "resume", "retry"];
const actionMessages = new Map([
  [
    "start",
    { pending: "Starting collection…", complete: "Collection started." },
  ],
  [
    "pause",
    {
      pending: "Pausing collection…",
      complete: "Collection paused. Your place is kept.",
    },
  ],
  [
    "resume",
    { pending: "Resuming collection…", complete: "Collection resumed." },
  ],
  ["retry", { pending: "Retrying collection…", complete: "Retry requested." }],
  [
    "open-collector",
    { pending: "Opening collector tab…", complete: "Collector tab opened." },
  ],
  [
    "ack-review",
    {
      pending: "Dismissing review notice…",
      complete: "Review notice dismissed.",
    },
  ],
  ["admit-author", { pending: "Saving author…" }],
  [
    "get-status",
    {
      pending: "Refreshing collector status…",
      complete: "Collector status refreshed.",
    },
  ],
]);
let requestSequence = 0;
let stateRequest = 0;
let feedbackRequest = 0;
let preview;
let reviewLinksKey;
let connectionError = false;
const labels = {
  idle: "Ready for the next author",
  collecting: "Collecting poems",
  paused: "Collection paused",
  // eslint-disable-next-line @sarj/require-camelcase-properties -- State name comes from the shared native protocol.
  human_required: "Verification needed",
  cooldown: "Waiting for the source",
  error: "Needs attention",
};
const guidance = {
  idle: "Finished authors are skipped. New work is checked every minute.",
  collecting:
    "Source pages are visited one at a time, with a pause between requests.",
  paused:
    "Your place is kept in the shared database. Resume when you are ready.",
  // eslint-disable-next-line @sarj/require-camelcase-properties -- State name comes from the shared native protocol.
  human_required:
    "Open the collector tab, finish the site's verification, then retry. Automatic collection is waiting.",
  cooldown: "Collection will continue after the source cooldown ends.",
  error: "Check the message below, fix the issue, then retry.",
};
async function command(
  action,
  data = {},
  { prepare, announce = action !== "get-status" } = {}
) {
  if (commandPending(action)) return;
  const request = { action, id: ++requestSequence };
  pending.add(action);
  if (!["get-status", "open-collector"].includes(action))
    stateRequest = request.id;
  const focused = document.activeElement;
  const focusFrom = focused?.dataset?.command === action ? focused : null;
  let rendered = false;
  updateBusy();
  if (announce)
    requestFeedback(request, actionMessages.get(action)?.pending || "Working…");
  try {
    const payload = prepare ? await prepare() : data;
    const reply = await chrome.runtime.sendMessage({
      command: action,
      ...payload,
    });
    if (
      reply?.status &&
      action !== "open-collector" &&
      request.id >= stateRequest
    ) {
      stateRequest = request.id;
      render(reply.status);
      rendered = true;
    }
    if (!reply?.ok)
      throw new Error(
        reply?.error?.message ||
          reply?.error?.code ||
          "The collector could not complete this action."
      );
    if (announce) {
      requestFeedback(request, successMessage(action, reply));
      connectionError = false;
    } else if (request.id >= feedbackRequest) {
      if (connectionError) requestFeedback(request, "");
      connectionError = false;
    }
    return reply;
  } catch (error) {
    if (requestFeedback(request, error.message, true))
      connectionError = action === "get-status";
  } finally {
    pending.delete(action);
    updateBusy();
    if (rendered && request.id === stateRequest) restoreFocus(focusFrom);
  }
}

function commandPending(action) {
  if (pending.has(action)) return true;
  if (controlActions.includes(action) && action !== "pause")
    return controlPending();
  return (
    action === "get-status" &&
    (controlPending() ||
      pending.has("admit-author") ||
      pending.has("ack-review"))
  );
}

function updateBusy() {
  for (const button of document.querySelectorAll("button")) {
    const action =
      button.dataset.command ||
      (button === element("refresh") ? "get-status" : "admit-author");
    button.disabled =
      action !== "pause" && controlActions.includes(action)
        ? controlPending()
        : pending.has(action);
  }
  element("admit-form").setAttribute(
    "aria-busy",
    String(pending.has("admit-author"))
  );
}

function restoreFocus(focused) {
  if (
    !focused?.hidden ||
    (document.activeElement !== focused &&
      document.activeElement !== document.body)
  )
    return;
  const counterpart = focused.dataset.command === "pause" ? "resume" : "pause";
  for (const button of document.querySelectorAll("[data-command]"))
    if (
      button.dataset.command === counterpart &&
      !button.hidden &&
      !button.disabled
    )
      button.focus();
}

function successMessage(action, reply) {
  if (action === "admit-author") {
    const saved =
      reply.admission?.result?.status === "created"
        ? "Author added to the shared corpus."
        : "Author details saved. Existing completed authors remain complete.";
    return `${saved} Your collection setting is unchanged.`;
  }
  if (
    ["start", "resume", "retry"].includes(action) &&
    sourceCooldown(reply.status)
  )
    return "Collection will continue after the source cooldown ends.";
  return actionMessages.get(action)?.complete || "Action completed.";
}

function requestFeedback(request, message, error = false) {
  if (
    (request.action === "get-status" && request.id < feedbackRequest) ||
    (controlActions.includes(request.action) && request.id < stateRequest)
  )
    return false;
  feedbackRequest = Math.max(feedbackRequest, request.id);
  feedback(message, error);
  return true;
}

function feedback(message, error = false) {
  text("feedback", message);
  element("feedback").dataset.error = String(error);
}

function controlPending() {
  return controlActions.some((action) => pending.has(action));
}

function sourceCooldown(status) {
  return (
    status?.error?.code === "SOURCE_COOLDOWN" &&
    Date.parse(status.retryAt) > Date.now()
  );
}

function render(status) {
  if (!status) return;
  const contactAge = Date.now() - Date.parse(status.seenAt);
  const disconnected =
    status.disconnected ||
    !Number.isFinite(contactAge) ||
    contactAge < 0 ||
    contactAge > 150000;
  renderHeading(status, disconnected);
  text("connection", `Last bridge contact: ${timestamp(status.seenAt)}`);
  text(
    "last-progress",
    `Last collection progress: ${timestamp(status.progressAt)}`
  );
  text("retry-time", `Next retry: ${timestamp(status.retryAt)}`);
  element("retry-time").hidden = !status.retryAt;
  renderCurrent(status.current);
  renderControls(status, disconnected);
  renderSummaries(status);
  element("status-error").hidden = !status.error;
  text("status-error", status.error?.message || status.error?.code || "");
}

function renderHeading(status, disconnected) {
  let title = labels[status.state] || "Status unavailable";
  let detail = guidance[status.state] || "Refresh to check the collector.";
  if (status.state === "cooldown" && !sourceCooldown(status)) {
    title = "Waiting to retry";
    detail =
      "Collection will retry automatically. Retry now when the problem is fixed.";
  }
  if (disconnected) {
    title = "Collector disconnected";
    detail =
      "The native bridge has not checked in. Keep Chrome open and check the Mac rig setup.";
  }
  if (!status.hasStarted) {
    const setupNeeded =
      disconnected || status.error || status.state === "error";
    title = setupNeeded ? "Setup needed" : "Ready to start";
    detail = setupNeeded
      ? "The native bridge must connect successfully before collection can start. Check the Mac rig setup, then refresh."
      : "Start to collect authors and poems using your personal Chrome session.";
  }
  text("state", title);
  text("guidance", detail);
  const attention =
    disconnected ||
    status.error ||
    ["error", "human_required", "cooldown"].includes(status.state);
  element("indicator").dataset.tone = attention
    ? "attention"
    : status.state === "collecting"
      ? "active"
      : "idle";
}

function renderCurrent(current) {
  element("author").hidden = !current;
  element("progress").hidden = !current;
  element("counts").hidden = !current;
  text("author", current?.authorName || "");
  text(
    "progress",
    `${current?.processed ?? 0} of ${current?.total ?? 0} poems processed`
  );
  for (const key of ["added", "updated", "unchanged", "reviewRequired"])
    text(key, String(current?.[key] ?? 0));
}

function renderControls(status, disconnected) {
  const visibility = {
    start:
      !status.hasStarted &&
      !disconnected &&
      !status.error &&
      status.state !== "error",
    pause: status.hasStarted && status.enabled,
    resume: status.hasStarted && !status.enabled,
    retry:
      status.hasStarted &&
      status.enabled &&
      !sourceCooldown(status) &&
      ["error", "human_required", "cooldown"].includes(status.state),
  };
  for (const button of document.querySelectorAll("[data-command]")) {
    button.hidden = visibility[button.dataset.command] === false;
  }
}

function renderSummaries(status) {
  element("review").hidden = !status.reviewWarning;
  if (status.reviewWarning) {
    const warning = status.reviewWarning;
    text("review-author", warning.authorName || "");
    text(
      "review-detail",
      `: ${warning.total} poem(s) need review. ${warning.sourceUrl || ""}`
    );
  }
  const reviewIds = [...new Set(status.reviewWarning?.poemIds || [])]
    .filter(
      (id) =>
        // eslint-disable-next-line no-restricted-syntax -- Native status is untrusted in this plain browser script; require a string before constructing a source URL.
        typeof id === "string" &&
        /^[1-9]\d*$/.test(id) &&
        Number.isSafeInteger(Number(id))
    )
    .slice(0, 20);
  element("review-poems").hidden = reviewIds.length === 0;
  const linksKey = JSON.stringify(reviewIds);
  if (linksKey !== reviewLinksKey) {
    reviewLinksKey = linksKey;
    const help = document.createElement("p");
    help.textContent =
      "Review these source pages before importing (up to 20 shown). Links open in a new tab.";
    const links = document.createElement("ul");
    links.className = "review-links";
    for (const id of reviewIds) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `${SAQI_SOURCE_ORIGIN}/poem${id}.html`;
      link.textContent = `Source poem ${id}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
      links.append(item);
    }
    element("review-poems").replaceChildren(help, links);
  }
  element("last-completed").hidden = !status.lastCompleted;
  if (status.lastCompleted) {
    const last = status.lastCompleted;
    text("completed-author", last.authorName || "");
    text(
      "completed-detail",
      ` · ${timestamp(last.completedAt)} · ${last.added ?? 0} added, ${last.updated ?? 0} updated, ${last.unchanged ?? 0} unchanged, ${last.reviewRequired ?? 0} need review`
    );
  }
}

function timestamp(value) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

async function prepareAuthor() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.url || !isAuthorPage(tab.url)) return;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: projectSaqiAuthorPreview,
      args: [SAQI_SOURCE_ORIGIN],
    });
    if (!result || result.error) {
      text(
        "preview-help",
        result?.error === "SOURCE_HUMAN_REQUIRED"
          ? "Finish verification on this author page, then reopen the popup."
          : "The author name could not be verified on this page. Let the page finish loading, then reopen the popup."
      );
      return;
    }
    preview = { ...result, tabId: tab.id };
    element("author-name").value = result.nameArabic;
    text("author-url", result.sourceUrl);
    element("admit-form").hidden = false;
    element("preview-help").hidden = true;
  } catch (error) {
    text("preview-help", `Author preview unavailable: ${error.message}`);
  }
}

async function admitAuthor(event) {
  event.preventDefault();
  if (!preview) return;
  await command(
    "admit-author",
    {},
    {
      prepare: async () => {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: preview.tabId },
          func: projectSaqiPage,
          args: [preview.sourceUrl],
        });
        if (!result || result.error)
          throw new Error(result?.error || "The author page is not ready.");
        return {
          projection: result,
          nameArabic: element("author-name").value.trim(),
        };
      },
    }
  );
}

function text(id, value) {
  const target = element(id);
  if (target.textContent !== value) target.textContent = value;
}

for (const button of document.querySelectorAll("[data-command]"))
  button.addEventListener("click", () => void command(button.dataset.command));
element("refresh").addEventListener(
  "click",
  () => void command("get-status", {}, { announce: true })
);
element("admit-form").addEventListener(
  "submit",
  (event) => void admitAuthor(event)
);
void command("get-status");
void prepareAuthor();
setInterval(() => void command("get-status"), 5000);

function isAuthorPage(value: string): boolean {
  const url = new URL(value);
  return (
    url.origin === SAQI_SOURCE_ORIGIN &&
    /^\/cat-poet-[^/]+\/?$/u.test(url.pathname)
  );
}
