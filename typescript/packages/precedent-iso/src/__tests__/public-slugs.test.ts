import { describe, expect, it } from "vitest";

import {
  authorCollisionSlug,
  authorPublicSlugBase,
  poemPublicSlug,
} from "../public-slugs.js";

describe("persisted public slug policy v1", () => {
  it.each(["  The OLD house remembers.  ", "The old house remembers"])(
    "normalizes first line %s and pins a stable identity suffix",
    async (line) => {
      await expect(poemPublicSlug(line, "poem-1")).resolves.toBe(
        "the-old-house-remembers-38e0f1aa92c78437"
      );
    }
  );

  it.each(["'", "‘", "’", "ʼ", "＇"])(
    "removes apostrophe %s without splitting the word",
    (apostrophe) => {
      expect(authorPublicSlugBase(`poet-l${apostrophe}amour`)).toBe("lamour");
    }
  );

  it("normalizes Arabic ligatures and marks while retaining distinct letters", () => {
    expect(authorPublicSlugBase("PoEt-ﻻ ﻷ أَإِآ ؤ ئ ى ة ٱ")).toBe(
      "لا-لا-ااا-و-ي-ى-ة-ٱ"
    );
    expect(authorPublicSlugBase("poet-سـلام\u{200d}\u{202e}آخر")).toBe(
      "سلاماخر"
    );
  });

  it.each(["poet", "poet-", "poet-poet-", "POET-POET-"])(
    "reserves bare prefix seed %s before collision suffixing",
    async (seed) => {
      expect(authorPublicSlugBase(seed)).toBe("author");
      await expect(authorCollisionSlug(seed, "same")).resolves.toMatch(
        /^author-[a-f0-9]{16}$/u
      );
    }
  );

  it.each([
    ["PoEt-POET-Abn Rumi", "abn-rumi"],
    ["the-poet-returns", "the-poet-returns"],
    ["123", "123"],
  ])("normalizes author seed %s to %s", (seed, expected) => {
    expect(authorPublicSlugBase(seed)).toBe(expected);
  });

  it("uses safe empty and numeric poem fallback bases", async () => {
    await expect(poemPublicSlug("💧", "same")).resolves.toMatch(
      /^poem-[a-f0-9]{16}$/u
    );
    await expect(poemPublicSlug("١٢٣", "same")).resolves.toMatch(
      /^poem-١٢٣-[a-f0-9]{16}$/u
    );
  });

  it("retains a complete word at the UTF-16 limit", async () => {
    const body = `alpha-${"b".repeat(105)}`;
    await expect(poemPublicSlug(`${body}-tail`, "same")).resolves.toMatch(
      new RegExp(`^${body}-[a-f0-9]{16}$`, "u")
    );
  });

  it("retains a complete word at the percent-encoded limit", async () => {
    const body = `abc-${"漢".repeat(83)}`;
    const slug = await poemPublicSlug(`${body}-tail`, "same");
    expect(slug.startsWith(`${body}-`)).toBe(true);
    expect(encodeURIComponent(slug).length).toBe(768);
  });

  it("drops a trailing partial word but keeps a bounded giant first word", async () => {
    await expect(
      poemPublicSlug(`alpha-${"b".repeat(106)}-tail`, "same")
    ).resolves.toMatch(/^alpha-[a-f0-9]{16}$/u);
    const giant = await poemPublicSlug("word".repeat(1000), "same");
    expect(giant.length).toBe(128);
    expect(giant).toMatch(/^word.+-[a-f0-9]{16}$/u);
  });

  it.each(["𐐀", "漢", "س"])(
    "keeps complete Unicode scalars and all budgets for %s",
    async (letter) => {
      const slug = await poemPublicSlug(letter.repeat(1000), "same");
      expect(slug.length).toBeLessThanOrEqual(128);
      expect(encodeURIComponent(slug).length).toBeLessThanOrEqual(768);
      expect(slug.startsWith(letter.toLowerCase())).toBe(true);
      if (letter === "𐐀") expect(slug.startsWith("𐐨".repeat(55))).toBe(true);
      expect(slug.isWellFormed()).toBe(true);
      expect(slug).not.toContain("%");
    }
  );

  it("pins author identity suffixes and distinguishes author identities", async () => {
    await expect(authorCollisionSlug("poem", "same")).resolves.toBe(
      "poem-08fd7c1f4d27d97e"
    );
    await expect(authorCollisionSlug("poem", "other")).resolves.not.toBe(
      "poem-08fd7c1f4d27d97e"
    );
  });

  it("preserves exact stable identity bytes and separates entity domains", async () => {
    await expect(poemPublicSlug("line", "é")).resolves.not.toBe(
      await poemPublicSlug("line", "e\u{0301}")
    );
    await expect(poemPublicSlug("line", "A")).resolves.not.toBe(
      await poemPublicSlug("line", "a")
    );
    await expect(authorCollisionSlug("poem", "same")).resolves.not.toBe(
      await poemPublicSlug("", "same")
    );
  });

  it.each(["", "\u{d800}"])(
    "rejects invalid stable identity %j",
    async (id) => {
      await expect(poemPublicSlug("line", id)).rejects.toThrow(
        "INVALID_PUBLIC_ROUTE_IDENTITY"
      );
    }
  );
});
