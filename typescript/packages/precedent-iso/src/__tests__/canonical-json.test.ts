import { expect, test } from "vitest";

import { canonicalJson } from "../canonical-json.js";

test("canonical JSON sorts nested keys and preserves sequence order", () => {
  expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
    '{"a":{"c":3,"d":4},"b":2}'
  );
  expect(canonicalJson([1, 2])).toBe("[1,2]");
  expect(canonicalJson([2, 1])).toBe("[2,1]");
});

test("sparse arrays cannot produce invalid JSON or collide with empty arrays", () => {
  expect(() => canonicalJson(Array.from({ length: 1 }))).toThrow(
    "CANONICAL_JSON_UNSUPPORTED"
  );
  // Array.map skips holes, which previously serialized a one-hole array as [].
  expect(() => canonicalJson(new Array(1))).toThrow(
    "CANONICAL_JSON_UNSUPPORTED"
  );
  expect(() => canonicalJson(new Array(2))).toThrow(
    "CANONICAL_JSON_UNSUPPORTED"
  );
});

test.each([undefined, NaN, Infinity, 1n])(
  "rejects unsupported JSON values: %s",
  (value) => {
    expect(() => canonicalJson(value)).toThrow();
  }
);
