import { describe, expect, it } from "vitest";

import {
  firstEnglishPoemLine,
  isUsablePoemTitle,
} from "../english-poem-text.js";

describe("firstEnglishPoemLine", () => {
  it("selects visible source counterparts in track priority order", () => {
    expect(
      firstEnglishPoemLine(
        [
          { lines: ["Orphan translation", "", "  The old house remembers.  "] },
          { lines: ["", "An alternate verse"] },
        ],
        [1, 2]
      )
    ).toBe("The old house remembers.");
  });

  it("skips refusals, unsafe text and Arabic-only candidates", () => {
    expect(
      firstEnglishPoemLine(
        [
          {
            lines: [
              "As an AI, I cannot translate",
              "Hidden\u{202e} text",
              "عربي",
              "A readable verse",
            ],
          },
        ],
        [0, 1, 2, 3]
      )
    ).toBe("A readable verse");
    expect(firstEnglishPoemLine([{ lines: ["A verse"] }], [])).toBeUndefined();
    expect(
      firstEnglishPoemLine([{ lines: ["عربي", ""] }], [0, 1])
    ).toBeUndefined();
    expect(
      firstEnglishPoemLine([{ lines: ["Two\nlines"] }], [0])
    ).toBeUndefined();
  });

  it("accepts long published lines without relaxing stored-title limits", () => {
    const line = "The evening carries a memory. ".repeat(12).trim();
    expect(isUsablePoemTitle(line)).toBe(false);
    expect(firstEnglishPoemLine([{ lines: [line] }], [0])).toBe(line);
    expect(isUsablePoemTitle("I Have a Friend Who Keeps My Secrets")).toBe(
      true
    );
    expect(
      isUsablePoemTitle(
        "Here is the English translation of the Arabic poem title"
      )
    ).toBe(false);
  });
});
