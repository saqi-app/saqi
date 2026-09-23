import { normalizeSearch } from "./normalize-search.js";

for (const root of document.querySelectorAll("[data-filter-root]")) {
  if (!(root instanceof HTMLElement)) continue;

  const input = root.querySelector("[data-filter-input]");
  const status = root.querySelector("[data-filter-status]");
  const listId = root.dataset.filterList;
  const list = listId ? document.getElementById(listId) : null;
  const emptyState = [
    ...document.querySelectorAll("[data-filter-empty-for]"),
  ].find(
    (element) =>
      element instanceof HTMLElement &&
      element.dataset.filterEmptyFor === listId,
  );
  if (
    !(input instanceof HTMLInputElement) ||
    !(status instanceof HTMLElement) ||
    !list
  ) {
    continue;
  }

  const listItems = [...list.children].filter(
    (item) => item instanceof HTMLElement,
  );
  let searchableItems = [];
  let indexReady = false;
  const itemName = root.dataset.filterItemName ?? "items";
  let animationFrame;
  let announcementTimer;

  const ensureSearchIndex = () => {
    if (indexReady) return;
    searchableItems = listItems.map((item) => ({
      haystack: normalizeSearch(
        [...item.querySelectorAll(".index-primary, .index-secondary")]
          .map((node) => node.textContent ?? "")
          .join(" "),
      ),
      item,
    }));
    indexReady = true;
  };

  const applyFilter = () => {
    ensureSearchIndex();
    const query = normalizeSearch(input.value);
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

  const scheduleFilter = (event) => {
    globalThis.clearTimeout(announcementTimer);
    if (event instanceof InputEvent && event.isComposing) return;
    globalThis.cancelAnimationFrame(animationFrame);
    animationFrame = globalThis.requestAnimationFrame(applyFilter);
  };

  input.addEventListener("input", scheduleFilter);
  input.addEventListener("compositionend", scheduleFilter);
  input.addEventListener("focus", ensureSearchIndex, { once: true });
  input.disabled = false;
  root.hidden = false;
  root.removeAttribute("aria-hidden");
  root.removeAttribute("data-filter-pending");
}
