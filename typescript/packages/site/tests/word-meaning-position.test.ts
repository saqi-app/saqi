import assert from "node:assert/strict";
import test from "node:test";

import { wordMeaningPosition } from "../src/lib/word-meaning-position";

const NARROW_CASES = [
  { left: 0, wordOffset: 0 },
  { left: 0, wordOffset: 290 },
  { left: 120, wordOffset: 0 },
  { left: 120, wordOffset: 290 },
];
for (const { left, wordOffset } of NARROW_CASES) {
  await test(`narrow viewport offset ${String(left)}, word offset ${String(wordOffset)}`, () => {
    const viewport = { left, top: 150, width: 320, height: 480 };
    const wordLeft = left + wordOffset;
    const position = wordMeaningPosition(
      { left: wordLeft, right: wordLeft + 30, top: 220, bottom: 250 },
      viewport,
      { width: 296, height: 180 },
      150
    );
    assert.equal(position.left, left + 12);
    assert.equal(position.top, 162);
    assert.equal(position.maxHeight, 50);
    assert.equal(position.top + position.maxHeight, 212);
  });
}

await test("meanings move above the word and cap long content away from a sticky header", () => {
  const viewport = { left: 0, top: 0, width: 1280, height: 720 };
  const word = { left: 500, right: 550, top: 600, bottom: 630 };
  const compact = wordMeaningPosition(
    word,
    viewport,
    { width: 384, height: 180 },
    80
  );
  assert.equal(compact.top, 412);
  const long = wordMeaningPosition(
    word,
    viewport,
    { width: 384, height: 1800 },
    80
  );
  assert.equal(long.top, 92);
  assert.equal(long.maxHeight, 500);
  assert.equal(long.top + long.maxHeight, word.top - 8);
});

await test("short viewports keep scrollable meanings above the word", () => {
  const position = wordMeaningPosition(
    { left: 100, right: 170, top: 120, bottom: 155 },
    { left: 0, top: 0, width: 375, height: 280 },
    { width: 351, height: 1000 },
    0
  );
  assert.equal(position.maxHeight, 100);
  assert.equal(position.top, 12);
  assert.equal(position.top + position.maxHeight, 112);
  assert.ok(position.left >= 12);
});

await test("compact meanings prefer above even when there is room below", () => {
  const position = wordMeaningPosition(
    { left: 300, right: 360, top: 400, bottom: 440 },
    { left: 0, top: 0, width: 1280, height: 800 },
    { width: 120, height: 48 },
    80
  );
  assert.equal(position.top, 344);
  assert.equal(position.left, 270);
});

await test("near-header meanings use the top layer above the word instead of flipping below", () => {
  const position = wordMeaningPosition(
    { left: 100, right: 160, top: 100, bottom: 140 },
    { left: 0, top: 0, width: 320, height: 480 },
    { width: 120, height: 48 },
    80
  );
  assert.equal(position.top, 44);
  assert.equal(position.top + 48, 92);
});

await test("desktop meanings center on words and clamp to either viewport edge", () => {
  const viewport = { left: 100, top: 50, width: 1280, height: 720 };
  const positions = [
    { left: 600, right: 660, expected: 438 },
    { left: 100, right: 130, expected: 112 },
    { left: 1350, right: 1380, expected: 984 },
  ];
  for (const { left, right, expected } of positions) {
    const result = wordMeaningPosition(
      { left, right, top: 200, bottom: 230 },
      viewport,
      { width: 384, height: 180 },
      50
    );
    assert.equal(result.left, expected);
  }
});
