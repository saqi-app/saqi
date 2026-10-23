/* global console -- Chrome service-worker diagnostics. */
importScripts("project.js", "controller.js");
const collector = globalThis.createSaqiCollector(chrome, projectSaqiPage);
function reportFailure(failure) {
  console.warn("Collector background operation unavailable", failure.message);
}
function wake() {
  chrome.alarms.create("collect", { periodInMinutes: 1 }).catch(reportFailure);
  collector.tick().catch(reportFailure);
}
chrome.runtime.onInstalled.addListener(wake);
chrome.runtime.onStartup.addListener(wake);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "collect") collector.tick().catch(reportFailure);
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  collector
    .command(message)
    .catch((failure) => ({
      ok: false,
      error: {
        code: failure.code || "COLLECTOR_ERROR",
        message: failure.message || "Collector command unavailable",
      },
    }))
    .then(sendResponse)
    .catch(reportFailure);
  return true;
});
