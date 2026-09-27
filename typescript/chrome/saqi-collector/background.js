importScripts("project.js", "controller.js");
const collector = globalThis.createSaqiCollector(chrome, projectSaqiPage);
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("collect", { periodInMinutes: 1 });
  void collector.tick();
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create("collect", { periodInMinutes: 1 });
  void collector.tick();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "collect") void collector.tick();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void collector.command(message).then(sendResponse);
  return true;
});
