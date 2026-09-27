/* global projectSaqiAuthorPreview -- The shared project.js exposes the serialized author preview. */
const element = (id) => document.getElementById(id);
let pending = false;
let preview;
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
  idle: "The collector checks for the next author every minute.",
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
function text(id, value) {
  element(id).textContent = value;
}
function feedback(message, error = false) {
  text("feedback", message);
  element("feedback").hidden = !message;
  element("feedback").dataset.error = String(error);
}
async function command(action, data = {}) {
  if (pending) return;
  pending = true;
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({
      command: action,
      ...data,
    });
    if (action !== "get-status" || connectionError) feedback("");
    connectionError = false;
    render(reply.status);
    if (!reply.ok)
      throw new Error(
        reply.error?.message ||
          reply.error?.code ||
          "The collector could not complete this action.",
      );
    return reply;
  } catch (error) {
    connectionError = action === "get-status";
    feedback(error.message, true);
  } finally {
    pending = false;
    for (const button of document.querySelectorAll("button"))
      button.disabled = false;
  }
}
function render(status) {
  if (!status) return;
  const disconnected =
    status.disconnected ||
    !Number.isFinite(Date.parse(status.seenAt)) ||
    Date.now() - Date.parse(status.seenAt) > 150000;
  renderHeading(status, disconnected);
  text("connection", `Last bridge contact: ${timestamp(status.seenAt)}`);
  text(
    "last-progress",
    `Last collection progress: ${timestamp(status.progressAt)}`,
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
    `${current?.processed ?? 0} of ${current?.total ?? 0} poems processed`,
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
    text(
      "review-detail",
      `${warning.authorName}: ${warning.total} poem(s) need review. ${warning.sourceUrl || ""}`,
    );
  }
  const reviewIds = status.reviewWarning?.poemIds?.slice(0, 20) || [];
  element("review-poems").hidden = reviewIds.length === 0;
  text(
    "review-poems",
    `Source poem IDs (up to 20): ${reviewIds.join(", ")}. Review their identity before importing.`,
  );
  element("last-completed").hidden = !status.lastCompleted;
  if (status.lastCompleted) {
    const last = status.lastCompleted;
    text(
      "completed-detail",
      `${last.authorName} · ${timestamp(last.completedAt)} · ${last.added ?? 0} added, ${last.updated ?? 0} updated, ${last.unchanged ?? 0} unchanged, ${last.reviewRequired ?? 0} need review`,
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
    if (
      !tab?.url ||
      !/^https:\/\/www\.aldiwan\.net\/cat-poet-[^/?#]+\/?(?:[?#].*)?$/.test(
        tab.url,
      )
    )
      return;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: projectSaqiAuthorPreview,
    });
    if (!result || result.error) {
      text(
        "preview-help",
        result?.error === "SOURCE_HUMAN_REQUIRED"
          ? "Finish verification on this author page, then reopen the popup."
          : "The author name could not be verified on this page. Let the page finish loading, then reopen the popup.",
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
  if (!preview || pending) return;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: preview.tabId },
      func: projectSaqiPage,
      args: [preview.sourceUrl],
    });
    if (!result || result.error)
      throw new Error(result?.error || "The author page is not ready.");
    const reply = await command("admit-author", {
      projection: result,
      nameArabic: element("author-name").value.trim(),
    });
    if (reply)
      feedback(
        "Author added to the shared corpus. Your collection setting is unchanged.",
      );
  } catch (error) {
    feedback(error.message, true);
  }
}
for (const button of document.querySelectorAll("[data-command]"))
  button.addEventListener("click", () => void command(button.dataset.command));
element("refresh").addEventListener("click", () => void command("get-status"));
element("admit-form").addEventListener(
  "submit",
  (event) => void admitAuthor(event),
);
void command("get-status");
void prepareAuthor();
setInterval(() => void command("get-status"), 5000);
