/* global InputEvent -- Browser input composition events. */
import { normalizeSearch } from "./normalize-search.ts";

for (const root of document.querySelectorAll("[data-filter-root]")) {
  if (!(root instanceof HTMLElement)) continue;

  const input = root.querySelector("[data-filter-input]");
  const status = root.querySelector("[data-filter-status]");
  const listId = root.dataset["filterList"];
  const list = listId ? document.getElementById(listId) : null;
  const emptyState = [
    ...document.querySelectorAll("[data-filter-empty-for]"),
  ].find(
    (element) =>
      element instanceof HTMLElement &&
      element.dataset["filterEmptyFor"] === listId
  );
  if (
    !(input instanceof HTMLInputElement) ||
    !(status instanceof HTMLElement) ||
    !list
  ) {
    continue;
  }

  const listItems = [...list.children].filter(
    (item) => item instanceof HTMLElement
  );
  let searchableItems: { haystack: string; item: HTMLElement }[] = [];
  let indexReady = false;
  const itemName = root.dataset["filterItemName"] ?? "items";
  let animationFrame = 0;
  let announcementTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const ensureSearchIndex = () => {
    if (indexReady) return;
    searchableItems = listItems.map((item) => ({
      haystack: normalizeSearch(
        [...item.querySelectorAll(".index-primary, .index-secondary")]
          .map((node) => node.textContent)
          .join(" ")
      ),
      item,
    }));
    indexReady = true;
  };

  const applyFilter = () => {
    const query = normalizeSearch(input.value);
    if (!indexReady && !query) return;
    ensureSearchIndex();
    let visible = 0;
    for (const { haystack, item } of searchableItems) {
      const matches = !query || haystack.includes(query);
      const shouldHide = !matches;
      if (item.hidden !== shouldHide) item.hidden = shouldHide;
      if (matches) visible += 1;
    }
    if (emptyState instanceof HTMLElement) emptyState.hidden = visible !== 0;
    announcementTimer = globalThis.setTimeout(() => {
      const visibleItemName =
        visible === 1 ? itemName.replace(/s$/, "") : itemName;
      status.textContent = `${String(visible)} ${visibleItemName}`;
    }, 200);
  };

  const scheduleFilter = (event?: Event) => {
    globalThis.clearTimeout(announcementTimer);
    globalThis.cancelAnimationFrame(animationFrame);
    if (event instanceof InputEvent && event.isComposing) return;
    animationFrame = globalThis.requestAnimationFrame(applyFilter);
  };

  input.addEventListener("input", scheduleFilter);
  input.addEventListener("compositionend", scheduleFilter);
  input.addEventListener("focus", ensureSearchIndex, { once: true });
  globalThis.addEventListener("pageshow", scheduleFilter);
  input.disabled = false;
  root.hidden = false;
  root.removeAttribute("aria-hidden");
  root.removeAttribute("data-filter-pending");
  if (input.value) scheduleFilter();
}
