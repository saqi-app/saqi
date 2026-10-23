import assert from "node:assert/strict";
import test from "node:test";

await test("switching English tracks preserves Arabic without matching word meanings", async () => {
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
  };
  class Element {
    hidden = false;
    constructor(dataset) {
      this.dataset = dataset;
    }
  }
  class Select extends Element {
    disabled = true;
    value = "partial";
    listeners = new Map();
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }
    choose(value) {
      this.value = value;
      this.listeners.get("change")();
    }
  }
  const select = new Select({});
  const translations = ["partial", "legacy"].map(
    (translation) => new Element({ translation })
  );
  const coverage = new Element({ translation: "partial" });
  const icons = ["partial", "legacy"].map(
    (translationModelIcon) => new Element({ translationModelIcon })
  );
  const glosses = [
    new Element({ wordGlossLine: "partial", wordGlossIndex: "0" }),
    new Element({ wordGlossLine: "current-glosses", wordGlossIndex: "3" }),
  ];
  const fallbacks = ["0", "1", "2", "3"].map(
    (wordGlossFallback) => new Element({ wordGlossFallback })
  );
  let queries = 0;
  try {
    Object.assign(globalThis, {
      HTMLElement: Element,
      HTMLSelectElement: Select,
      document: {
        querySelector: (selector) =>
          selector === "#translation-track" ? select : null,
        querySelectorAll: (selector) => {
          queries += 1;
          return {
            "[data-translation]": [...translations, coverage],
            "[data-translation-model-icon]": icons,
            "[data-word-gloss-line]": glosses,
            "[data-word-gloss-fallback]": fallbacks,
          }[selector];
        },
      },
    });
    await import("../src/scripts/poem-reader.ts");
    const initialQueries = queries;
    assert.equal(select.disabled, false);
    assert.equal(coverage.hidden, false);
    assert.deepEqual(
      translations.map((line) => line.hidden),
      [false, true]
    );
    assert.deepEqual(
      fallbacks.map((line) => line.hidden),
      [true, false, false, true]
    );

    select.choose("legacy");
    assert.equal(coverage.hidden, true);
    assert.deepEqual(
      translations.map((line) => line.hidden),
      [true, false]
    );
    assert.deepEqual(
      icons.map((icon) => icon.hidden),
      [true, false]
    );
    assert.deepEqual(
      glosses.map((line) => line.hidden),
      [true, false]
    );
    assert.deepEqual(
      fallbacks.map((line) => line.hidden),
      [false, false, false, true]
    );

    select.choose("partial");
    assert.equal(coverage.hidden, false);
    assert.deepEqual(
      fallbacks.map((line) => line.hidden),
      [true, false, false, true]
    );
    assert.equal(
      queries,
      initialQueries,
      "track changes reuse the existing reader elements"
    );
  } finally {
    Object.assign(globalThis, previousGlobals);
  }
});

let fixtureNumber = 0;

async function readerFixture(t) {
  const keys = [
    "document",
    "window",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLSelectElement",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ];
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let selectionCollapsed = true;
  const frames = new Map();
  let frameNumber = 0;
  class Element {
    dataset = {};
    attributes = new Map();
    listeners = new Map();
    style = {};
    hidden = false;
    parent = null;
    isWord = false;
    isConnected = true;
    value = "legacy";
    textContent = "";
    scrollTop = 0;
    scrollIntoViewCount = 0;
    rect = {
      left: 100,
      right: 160,
      top: 200,
      bottom: 230,
      width: 60,
      height: 30,
    };
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
    }
    emit(name, detail = {}) {
      const event = {
        target: this,
        relatedTarget: null,
        buttons: 0,
        button: 0,
        defaultPrevented: false,
        preventDefault: () => {
          event.defaultPrevented = true;
        },
        ...detail,
      };
      const listeners = this.listeners.get(name);
      if (listeners) for (const listener of listeners) listener(event);
      return event;
    }
    closest(selector) {
      if (
        (selector === ".word-gloss[role='button']" &&
          this.isWord &&
          this.getAttribute("role") === "button") ||
        (selector === "[hidden]" && this.hidden)
      )
        return this;
      return this.parent?.closest(selector) ?? null;
    }
    contains(element) {
      return (
        element === this ||
        Boolean(element?.parent && this.contains(element.parent))
      );
    }
    getBoundingClientRect() {
      return this.rect;
    }
    scrollIntoView() {
      this.scrollIntoViewCount += 1;
      this.rect = { ...this.rect, top: 400, bottom: 400 + this.rect.height };
    }
    focus() {
      if (document.activeElement === this) return;
      document.activeElement = this;
      document.emit("focusin", { target: this });
    }
  }
  class Select extends Element {}
  class Popover extends Element {
    open = false;
    queuedToggle = null;
    meaning = new Element();
    naturalHeight = 48;
    get offsetWidth() {
      return Math.min(120, Number.parseFloat(this.style.maxWidth) || Infinity);
    }
    get offsetHeight() {
      return this.open
        ? Math.min(
            this.naturalHeight,
            Number.parseFloat(this.style.maxHeight) || Infinity
          )
        : 0;
    }
    get clientHeight() {
      return Math.max(0, this.offsetHeight - 2);
    }
    get scrollHeight() {
      return this.naturalHeight - 2;
    }
    matches(selector) {
      assert.equal(selector, ":popover-open");
      return this.open;
    }
    getBoundingClientRect() {
      return { ...this.rect, height: this.offsetHeight };
    }
    querySelector(selector) {
      const elements = {
        ".word-gloss-meaning": this.meaning,
      };
      assert.ok(
        Object.hasOwn(elements, selector),
        `unexpected popover selector ${selector}`
      );
      return elements[selector];
    }
    transition(open) {
      if (this.open === open) return;
      const oldState = this.open ? "open" : "closed";
      const newState = open ? "open" : "closed";
      const event = this.emit("beforetoggle", { oldState, newState });
      if (open && event.defaultPrevented) return;
      this.open = open;
      this.queuedToggle = {
        oldState: this.queuedToggle?.oldState ?? oldState,
        newState,
      };
    }
    showPopover() {
      this.transition(true);
    }
    hidePopover() {
      this.transition(false);
    }
  }
  const document = new Element();
  document.documentElement = { clientWidth: 1280 };
  document.activeElement = null;
  document.fonts = new Element();
  const window = new Element();
  window.innerHeight = 900;
  window.visualViewport = Object.assign(new Element(), {
    offsetLeft: 0,
    offsetTop: 0,
    width: 1280,
    height: 900,
  });
  window.getSelection = () => ({ isCollapsed: selectionCollapsed });
  const select = new Select();
  const reader = new Element();
  const popover = new Popover();
  popover.meaning.parent = popover;
  const header = new Element();
  header.rect = {
    left: 0,
    right: 1280,
    top: 0,
    bottom: 80,
    width: 1280,
    height: 80,
  };
  const glossLine = new Element();
  glossLine.parent = reader;
  glossLine.dataset = { wordGlossLine: "legacy", wordGlossIndex: "0" };
  const fallback = new Element();
  fallback.dataset.wordGlossFallback = "0";
  const words = ["بيت", "قلب"].map((surface, index) => {
    const word = new Element();
    word.isWord = true;
    word.parent = glossLine;
    word.textContent = surface;
    word.setAttribute("aria-describedby", `meaning-${index}`);
    return word;
  });
  const child = new Element();
  child.parent = words[0];
  const outside = new Element();
  const descriptions = new Map([
    ["meaning-0", { textContent: "verse" }],
    ["meaning-1", { textContent: "heart" }],
  ]);
  document.querySelector = (selector) => {
    const elements = {
      "#translation-track": select,
      "#word-gloss-popover": popover,
      ".poem": reader,
      ".site-header": header,
    };
    assert.ok(
      Object.hasOwn(elements, selector),
      `unexpected document selector ${selector}`
    );
    return elements[selector];
  };
  document.querySelectorAll = (selector) => {
    assert.ok(
      [
        "[data-translation]",
        "[data-translation-model-icon]",
        "[data-word-gloss-line]",
        "[data-word-gloss-fallback]",
      ].includes(selector)
    );
    return selector === "[data-word-gloss-line]"
      ? [glossLine]
      : selector === "[data-word-gloss-fallback]"
        ? [fallback]
        : [];
  };
  reader.querySelectorAll = (selector) => {
    assert.equal(selector, ".word-gloss");
    return words;
  };
  document.getElementById = (id) => descriptions.get(id) ?? null;
  Object.assign(globalThis, {
    document,
    window,
    Node: Element,
    Element,
    HTMLElement: Element,
    HTMLSelectElement: Select,
    getComputedStyle: () => ({ position: "sticky" }),
    requestAnimationFrame: (callback) => {
      const id = ++frameNumber;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  await import(`../src/scripts/poem-reader.ts?fixture=${++fixtureNumber}`);
  return {
    document,
    window,
    reader,
    popover,
    select,
    words,
    child,
    outside,
    glossLine,
    fallback,
    selectText: (collapsed) => {
      selectionCollapsed = collapsed;
    },
    flushToggle: () => {
      const event = popover.queuedToggle;
      popover.queuedToggle = null;
      if (event) popover.emit("toggle", event);
    },
    flushFrames: () => {
      const callbacks = frames.values().toArray();
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

await test("hover meanings update immediately as the pointer moves between words", async (t) => {
  const h = await readerFixture(t);
  const [first, second] = h.words;
  h.reader.emit("pointerover", { target: h.child, pointerType: "mouse" });
  assert.equal(h.popover.open, true);
  assert.equal(h.popover.meaning.textContent, "verse");
  h.reader.emit("pointerover", {
    target: first,
    relatedTarget: h.child,
    pointerType: "mouse",
  });
  assert.equal(h.popover.meaning.textContent, "verse");
  assert.equal(first.getAttribute("aria-expanded"), "true");
  h.reader.emit("pointerout", { target: first, relatedTarget: second });
  h.reader.emit("pointerover", {
    target: second,
    relatedTarget: first,
    pointerType: "mouse",
  });
  assert.equal(h.popover.meaning.textContent, "heart");
  assert.equal(first.getAttribute("aria-expanded"), "false");
  assert.equal(second.getAttribute("aria-expanded"), "true");
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 0);
});

await test("hover can cross the gap, return to its word, and dismiss after leaving both", async (t) => {
  const h = await readerFixture(t);
  h.reader.emit("pointerover", { target: h.words[0], pointerType: "mouse" });
  h.reader.emit("pointerout", { target: h.words[0], relatedTarget: h.outside });
  t.mock.timers.tick(99);
  assert.equal(h.popover.open, true);
  h.popover.emit("pointerenter");
  t.mock.timers.tick(100);
  assert.equal(h.popover.open, true);
  h.popover.emit("pointerleave", { relatedTarget: h.words[0] });
  h.reader.emit("pointerover", { target: h.words[0], pointerType: "mouse" });
  t.mock.timers.tick(100);
  assert.equal(h.popover.open, true);
  h.reader.emit("pointerout", { target: h.words[0], relatedTarget: h.outside });
  t.mock.timers.tick(50);
  h.reader.emit("pointerover", { target: h.words[0], pointerType: "mouse" });
  t.mock.timers.tick(100);
  assert.equal(h.popover.open, true);
  h.reader.emit("pointerout", { target: h.words[0], relatedTarget: h.outside });
  t.mock.timers.tick(100);
  assert.equal(h.popover.open, false);
});

await test("track changes dismiss meanings and preserve Arabic through a visible fallback", async (t) => {
  const h = await readerFixture(t);
  const first = h.words[0];
  first.focus();
  assert.equal(h.popover.open, true);
  assert.equal(h.fallback.hidden, true);
  h.select.value = "without-glosses";
  h.select.emit("change");
  assert.equal(h.popover.open, false);
  assert.equal(first.getAttribute("aria-expanded"), "false");
  assert.equal(h.glossLine.hidden, true);
  assert.equal(h.fallback.hidden, false);
  h.reader.emit("click", { target: first });
  h.reader.emit("pointerover", { target: first, pointerType: "mouse" });
  t.mock.timers.tick(150);
  assert.equal(h.popover.open, false);
});

await test("Escape, model changes, outside gestures, focus and blur dismiss without a delayed reopening", async (t) => {
  const h = await readerFixture(t);
  const first = h.words[0];
  for (const cancel of [
    () => h.document.emit("keydown", { key: "Escape" }),
    () => h.select.emit("change"),
    () => {
      h.document.emit("pointerdown");
      first.focus();
      h.document.emit("pointerup");
    },
    () => h.outside.focus(),
    () => h.window.emit("blur"),
  ]) {
    h.reader.emit("pointerover", { target: first, pointerType: "mouse" });
    cancel();
    t.mock.timers.tick(150);
    assert.equal(h.popover.open, false);
    await Promise.resolve();
  }
});

await test("selection, touch and keyboard activation preserve focus and scrolling", async (t) => {
  const h = await readerFixture(t);
  const first = h.words[0];
  h.reader.emit("pointerover", { target: first, pointerType: "touch" });
  t.mock.timers.tick(150);
  assert.equal(h.popover.open, false);
  h.document.emit("pointerdown");
  first.focus();
  h.selectText(false);
  h.document.emit("pointerup");
  h.reader.emit("click", { target: first });
  assert.equal(h.popover.open, false);
  h.selectText(true);
  await Promise.resolve();
  h.reader.emit("click", { target: first });
  assert.equal(h.popover.open, true);
  h.popover.hidePopover();
  await Promise.resolve();
  const enter = h.document.emit("keydown", { key: "Enter", target: first });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(h.popover.open, true);
  h.popover.hidePopover();
  await Promise.resolve();
  const space = h.document.emit("keydown", { key: " ", target: first });
  const repeat = h.document.emit("keydown", {
    key: " ",
    target: first,
    repeat: true,
  });
  assert.equal(space.defaultPrevented, true);
  assert.equal(repeat.defaultPrevented, true);
  h.document.activeElement = first;
  h.reader.emit("keyup", { key: " ", target: first });
  assert.equal(h.popover.open, true);
  h.selectText(false);
  h.window.emit("scroll");
  h.flushFrames();
  assert.equal(
    h.popover.open,
    true,
    "selecting a meaning must not dismiss it during scroll"
  );
});

await test("native dismissal stays closed and queued toggles preserve the next word", async (t) => {
  const h = await readerFixture(t);
  const [first, second] = h.words;
  first.focus();
  assert.equal(h.popover.open, true);
  h.popover.hidePopover();
  assert.equal(h.popover.open, false);
  assert.equal(h.document.activeElement, first);
  assert.equal(first.getAttribute("aria-expanded"), "false");
  h.flushToggle();
  assert.equal(h.popover.open, false);
  await Promise.resolve();
  second.focus();
  h.popover.hidePopover();
  await Promise.resolve();
  second.focus(); // The native restoration guard must survive a microtask checkpoint.
  assert.equal(h.popover.open, false);
  h.reader.emit("click", { target: second });
  assert.equal(h.popover.open, true);
  h.flushToggle();
  assert.equal(second.getAttribute("aria-expanded"), "true");
  assert.equal(h.popover.meaning.textContent, "heart");
  await Promise.resolve();
  h.outside.focus();
  assert.equal(h.popover.open, false);
});

await test("Tab and Shift-Tab retain native word navigation, with no extra tooltip stop", async (t) => {
  const h = await readerFixture(t);
  const [first, second] = h.words;
  first.focus();
  const tab = h.document.emit("keydown", { key: "Tab", target: first });
  assert.equal(tab.defaultPrevented, false);
  second.focus(); // The browser owns native sequential navigation.
  assert.equal(h.popover.meaning.textContent, "heart");
  const back = h.document.emit("keydown", {
    key: "Tab",
    shiftKey: true,
    target: second,
  });
  assert.equal(back.defaultPrevented, false);
  first.focus();
  assert.equal(h.popover.meaning.textContent, "verse");
  second.focus();
  assert.equal(h.document.activeElement, second);
  h.document.emit("keydown", { key: "Escape", target: second });
  assert.equal(h.document.activeElement, second);
  assert.equal(h.popover.open, false);
  h.flushToggle();
  assert.equal(h.popover.open, false);
});

await test("meaning text selection survives pointer focus and keyboard navigation can resume", async (t) => {
  const h = await readerFixture(t);
  const [first] = h.words;
  first.focus();
  h.document.emit("pointerdown", { target: h.popover.meaning });
  h.outside.focus(); // Nonfocusable meaning text can move native focus to the page.
  h.selectText(false);
  h.document.emit("pointerup", { target: h.popover.meaning });
  assert.equal(h.popover.open, true);
  h.window.emit("scroll");
  h.flushFrames();
  assert.equal(h.popover.open, true);
  h.select.focus();
  assert.equal(
    h.popover.open,
    false,
    "outside focus after pointerup must dismiss"
  );
  first.focus();
  assert.equal(h.popover.meaning.textContent, "verse");
  h.document.emit("pointerdown", { target: first });
  h.selectText(false);
  h.document.emit("selectionchange");
  assert.equal(h.popover.open, false, "Arabic selection dismisses the meaning");
});

await test("word meanings track viewport changes, long content and offscreen triggers", async (t) => {
  const h = await readerFixture(t);
  const first = h.words[0];
  h.window.visualViewport.width = 320;
  h.window.visualViewport.height = 600;
  h.window.visualViewport.offsetLeft = 100;
  h.window.visualViewport.offsetTop = 100;
  first.focus();
  assert.equal(h.popover.style.maxWidth, "296px");
  assert.equal(h.popover.style.left, "112px");
  assert.equal(h.popover.style.top, "144px");
  h.popover.naturalHeight = 5000;
  h.popover.scrollTop = 45;
  h.window.visualViewport.emit("resize");
  h.flushFrames();
  assert.ok(Number.parseFloat(h.popover.style.maxHeight) < 600);
  assert.equal(h.popover.scrollTop, 45);
  assert.ok(
    Number.parseFloat(h.popover.style.top) +
      Number.parseFloat(h.popover.style.maxHeight) <=
      first.rect.top - 8,
    "long meanings remain above the word"
  );
  first.rect.top = 800;
  first.rect.bottom = 830;
  h.window.emit("scroll");
  h.flushFrames();
  assert.equal(h.popover.open, false);
});

await test("a clipped hover never opens an empty panel; explicit focus can reveal the word once", async (t) => {
  const h = await readerFixture(t);
  const first = h.words[0];
  first.rect.top = 18;
  first.rect.bottom = 48;
  h.reader.emit("pointerover", { target: first, pointerType: "mouse" });
  assert.equal(h.popover.open, false);
  assert.equal(first.scrollIntoViewCount, 0, "hover must never move the page");
  first.focus();
  assert.equal(first.scrollIntoViewCount, 1);
  assert.equal(h.popover.style.visibility, "hidden");
  h.flushFrames();
  assert.equal(h.popover.open, true);
  assert.equal(h.popover.style.visibility, "visible");
  assert.equal(h.popover.style.top, "344px");
  first.rect.top = 18;
  first.rect.bottom = 48;
  h.window.emit("scroll");
  h.flushFrames();
  assert.equal(h.popover.open, false);
  assert.equal(
    first.scrollIntoViewCount,
    1,
    "later user scrolling must not be undone"
  );
});

await test("explicit focus can reveal an already-hovered word that has since moved out of view", async (t) => {
  const h = await readerFixture(t);
  const first = h.words[0];
  h.reader.emit("pointerover", { target: first, pointerType: "mouse" });
  assert.equal(h.popover.open, true);
  first.rect.top = 18;
  first.rect.bottom = 48;
  first.focus();
  assert.equal(first.scrollIntoViewCount, 1);
  h.flushFrames();
  assert.equal(h.popover.open, true);
  assert.equal(h.popover.style.visibility, "visible");
});

await test("unsupported popovers stay hidden without breaking translation controls", async () => {
  const previous = Object.fromEntries(
    ["document", "HTMLElement", "HTMLSelectElement"].map((key) => [
      key,
      globalThis[key],
    ])
  );
  class Element {
    hidden = true;
  }
  const listeners = new Map();
  class Select extends Element {
    value = "legacy";
    addEventListener(name, listener) {
      listeners.set(name, listener);
    }
  }
  const select = new Select();
  const popover = new Element();
  try {
    Object.assign(globalThis, {
      HTMLElement: Element,
      HTMLSelectElement: Select,
      document: {
        querySelector: (selector) =>
          ({
            "#translation-track": select,
            "#word-gloss-popover": popover,
            ".poem": new Element(),
          })[selector] ?? null,
        querySelectorAll: () => [],
      },
    });
    await import("../src/scripts/poem-reader.ts?unsupported-popover");
    assert.equal(select.disabled, false);
    listeners.get("change")();
    assert.equal(popover.hidden, true);
  } finally {
    Object.assign(globalThis, previous);
  }
});
