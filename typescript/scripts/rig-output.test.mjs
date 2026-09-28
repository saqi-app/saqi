import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { generationSchema, normalizeWordMeanings } from "./rig-output.mjs";

test("each source line constrains its own word count including empty lines", () => {
  const template = JSON.parse(
    readFileSync(
      new URL("rig-publication-output.schema.json", import.meta.url),
    ),
  );
  const schema = generationSchema(template, ["يا قلب", "", "حب"]);
  assert.equal(schema.properties.translation.properties.lines.minItems, 3);
  assert.equal(schema.properties.translation.properties.lines.maxItems, 3);
  assert.deepEqual(schema.properties.wordMeanings.required, [
    "line_1",
    "line_2",
    "line_3",
  ]);
  assert.deepEqual(
    Object.values(schema.properties.wordMeanings.properties).map((p) => [
      p.minItems,
      p.maxItems,
    ]),
    [
      [2, 2],
      [0, 0],
      [1, 1],
    ],
  );
  assert.equal(template.properties.wordMeanings.type, "array");
  for (const line of Object.values(schema.properties.wordMeanings.properties)) {
    // The wire schema must reject blank meanings before a Codex invocation
    // produces a result that the publication validator cannot accept.
    assert.equal(line.items.minLength, 1);
    assert.equal(line.items.maxLength, 2000);
    const nonblank = new RegExp(line.items.pattern, "u");
    assert.equal(nonblank.test(" \n\t"), false);
    assert.equal(nonblank.test("heart"), true);
  }
});
test("recovery normalizes keyed output in source order and rejects missing lines", () => {
  assert.deepEqual(
    normalizeWordMeanings({
      wordMeanings: { line_2: ["heart"], line_1: ["O"] },
    }).wordMeanings,
    [["O"], ["heart"]],
  );
  assert.throws(() =>
    normalizeWordMeanings({ wordMeanings: { line_2: ["heart"] } }),
  );
  assert.throws(() => normalizeWordMeanings({ wordMeanings: { bad: [] } }));
  assert.deepEqual(
    normalizeWordMeanings({ wordMeanings: [["legacy"]] }).wordMeanings,
    [["legacy"]],
  );
});

test("word-only generation excludes existing translation", () => {
  const template = JSON.parse(
    readFileSync(
      new URL("rig-publication-output.schema.json", import.meta.url),
    ),
  );
  const schema = generationSchema(template, ["يا قلب"], ["wordMeanings"]);
  assert.deepEqual(schema.required, ["wordMeanings"]);
  assert.deepEqual(Object.keys(schema.properties), ["wordMeanings"]);
  assert.throws(() => generationSchema(template, ["يا"], ["insights"]));
  assert.throws(() => generationSchema(template, ["يا"], []));
  assert.throws(() => generationSchema(template, ["يا"], ["unexpected"]));
});
