import { describe, expect, it } from "vitest";

import {
  canonicalPoemIdFromLegacySlug,
  parseCatalogInventory,
} from "../collection/inventory-reconciliation";

describe("catalog inventory reconciliation", () => {
  it("canonicalizes, sorts, and summarizes schema-driven records", () => {
    expect(
      parseCatalogInventory([
        { poemCount: 12, slug: "poet-Z" },
        { slug: "المعري" },
      ]),
    ).toEqual({
      authors: [
        {
          canonicalId: "source:author:poet-Z",
          href: "https://source.invalid/cat-poet-Z",
          poemCount: 12,
          slug: "poet-Z",
        },
        {
          canonicalId: "source:author:المعري",
          href: "https://source.invalid/cat-%D8%A7%D9%84%D9%85%D8%B9%D8%B1%D9%8A",
          poemCount: null,
          slug: "المعري",
        },
      ],
      declaredPoems: 12,
      unknownPoemCounts: 1,
    });
  });

  it("rejects canonical duplicates and unknown fields before mutation", () => {
    expect(() =>
      parseCatalogInventory([{ slug: "المعري" }, { slug: "المعري" }]),
    ).toThrow("SOURCE_CATALOG_AUTHOR_DUPLICATE");
    expect(() => parseCatalogInventory([{ extra: true, slug: "x" }])).toThrow();
  });

  it("is invariant to record order", () => {
    const records = [{ slug: "z" }, { poemCount: 2, slug: "a" }];
    expect(parseCatalogInventory(records.toReversed())).toEqual(
      parseCatalogInventory(records),
    );
  });
});

describe("production poem baseline", () => {
  it("recovers stable source IDs from legacy slugs and isolates orphans", () => {
    expect(canonicalPoemIdFromLegacySlug("poem78909")).toBe(
      "source:poem:78909",
    );
  });

  it.each(["poem0", "poem01", "Poem1", "poem1.html", "other1"])(
    "rejects noncanonical legacy slug %s",
    (slug) => {
      expect(() => canonicalPoemIdFromLegacySlug(slug)).toThrow(
        "SOURCE_LEGACY_POEM_SLUG_INVALID",
      );
    },
  );
});
