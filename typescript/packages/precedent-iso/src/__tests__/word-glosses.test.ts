import { expect, test } from "vitest";

import { arabicWords, wordGlossesFromMeanings } from "../word-glosses.js";

test("glosses preserve every source character including diacritics and punctuation", () => {
  const line = "  وَقَلْبِي، في الدّارِ! ";
  expect(arabicWords(line)).toEqual(["وَقَلْبِي", "في", "الدّارِ"]);
  const glosses = wordGlossesFromMeanings(
    [line, ""],
    [["and my heart", "in", "the home"], []],
  );
  expect(
    glosses.lines[0]?.segments.map(({ surface }) => surface).join(""),
  ).toBe(line);
  expect(
    glosses.lines[0]?.segments.filter(({ kind }) => kind === "word"),
  ).toMatchObject([
    { tokenIndex: 0, meaning: "and my heart" },
    { tokenIndex: 1, meaning: "in" },
    { tokenIndex: 2, meaning: "the home" },
  ]);
  expect(glosses.lines[1]?.segments).toEqual([]);
});

test("missing, extra or blank meanings cannot be published", () => {
  expect(() => wordGlossesFromMeanings(["بيت"], [])).toThrow(
    "GLOSS_LINE_COUNT_MISMATCH",
  );
  expect(() => wordGlossesFromMeanings(["بيت"], [[]])).toThrow(
    "GLOSS_WORD_COUNT_MISMATCH",
  );
  expect(() => wordGlossesFromMeanings(["بيت"], [["house", "extra"]])).toThrow(
    "GLOSS_WORD_COUNT_MISMATCH",
  );
  expect(() => wordGlossesFromMeanings(["بيت"], [[" "]])).toThrow();
});
