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

    dispatch(name) {
      this.listeners.get(name)?.(new InputEvent());
    }
  }

  const row = (name) => {
    const item = new Element();
    item.querySelectorAll = () => [{ textContent: name }];
    return item;
  };

  const rows = [row("Alpha"), row("Beta"), row("Gamma")];
  const input = new Input();
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
  root.removeAttribute = () => {};
  let frame;

  try {
    globalThis.HTMLElement = Element;
    globalThis.HTMLInputElement = Input;
    globalThis.InputEvent = class {};
    globalThis.document = {
      querySelectorAll: (selector) =>
        selector === "[data-filter-root]" ? [root] : [emptyState],
      getElementById: () => list,
    };
    emptyState.dataset = { filterEmptyFor: "author-index" };
    globalThis.requestAnimationFrame = (callback) => {
      frame = callback;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      frame = undefined;
    };

    await import("../src/scripts/index-filter.js");
    const filter = (query) => {
      input.value = query;
      input.dispatch("input");
      frame();
    };

    filter("al");
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [false, true, true],
    );
    assert.equal(emptyState.hidden, true);
    assert.equal(list.hiddenWrites, 0);
    assert.deepEqual(
      rows.map((item) => item.hiddenWrites),
      [0, 1, 1],
    );

    filter("alp");
    assert.deepEqual(
      rows.map((item) => item.hiddenWrites),
      [0, 1, 1],
    );

    filter("");
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [false, false, false],
    );
    assert.equal(list.hiddenWrites, 0);

    filter("zzz");
    assert.deepEqual(
      rows.map((item) => item.hidden),
      [true, true, true],
    );
    assert.equal(emptyState.hidden, false);
  } finally {
    Object.assign(globalThis, previousGlobals);
  }
});
