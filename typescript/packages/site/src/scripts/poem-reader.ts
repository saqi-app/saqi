import { wordGlossMatchesTranslation } from "../lib/poem-translations";
import { wordMeaningPosition } from "../lib/word-meaning-position";
const POPOVER = document.querySelector("#word-gloss-popover");
const SUPPORTS_POPOVER =
  POPOVER instanceof HTMLElement &&
  // eslint-disable-next-line no-restricted-syntax -- Browser API feature detection keeps unsupported readers inert.
  typeof POPOVER.showPopover === "function" &&
  // eslint-disable-next-line no-restricted-syntax -- Both native popover methods must be callable before enhancement.
  typeof POPOVER.hidePopover === "function";
let dismissMeaning: (() => void) | undefined;
const TRANSLATION_SELECT = document.querySelector("#translation-track");
if (TRANSLATION_SELECT instanceof HTMLSelectElement) {
  TRANSLATION_SELECT.disabled = false;
  const translations = document.querySelectorAll("[data-translation]");
  const icons = document.querySelectorAll("[data-translation-model-icon]");
  const glossLines = document.querySelectorAll("[data-word-gloss-line]");
  const fallbacks = document.querySelectorAll("[data-word-gloss-fallback]");

  const syncTranslation = () => {
    dismissMeaning?.();
    for (const translation of translations) {
      if (!(translation instanceof HTMLElement)) continue;
      translation.hidden =
        translation.dataset["translation"] !== TRANSLATION_SELECT.value;
    }
    for (const icon of icons) {
      if (!(icon instanceof HTMLElement)) continue;
      icon.hidden =
        icon.dataset["translationModelIcon"] !== TRANSLATION_SELECT.value;
    }
    const glossedLineIndexes = new Set<string | undefined>();
    for (const line of glossLines) {
      if (!(line instanceof HTMLElement)) continue;
      line.hidden = !wordGlossMatchesTranslation(
        line.dataset["wordGlossLine"],
        TRANSLATION_SELECT.value
      );
      if (!line.hidden) glossedLineIndexes.add(line.dataset["wordGlossIndex"]);
    }
    for (const fallback of fallbacks) {
      if (fallback instanceof HTMLElement) {
        fallback.hidden = glossedLineIndexes.has(
          fallback.dataset["wordGlossFallback"]
        );
      }
    }
  };
  TRANSLATION_SELECT.addEventListener("change", syncTranslation);
  syncTranslation();
}

const READER = document.querySelector(".poem");
if (SUPPORTS_POPOVER && READER instanceof HTMLElement) {
  const LEAVE_DELAY = 100;
  const meaning = POPOVER.querySelector(".word-gloss-meaning");
  const header = document.querySelector(".site-header");
  let activeTrigger: HTMLElement | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pinned = false;
  let mayScrollToMeaning = false;
  let positionFrame = 0;
  let pointerGesture = false;
  let pointerInMeaning = false;
  let suppressFocus = false;
  let dismissedTrigger: HTMLElement | null = null;
  let spaceTrigger: HTMLElement | null = null;
  const triggerFor = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest<HTMLElement>(".word-gloss[role='button']")
      : null;
  const selectedText = () => window.getSelection()?.isCollapsed === false;
  const visible = (trigger: HTMLElement) =>
    trigger.isConnected && !trigger.closest("[hidden]");
  const cancelLeave = () => {
    clearTimeout(leaveTimer);
    leaveTimer = undefined;
  };
  const clearActive = () => {
    cancelLeave();
    activeTrigger?.setAttribute("aria-expanded", "false");
    activeTrigger = null;
    pinned = false;
    mayScrollToMeaning = false;
    spaceTrigger = null;
    pointerInMeaning = false;
    cancelAnimationFrame(positionFrame);
    positionFrame = 0;
  };
  const hideMeaning = (restore = false) => {
    const trigger = activeTrigger;
    const restoreFocus = restore && POPOVER.contains(document.activeElement);
    dismissedTrigger = activeTrigger ?? dismissedTrigger;
    clearActive();
    // Native popover dismissal may restore focus before hidePopover returns.
    suppressFocus = true;
    if (POPOVER.matches(":popover-open")) POPOVER.hidePopover();
    if (restoreFocus && trigger && visible(trigger))
      trigger.focus({ preventScroll: true });
    suppressFocus = false;
    dismissedTrigger = null;
  };
  dismissMeaning = hideMeaning;
  const scheduleHide = () => {
    cancelLeave();
    if (!pinned && !selectedText())
      leaveTimer = setTimeout(() => hideMeaning(), LEAVE_DELAY);
  };
  const positionMeaning = () => {
    positionFrame = 0;
    if (!activeTrigger || !POPOVER.matches(":popover-open")) return;
    const visual = window.visualViewport;
    const viewport = {
      left: visual?.offsetLeft ?? 0,
      top: visual?.offsetTop ?? 0,
      width: visual?.width ?? document.documentElement.clientWidth,
      height: visual?.height ?? window.innerHeight,
    };
    const headerRect = header?.getBoundingClientRect();
    const headerBottom =
      header instanceof HTMLElement &&
      ["sticky", "fixed"].includes(getComputedStyle(header).position) &&
      headerRect &&
      headerRect.top <= viewport.top &&
      headerRect.bottom > viewport.top
        ? headerRect.bottom
        : viewport.top;
    const word = activeTrigger.getBoundingClientRect();
    const outside =
      !visible(activeTrigger) ||
      word.width === 0 ||
      word.height === 0 ||
      word.bottom <= headerBottom ||
      word.top >= viewport.top + viewport.height ||
      word.right <= viewport.left ||
      word.left >= viewport.left + viewport.width;
    POPOVER.style.maxWidth = `${String(Math.max(0, Math.min(320, viewport.width - 24)))}px`;
    const naturalHeight =
      POPOVER.scrollHeight + POPOVER.offsetHeight - POPOVER.clientHeight;
    const position = wordMeaningPosition(
      word,
      viewport,
      {
        width: POPOVER.offsetWidth,
        height: naturalHeight,
      },
      headerBottom
    );
    const panelStyle = getComputedStyle(POPOVER);
    const lineHeight = Number.parseFloat(
      getComputedStyle(meaning ?? POPOVER).lineHeight
    );
    const padding =
      Number.parseFloat(panelStyle.paddingBlockStart) +
      Number.parseFloat(panelStyle.paddingBlockEnd);
    const readableHeight = Math.min(
      naturalHeight,
      (Number.isFinite(lineHeight) ? lineHeight : 24) +
        (Number.isFinite(padding) ? padding : 0)
    );
    if (outside || position.maxHeight < readableHeight) {
      if (mayScrollToMeaning && visible(activeTrigger)) {
        mayScrollToMeaning = false;
        POPOVER.style.visibility = "hidden";
        activeTrigger.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant",
        });
        schedulePosition();
      } else hideMeaning();
      return;
    }
    mayScrollToMeaning = false;
    POPOVER.style.left = `${String(position.left)}px`;
    POPOVER.style.top = `${String(position.top)}px`;
    POPOVER.style.maxHeight = `${String(position.maxHeight)}px`;
    POPOVER.style.visibility = "visible";
  };
  const schedulePosition = () => {
    if (activeTrigger && !positionFrame)
      positionFrame = requestAnimationFrame(positionMeaning);
  };
  const showMeaning = (
    trigger: HTMLElement,
    allowSelection = false,
    pin = false
  ) => {
    cancelLeave();
    if (!visible(trigger) || (!allowSelection && selectedText())) return;
    if (activeTrigger === trigger && POPOVER.matches(":popover-open")) {
      if (pin && !pinned) {
        pinned = true;
        mayScrollToMeaning = true;
        positionMeaning();
      }
      return;
    }
    const descriptionId = trigger.getAttribute("aria-describedby");
    const description = descriptionId
      ? document.getElementById(descriptionId)
      : null;
    if (meaning) meaning.textContent = description?.textContent ?? "";
    POPOVER.style.visibility = "hidden";
    if (!POPOVER.matches(":popover-open")) POPOVER.showPopover();
    if (!POPOVER.matches(":popover-open")) return;
    activeTrigger?.setAttribute("aria-expanded", "false");
    activeTrigger = trigger;
    pinned = pin;
    mayScrollToMeaning = pin;
    dismissedTrigger = null;
    trigger.setAttribute("aria-expanded", "true");
    POPOVER.scrollTop = 0;
    positionMeaning();
  };

  READER.addEventListener("pointerover", (event) => {
    if (
      event.pointerType === "touch" ||
      event.buttons !== 0 ||
      pointerGesture ||
      selectedText()
    )
      return;
    const trigger = triggerFor(event.target);
    if (!trigger || trigger === triggerFor(event.relatedTarget)) return;
    cancelLeave();
    if (trigger === activeTrigger) return;
    showMeaning(trigger);
  });
  READER.addEventListener("pointerout", (event) => {
    if (
      triggerFor(event.target) === activeTrigger &&
      triggerFor(event.relatedTarget) !== activeTrigger &&
      !(
        event.relatedTarget instanceof Node &&
        POPOVER.contains(event.relatedTarget)
      )
    )
      scheduleHide();
  });
  POPOVER.addEventListener("pointerenter", cancelLeave);
  POPOVER.addEventListener("pointerleave", (event) => {
    if (triggerFor(event.relatedTarget) === activeTrigger) cancelLeave();
    else scheduleHide();
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      pointerGesture = true;
      pointerInMeaning =
        event.target instanceof Node && POPOVER.contains(event.target);
      cancelLeave();
      if (!pointerInMeaning && !triggerFor(event.target)) hideMeaning();
    },
    { capture: true }
  );
  document.addEventListener(
    "pointerup",
    () => {
      pointerGesture = false;
      pointerInMeaning = false;
    },
    { capture: true }
  );
  document.addEventListener(
    "pointercancel",
    () => {
      pointerGesture = false;
      pointerInMeaning = false;
      cancelLeave();
    },
    { capture: true }
  );
  READER.addEventListener("click", (event) => {
    if (event.button !== 0 || selectedText()) return;
    const trigger = triggerFor(event.target);
    if (trigger) showMeaning(trigger, false, true);
  });
  document.addEventListener("focusin", (event) => {
    const trigger = triggerFor(event.target);
    const restoring = trigger !== null && trigger === dismissedTrigger;
    dismissedTrigger = null;
    if (suppressFocus || restoring || (pointerGesture && pointerInMeaning))
      return;
    if (trigger && !pointerGesture) showMeaning(trigger, true, true);
    else if (!(event.target instanceof Node && POPOVER.contains(event.target)))
      hideMeaning();
  });
  document.addEventListener("selectionchange", () => {
    if (pointerGesture && !pointerInMeaning && selectedText()) hideMeaning();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      cancelLeave();
      if (activeTrigger) hideMeaning(true);
      return;
    }
    const trigger = triggerFor(event.target);
    if (!trigger || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (event.key === "Enter") {
      showMeaning(trigger, true, true);
    } else if (event.key === " ") {
      spaceTrigger = trigger;
    }
  });
  READER.addEventListener("keyup", (event) => {
    if (event.key !== " ") return;
    const trigger = spaceTrigger;
    spaceTrigger = null;
    if (trigger && document.activeElement === trigger) {
      event.preventDefault();
      showMeaning(trigger, true, true);
    }
  });
  POPOVER.addEventListener("beforetoggle", (event) => {
    if (event.newState === "closed") {
      dismissedTrigger = activeTrigger ?? dismissedTrigger;
      clearActive();
    }
  });
  POPOVER.addEventListener("toggle", () => {
    if (!POPOVER.matches(":popover-open")) clearActive();
  });
  window.addEventListener("blur", () => {
    pointerGesture = false;
    pointerInMeaning = false;
    hideMeaning();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pointerGesture = false;
      pointerInMeaning = false;
      hideMeaning();
    }
  });
  window.addEventListener("resize", schedulePosition, { passive: true });
  window.addEventListener("scroll", schedulePosition, {
    capture: true,
    passive: true,
  });
  const visualViewport = window.visualViewport;
  if (visualViewport) {
    visualViewport.addEventListener("resize", schedulePosition, {
      passive: true,
    });
    visualViewport.addEventListener("scroll", schedulePosition, {
      passive: true,
    });
  }
  document.fonts.addEventListener("loadingdone", schedulePosition);
  POPOVER.hidden = false;
  for (const word of READER.querySelectorAll<HTMLElement>(".word-gloss")) {
    word.setAttribute("role", "button");
    word.setAttribute("tabindex", "0");
    word.setAttribute("aria-controls", "word-gloss-popover");
    word.setAttribute("aria-expanded", "false");
  }
}
