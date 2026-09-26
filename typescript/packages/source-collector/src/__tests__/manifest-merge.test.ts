import { describe, expect, it } from "vitest";

import {
  mergeDeclaredCount,
  mergeManifestPoems,
} from "../collection/collection-source-browser.js";
import type { AuthorPoemManifestProjection } from "../source-adapter/projections.js";

type Poem = AuthorPoemManifestProjection["poems"][number];
const POEM: Poem = {
  href: "https://source.invalid/poem1.html",
  title: "قصيدة",
  verseCountText: null,
};

describe("manifest page reconciliation", () => {
  it("deduplicates repeated pages and fills missing verse metadata", () => {
    const poems = new Map([[POEM.href, POEM]]);
    const richer = { ...POEM, verseCountText: "٢" };
    const added = { ...POEM, href: "https://source.invalid/poem2.html" };
    expect(mergeManifestPoems(poems, [richer, added], "CONFLICT")).toBe(1);
    expect(
      mergeManifestPoems(
        poems,
        [{ ...POEM, verseCountText: "2" }, added],
        "CONFLICT",
      ),
    ).toBe(0);
    expect(poems.get(POEM.href)).toEqual(richer);
  });

  it.each([
    { ...POEM, title: "قصيدة أخرى", verseCountText: "2" },
    { ...POEM, verseCountText: "3" },
  ])("rejects conflicting identity metadata", (incoming) => {
    const poems = new Map([[POEM.href, { ...POEM, verseCountText: "2" }]]);
    expect(() =>
      mergeManifestPoems(poems, [incoming], "SOURCE_FEED_CONFLICT"),
    ).toThrow(expect.objectContaining({ code: "SOURCE_FEED_CONFLICT" }));
  });

  it("preserves unknown counts while rejecting a changed declared count", () => {
    expect(mergeDeclaredCount(null, null)).toBeNull();
    expect(mergeDeclaredCount(null, 0)).toBe(0);
    expect(mergeDeclaredCount(2, null)).toBe(2);
    expect(mergeDeclaredCount(2, 2)).toBe(2);
    expect(() => mergeDeclaredCount(2, 3)).toThrow(
      expect.objectContaining({ code: "SOURCE_MANIFEST_COUNT_CHANGED" }),
    );
  });
});
