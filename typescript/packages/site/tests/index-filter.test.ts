import assert from "node:assert/strict";
import test from "node:test";

test("index filtering updates only rows whose visibility changes", async () => {
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    InputEvent: globalThis.InputEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    addEventListener: globalThis.addEventListener,
  };

  class Element {
    _hidden = false;
    hiddenWrites = 0;

    get hidden() {
      return this._hidden;
    }
    set hidden(value) {
      this.hiddenWrites += 1;
      this._hidden = value;
    }
  }

  class Input extends Element {
    value = "";
    listeners = new Map();

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    dispatch(name, { isComposing = false } = {}) {
      const event = new globalThis.InputEvent(name);
      Object.defineProperty(event, "isComposing", { value: isComposing });
      this.listeners.get(name)?.(event);
    }
  }

  const row = (name) => {
    const item = new Element();
    item.querySelectorAll = () => [{ textContent: name }];
    return item;
  };

  const rows = [row("Alpha"), row("Beta"), row("Gamma")];
  const input = new Input();
  input.value = "be";
  const status = new Element();
  const list = new Element();
  list.children = rows;
  const emptyState = new Element();
  const root = new Element();
  root.dataset = { filterList: "author-index", filterItemName: "poets" };
  root.querySelector = (selector) =>
    ({
      "[data-filter-input]": input,
      "[data-filter-status]": status,
    })[selector];
  root.removeAttribute = () => undefined;
  let frame;
  const pageEvents = new Map();

  try {
    emptyState.dataset = { filterEmptyFor: "author-index" };
    Object.assign(globalThis, {
      HTMLElement: Element,
      HTMLInputElement: Input,
      InputEvent: globalThis.Event,
      document: {
        querySelectorAll: (selector) =>
          selector === "[data-filter-root]" ? [root] : [emptyState],
        getElementById: () => list,
      },
      requestAnimationFrame: (callback) => {
        frame = callback;
        return 1;
      },
      cancelAnimationFrame: () => {
        frame = undefined;
      },
      addEventListener: (name, listener) => {
        pageEvents.set(name, listener);
      },
    });

    await import("../src/scripts/index-filter.ts");
    const filter = (query) => {
      input.value = query;
      input.dispatch("input");
      frame();
    };

    assert.notEqual(
      frame,
      undefined,
      "restored search text schedules filtering"
    );
    frame();
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [true, false, true]
    );
    filter("");
    for (const item of rows) item.hiddenWrites = 0;

    filter("al");
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [false, true, true]
    );
    assert.equal(emptyState.hidden, true);
    assert.equal(list.hiddenWrites, 0);
    assert.deepEqual(
      rows.map((item) => item.hiddenWrites),
      [0, 1, 1]
    );

    filter("alp");
    assert.deepEqual(
      rows.map((item) => item.hiddenWrites),
      [0, 1, 1]
    );

    filter("");
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [false, false, false]
    );
    assert.equal(list.hiddenWrites, 0);

    filter("zzz");
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [true, true, true]
    );
    assert.equal(emptyState.hidden, false);

    // A prior keystroke can still be queued when composition starts. It must
    // not filter using an unfinished IME value, even before compositionend.
    input.value = "al";
    input.dispatch("input");
    assert.notEqual(frame, undefined);
    input.value = "a";
    input.dispatch("input", { isComposing: true });
    assert.equal(frame, undefined);
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [true, true, true]
    );
    input.dispatch("compositionend");
    frame();
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [false, false, false]
    );
    input.value = "be";
    pageEvents.get("pageshow")();
    frame();
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [true, false, true]
    );
    input.value = "";
    pageEvents.get("pageshow")();
    frame();
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [false, false, false]
    );
  } finally {
    Object.assign(globalThis, previousGlobals);
  }
});
