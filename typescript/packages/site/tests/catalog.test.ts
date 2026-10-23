import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import Database from "better-sqlite3";

import { authorPageRequest } from "../src/lib/author-page-request";
import {
  AUTHOR_PAGE_SIZE,
  type CatalogDatabase,
  CatalogRepository,
} from "../src/lib/catalog";
import { poemTranslationTracks } from "../src/lib/poem-translations";
import { publicationSnapshotFromPoem } from "../src/lib/publication-snapshot";

class TestStatement {
  readonly #database: Database.Database;
  readonly #query: string;
  readonly #values: unknown[];

  constructor(
    database: Database.Database,
    query: string,
    values: unknown[] = []
  ) {
    this.#database = database;
    this.#query = query;
    this.#values = values;
  }

  bind(...values: unknown[]) {
    return new TestStatement(this.#database, this.#query, values);
  }

  async all() {
    const statement = this.#database.prepare(this.#query);
    const parameters = Object.fromEntries(
      this.#values.map((value, index) => [String(index + 1), value])
    );
    return {
      results:
        this.#values.length === 0 ? statement.all() : statement.all(parameters),
    };
  }
}

function catalogRepository(
  database: Database.Database,
  observeBatch?: (rows: unknown[][]) => void
): CatalogRepository {
  const adapter: CatalogDatabase = {
    async batch(statements) {
      const results = await Promise.all(
        statements.map((statement) => statement.all())
      );
      observeBatch?.(results.map((result) => result.results));
      return results;
    },
    prepare(query) {
      return new TestStatement(database, query);
    },
  };
  return new CatalogRepository(adapter);
}

function createDatabase() {
  const database = new Database(":memory:");
  const migrations = new URL("../../operations/migrations/", import.meta.url);
  for (const fileName of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(new URL(fileName, migrations), "utf8"));
  }
  return database;
}

await test("author request loading keeps redirects small and resolves exact aliases", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id,slug,name_arabic) VALUES ('a','poet-original','شاعر');
      INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic)
      VALUES ('p','a','poem',1,'قصيدة','{"content":["بيت"]}');
      INSERT INTO public_author_segment(segment,namespace_id)
        SELECT 'clean-author',id FROM public_author_namespace WHERE author_id='a';
      UPDATE public_author_namespace SET canonical_slug='clean-author' WHERE author_id='a';
    `);
    const batches: number[][] = [];
    const reader = catalogRepository(sqlite, (rows) => {
      batches.push(rows.map((result) => result.length));
    });
    for (const path of [
      "/author/clean-author",
      "/author/clean-author/page/1",
      "/poet/clean-author/",
      "/poet/clean-author?q=1",
      "/poet/%63lean-author",
    ]) {
      const page = await authorPageRequest(`https://saqi.app${path}`, reader);
      assert.ok(page && "redirect" in page);
      assert.equal(page.author.publicSlug, "clean-author");
      assert.deepEqual(batches.pop(), [1]);
    }
    const page = await authorPageRequest(
      "https://saqi.app/poet/clean-author",
      reader
    );
    assert.ok(page && "poems" in page);
    assert.equal(page.poems.length, 1);
    assert.deepEqual(batches.pop(), [1, 1]);
    const alias = await authorPageRequest(
      "https://saqi.app/poet/poet-original",
      reader
    );
    assert.ok(alias && "redirect" in alias);
    assert.deepEqual(batches.pop(), [1, 0]);
    assert.equal(
      await authorPageRequest("https://saqi.app/poet/CLEAN-AUTHOR", reader),
      undefined
    );
    const batchCount = batches.length;
    assert.equal(
      await authorPageRequest("https://saqi.app/poet/a/page/01", reader),
      undefined
    );
    assert.equal(
      await authorPageRequest("https://saqi.app/poet/a/poem/p", reader),
      undefined
    );
    assert.equal(batches.length, batchCount);
  } finally {
    sqlite.close();
  }
});

await test("author aliases and normalized requests skip publication payloads", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id,slug,name_arabic) VALUES ('a','poet-original','شاعر');
      INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic)
      VALUES ('p','a','poem',1,'قصيدة','{"content":["بيت"]}');
      INSERT INTO public_author_segment(segment,namespace_id)
        SELECT 'clean-author',id FROM public_author_namespace WHERE author_id='a';
      UPDATE public_author_namespace SET canonical_slug='clean-author' WHERE author_id='a';
    `);
    const publication = publicationSnapshotFromPoem({
      id: "p",
      authorId: "a",
      slug: "poem",
      verses: 1,
      nameArabic: "قصيدة",
      linesArabic: ["بيت"],
      linesEnglish: ["Published first line"],
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='p'")
      .run(JSON.stringify(publication));
    const batches: number[][] = [];
    const reader = catalogRepository(sqlite, (rows) => {
      batches.push(rows.map((result) => result.length));
    });
    const alias = await reader.getAuthorPage("poet-original");
    assert.ok(alias && "redirect" in alias);
    assert.equal(alias.redirect, true);
    assert.equal(alias.author.slug, "poet-original");
    assert.equal(alias.author.publicSlug, "clean-author");
    assert.equal(alias.pageNumber, 1);
    assert.deepEqual(batches, [[1, 0]]);
    const canonical = await reader.getAuthorPage("clean-author");
    assert.ok(canonical && "poems" in canonical);
    assert.equal(canonical.poems[0]?.nameEnglish, "Published first line");
    assert.deepEqual(batches, [
      [1, 0],
      [1, 1],
    ]);
    const normalized = await reader.getAuthorPage("clean-author", 1, {
      redirectOnly: true,
    });
    assert.deepEqual(normalized, {
      author: canonical.author,
      pageNumber: 1,
      redirect: true,
    });
    assert.deepEqual(batches, [[1, 0], [1, 1], [1]]);
    assert.equal(
      await reader.getAuthorPage("clean-author", 2, { redirectOnly: true }),
      undefined
    );
    assert.equal(
      await reader.getAuthorPage("unknown", 1, { redirectOnly: true }),
      undefined
    );
    assert.equal(await reader.getAuthorPage("poet-original", 2), undefined);
    assert.equal(await reader.getAuthorPage("POET-ORIGINAL"), undefined);
    sqlite.exec("DELETE FROM poem WHERE id='p'");
    assert.equal(await reader.getAuthorPage("poet-original"), undefined);
    assert.equal(
      await reader.getAuthorPage("clean-author", 1, { redirectOnly: true }),
      undefined
    );
    sqlite.exec("DELETE FROM author WHERE id='a'");
    assert.equal(await reader.getAuthorPage("poet-original"), undefined);
    assert.equal(
      await reader.getAuthorPage("poet-original", 1, { redirectOnly: true }),
      undefined
    );
  } finally {
    sqlite.close();
  }
});

await test("null and empty canonical slugs retain the complete source-slug catalog", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id,slug,name_arabic) VALUES ('a','poet','شاعر');
      INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic)
      VALUES ('p','a','poem',1,'قصيدة','{"content":["بيت"]}');
      INSERT INTO public_author_segment(segment,namespace_id)
        SELECT '',id FROM public_author_namespace WHERE author_id='a';
    `);
    const reader = catalogRepository(sqlite);
    for (const canonicalSlug of [null, ""]) {
      sqlite
        .prepare(
          "UPDATE public_author_namespace SET canonical_slug=? WHERE author_id='a'"
        )
        .run(canonicalSlug);
      const page = await reader.getAuthorPage("poet");
      assert.ok(page && "poems" in page);
      assert.equal(page.author.publicSlug, undefined);
      assert.equal(page.poems[0]?.id, "p");
    }
  } finally {
    sqlite.close();
  }
});

await test("author redirects preserve exact case and Unicode namespace ownership", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id,slug,name_arabic)
        VALUES ('upper','Poet','شاعر'),('lower','poet','شاعر'),('nfc','é','شاعر'),('nfd','é','شاعر');
      INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic)
        SELECT id,id,id,1,'قصيدة','{"content":["بيت"]}' FROM author;
      INSERT INTO public_author_segment(segment,namespace_id)
        SELECT 'clean-' || author_id,id FROM public_author_namespace;
      UPDATE public_author_namespace SET canonical_slug='clean-' || author_id;
    `);
    const reader = catalogRepository(sqlite);
    for (const [slug, id] of [
      ["Poet", "upper"],
      ["poet", "lower"],
      ["é", "nfc"],
      ["e\u{301}", "nfd"],
    ] as const) {
      const page = await reader.getAuthorPage(slug);
      assert.ok(page && "redirect" in page);
      assert.equal(page.author.id, id);
      assert.equal(page.author.publicSlug, `clean-${id}`);
    }
    assert.equal(await reader.getAuthorPage("POET"), undefined);
    assert.equal(await reader.getAuthorPage("É"), undefined);
    assert.equal(
      await reader.getAuthorPage("POET", 1, { redirectOnly: true }),
      undefined
    );
    assert.equal(
      await reader.getAuthorPage("É", 1, { redirectOnly: true }),
      undefined
    );
  } finally {
    sqlite.close();
  }
});

await test("canonical publication preserves visible alternatives and attribution", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic) VALUES ('a', 'poet', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('p', 'a', 'poem', 1, 'قصيدة', '{"content":["بيت"]}');
    `);
    const publication = publicationSnapshotFromPoem({
      id: "p",
      authorId: "a",
      slug: "poem",
      verses: 1,
      nameArabic: "قصيدة",
      linesArabic: ["بيت"],
      linesEnglish: ["Legacy English"],
      linesEnglishModel: "Claude 1 or 2",
      linesEnglishAttributionCertainty: "inferred_range",
      linesEnglishModelVendor: "anthropic",
      linesEnglishGemini: ["Gemini English"],
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='p'")
      .run(JSON.stringify(publication));
    const reader = catalogRepository(sqlite);
    const page = await reader.getPoemPage("poet", "p");
    assert.deepEqual(page?.poem.linesEnglish, ["Legacy English"]);
    assert.deepEqual(page.poem.linesEnglishGemini, ["Gemini English"]);
    assert.equal(page.poem.linesEnglishModel, "Claude 1 or 2");
    const summary = await reader.getAuthorPage("poet");
    assert.ok(summary && "poems" in summary);
    assert.deepEqual(
      summary.poems[0]?.translationModels.map(({ key }) => key),
      ["legacy", "gemini"]
    );
    assert.equal(summary.poems[0].translationModels[0]?.model, "Claude 2");
    sqlite
      .prepare(
        "UPDATE poem SET source_hash=?, publication_source_hash=? WHERE id='p'"
      )
      .run("a".repeat(64), "b".repeat(64));
    const changedSource = await reader.getPoemPage("poet", "p");
    assert.equal(changedSource?.poem.publicationOutdated, true);
    assert.deepEqual(changedSource.poem.linesEnglish, ["Legacy English"]);
    assert.equal(await reader.getPoemPage("wrong-poet", "p"), undefined);
    sqlite.exec(
      "DELETE FROM poem WHERE id='p'; DELETE FROM author WHERE id='a'"
    );
    assert.equal(await reader.getPoemPage("poet", "p"), undefined);
    assert.deepEqual(await reader.listAuthors(), []);
  } finally {
    sqlite.close();
  }
});

await test("refusal-only publication retains Arabic and stored state without an English badge", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic) VALUES ('refusal-author', 'refusal-author', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('refusal-poem', 'refusal-author', 'refusal-poem', 1, 'قصيدة', '{"content":["بيت"]}');
    `);
    const linesEnglish = [
      "I apologize, but I do not feel comfortable providing translations for content I deem inappropriate or offensive.",
    ];
    const publication = publicationSnapshotFromPoem({
      id: "refusal-poem",
      authorId: "refusal-author",
      slug: "refusal-poem",
      verses: 1,
      nameArabic: "قصيدة",
      linesArabic: ["بيت"],
      linesEnglish,
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='refusal-poem'")
      .run(JSON.stringify(publication));
    const before = sqlite
      .prepare("SELECT * FROM poem WHERE id='refusal-poem'")
      .get();
    const reader = catalogRepository(sqlite);
    const summary = await reader.getAuthorPage("refusal-author");
    assert.ok(summary && "poems" in summary);
    const poem = summary.poems[0];
    assert.ok(poem);
    assert.equal(poem.hasEnglish, false);
    assert.deepEqual(poem.translationModels, []);
    assert.equal(poem.nameEnglish, undefined);
    const page = await reader.getPoemPage("refusal-author", "refusal-poem");
    assert.ok(page);
    assert.deepEqual(page.poem.linesArabic, ["بيت"]);
    assert.deepEqual(page.poem.linesEnglish, linesEnglish);
    assert.deepEqual(poemTranslationTracks(page.poem), []);
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM poem WHERE id='refusal-poem'").get(),
      before
    );
  } finally {
    sqlite.close();
  }
});

await test("author labels use visible English lines without rewriting legacy titles", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic) VALUES ('labels', 'label-poet', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, name_english, content_arabic)
      VALUES ('label-poem', 'labels', 'label-poem', 3, 'قصيدة', 'Qasidat al-dar',
        '{"content":["", "بيت", "", "", "", "أثر"]}');
    `);
    const publication = publicationSnapshotFromPoem({
      id: "label-poem",
      authorId: "labels",
      slug: "label-poem",
      verses: 3,
      nameArabic: "قصيدة",
      linesArabic: ["", "بيت", "", "", "", "أثر"],
      linesEnglish: [
        "Hidden first half",
        "The house remembers.",
        "Removed pair",
        "",
        "",
        "A trace remains.",
      ],
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='label-poem'")
      .run(JSON.stringify(publication));
    const page = await catalogRepository(sqlite).getAuthorPage("label-poet");
    assert.ok(page && "poems" in page);
    const poem = page.poems[0];
    assert.ok(poem);
    assert.equal(poem.nameEnglish, "The house remembers.");
    assert.equal(poem.verses, 2);
    assert.equal(poem.hasEnglish, true);
    assert.equal(
      sqlite
        .prepare("SELECT name_english FROM poem WHERE id='label-poem'")
        .pluck()
        .get(),
      "Qasidat al-dar"
    );
  } finally {
    sqlite.close();
  }
});

await test("English list labels follow published track priority and preserve fallback titles", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic) VALUES ('track-labels', 'track-labels', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, name_english, content_arabic)
      VALUES ('track-poem', 'track-labels', 'track-poem', 1, 'قصيدة', 'A Stored Title', '{"content":["بيت"]}');
    `);
    const publication = publicationSnapshotFromPoem({
      id: "track-poem",
      authorId: "track-labels",
      slug: "track-poem",
      verses: 1,
      nameArabic: "قصيدة",
      linesArabic: ["بيت"],
      modelEnrichments: [
        {
          modelKey: "current",
          model: "current",
          reasoningEffort: "high",
          lines: ["The current English verse"],
        },
      ],
      linesEnglishSol: ["The Sol verse"],
      linesEnglish: ["The legacy verse"],
      linesEnglishGemini: ["The Gemini verse"],
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='track-poem'")
      .run(JSON.stringify(publication));
    const reader = catalogRepository(sqlite);
    const page = await reader.getAuthorPage("track-labels");
    assert.ok(page && "poems" in page);
    const poem = page.poems[0];
    assert.ok(poem);
    assert.equal(poem.nameEnglish, "The current English verse");
    assert.deepEqual(
      poem.translationModels.map(({ key }) => key),
      ["current", "sol", "legacy", "gemini"]
    );
    const enrichment = publication.fields.modelEnrichments?.[0];
    assert.ok(enrichment);
    const longLine = `${"A memory remains ".repeat(400).slice(0, 4_999)}.`;
    enrichment.lines[0] = longLine;
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='track-poem'")
      .run(JSON.stringify(publication));
    const longPage = await reader.getAuthorPage("track-labels");
    assert.ok(longPage && "poems" in longPage);
    const label = longPage.poems[0]?.nameEnglish;
    assert.ok(label);

    assert.ok([...label].length <= 200);
    assert.ok(label.endsWith("…"));
    assert.equal(
      sqlite
        .prepare(
          "SELECT json_extract(publication_json, '$.fields.modelEnrichments[0].lines[0]') FROM poem WHERE id='track-poem'"
        )
        .pluck()
        .get(),
      longLine
    );
    sqlite
      .prepare("UPDATE poem SET publication_json=NULL WHERE id='track-poem'")
      .run();
    const unpublishedPage = await reader.getAuthorPage("track-labels");
    assert.ok(unpublishedPage && "poems" in unpublishedPage);
    assert.equal(unpublishedPage.poems[0]?.nameEnglish, "A Stored Title");
  } finally {
    sqlite.close();
  }
});

await test("invalid publication cannot hide readable Arabic or advertise English", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic) VALUES ('a', 'poet', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('p', 'a', 'poem', 1, 'قصيدة', '{"content":[" ","","بيت"]}');
      UPDATE poem SET publication_json='{"schemaVersion":2,"active":true,"fields":{"linesEnglish":"invalid"}}' WHERE id='p';
    `);
    const reader = catalogRepository(sqlite);
    const page = await reader.getPoemPage("poet", "p");
    assert.deepEqual(page?.poem.linesArabic, ["بيت"]);
    assert.equal(page.poem.verses, 1);
    assert.equal(page.poem.linesEnglish, undefined);
    const summary = await reader.getAuthorPage("poet");
    assert.ok(summary && "poems" in summary);
    assert.equal(summary.poems[0]?.hasEnglish, false);
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE poem SET content_arabic=? WHERE id='p'")
          .run(JSON.stringify({ content: [] })),
      /invalid poem/u
    );
    const unchanged = await reader.getPoemPage("poet", "p");
    assert.deepEqual(unchanged?.poem.linesArabic, ["بيت"]);
  } finally {
    sqlite.close();
  }
});

await test("word-gloss publications keep per-word meanings", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic)
      VALUES ('a-gloss', 'gloss-poet', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('p-gloss', 'a-gloss', 'gloss', 1, 'قصيدة', '{"content":["بيت"]}');
    `);
    const publication = publicationSnapshotFromPoem({
      id: "p-gloss",
      authorId: "a-gloss",
      slug: "gloss",
      verses: 1,
      nameArabic: "قصيدة",
      linesArabic: ["بيت"],
      modelEnrichments: [
        {
          modelKey: "sol-5.6",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          lines: ["A verse"],
          wordGlosses: {
            tokenizerVersion: "saqi-orthographic-v1",
            lines: [
              {
                lineIndex: 0,
                segments: [
                  {
                    kind: "word",
                    surface: "بيت",
                    meaning: "verse",
                    tokenIndex: 0,
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='p-gloss'")
      .run(JSON.stringify(publication));
    const reader = catalogRepository(sqlite);
    const detail = await reader.getPoemPage("gloss-poet", "p-gloss");
    assert.ok(detail?.poem.modelEnrichments?.[0]?.wordGlosses);
  } finally {
    sqlite.close();
  }
});

await test("blank verse pairs keep every publication track aligned with Arabic", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic) VALUES ('a', 'poet', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('p', 'a', 'poem', 2, 'قصيدة', '{"content":["", " ", "بيت", "شعر"]}');
    `);
    const wordGlosses = {
      tokenizerVersion: "saqi-orthographic-v1" as const,
      lines: [
        {
          lineIndex: 2,
          segments: [
            {
              kind: "word" as const,
              surface: "بيت",
              meaning: "verse",
              tokenIndex: 0,
            },
          ],
        },
        {
          lineIndex: 3,
          segments: [
            {
              kind: "word" as const,
              surface: "شعر",
              meaning: "poetry",
              tokenIndex: 0,
            },
          ],
        },
      ],
    };
    const publication = publicationSnapshotFromPoem({
      id: "p",
      authorId: "a",
      slug: "poem",
      verses: 2,
      nameArabic: "قصيدة",
      linesArabic: ["", " ", "بيت", "شعر"],
      linesEnglish: ["", "", "Legacy verse", "Legacy poetry"],
      linesEnglishGemini: ["", "", "Gemini verse", "Gemini poetry"],
      linesEnglishSol: ["", "", "Sol verse", "Sol poetry"],
      wordGlosses: {
        sourceHash: "a".repeat(64),
        model: "gpt-6-sol",
        meanings: wordGlosses,
      },
      modelEnrichments: [
        {
          modelKey: "custom",
          model: "custom",
          reasoningEffort: "high",
          lines: ["", "", "A verse", "Poetry"],
          wordGlosses,
        },
      ],
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=?, source_hash=? WHERE id='p'")
      .run(JSON.stringify(publication), "a".repeat(64));
    const page = await catalogRepository(sqlite).getPoemPage("poet", "p");
    assert.ok(page);
    assert.deepEqual(page.poem.linesArabic, ["بيت", "شعر"]);
    assert.deepEqual(page.poem.linesEnglish, ["Legacy verse", "Legacy poetry"]);
    assert.deepEqual(page.poem.linesEnglishGemini, [
      "Gemini verse",
      "Gemini poetry",
    ]);
    assert.deepEqual(page.poem.linesEnglishSol, ["Sol verse", "Sol poetry"]);
    const enrichment = page.poem.modelEnrichments?.[0];
    assert.ok(enrichment);
    assert.deepEqual(enrichment.lines, ["A verse", "Poetry"]);
    assert.deepEqual(
      enrichment.wordGlosses?.lines.map(({ lineIndex }) => lineIndex),
      [0, 1]
    );
    assert.deepEqual(
      page.poem.wordGlosses?.meanings.lines.map(({ lineIndex }) => lineIndex),
      [0, 1]
    );
  } finally {
    sqlite.close();
  }
});

await test("obsolete and ambiguous gloss surfaces never replace current Arabic", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic) VALUES ('a', 'poet', 'شاعر');
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('p', 'a', 'poem', 1, 'قصيدة', '{"content":["بيت", "شعر"]}');
    `);
    const glossLine = (lineIndex: number, surface: string) => ({
      lineIndex,
      segments: [
        { kind: "word" as const, surface, meaning: "meaning", tokenIndex: 0 },
      ],
    });
    const publication = publicationSnapshotFromPoem({
      id: "p",
      authorId: "a",
      slug: "poem",
      verses: 1,
      nameArabic: "قصيدة",
      linesArabic: ["بيت", "شعر"],
      modelEnrichments: [
        {
          modelKey: "partial",
          model: "partial",
          reasoningEffort: "high",
          lines: ["A verse", "Poetry"],
          wordGlosses: {
            tokenizerVersion: "saqi-orthographic-v1",
            lines: [glossLine(0, "قديم"), glossLine(1, "شعر")],
          },
        },
        {
          modelKey: "duplicate",
          model: "duplicate",
          reasoningEffort: "high",
          lines: ["A verse"],
          wordGlosses: {
            tokenizerVersion: "saqi-orthographic-v1",
            lines: [glossLine(0, "بيت"), glossLine(0, "بيت")],
          },
        },
        {
          modelKey: "obsolete",
          model: "obsolete",
          reasoningEffort: "high",
          lines: ["Historical English"],
          wordGlosses: {
            tokenizerVersion: "saqi-orthographic-v1",
            lines: [glossLine(0, "قديم"), glossLine(10, "بيت")],
          },
        },
      ],
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='p'")
      .run(JSON.stringify(publication));
    const page = await catalogRepository(sqlite).getPoemPage("poet", "p");
    assert.ok(page);
    const [partial, duplicate, obsolete] = page.poem.modelEnrichments ?? [];
    assert.ok(partial);
    assert.ok(duplicate);
    assert.ok(obsolete);
    assert.deepEqual(
      partial.wordGlosses?.lines.map(({ lineIndex }) => lineIndex),
      [1]
    );
    assert.equal(duplicate.wordGlosses, undefined);
    assert.equal(obsolete.wordGlosses, undefined);
    assert.deepEqual(obsolete.lines, ["Historical English", ""]);
  } finally {
    sqlite.close();
  }
});

await test("database rejects generated title preambles at write time", () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author (id, slug, name_arabic)
      VALUES ('a-title-guard', 'title-guard', 'شاعر');
      INSERT INTO poem
        (id, author_id, slug, verses, name_arabic, name_english, content_arabic)
      VALUES
        ('p-title-guard', 'a-title-guard', 'title-guard', 1, 'قصيدة',
         'I Have a Friend Who Keeps My Secrets', '{"content":["سطر"]}');
    `);

    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE poem SET name_english = ? WHERE id = ?")
          .run(
            "Here is the English translation of the Arabic poem title: A Title",
            "p-title-guard"
          ),
      /invalid generated poem title/u
    );
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE poem SET name_english = ? WHERE id = ?")
          .run(
            "I will not provide translations without proper context.",
            "p-title-guard"
          ),
      /invalid generated poem title/u
    );
    assert.equal(
      sqlite
        .prepare("SELECT name_english FROM poem WHERE id = ?")
        .pluck()
        .get("p-title-guard"),
      "I Have a Friend Who Keeps My Secrets"
    );
  } finally {
    sqlite.close();
  }
});

await test("author pages bound result size and reject pages beyond the catalog", async () => {
  const sqlite = createDatabase();
  try {
    sqlite
      .prepare("INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)")
      .run("a-many", "many-poems", "شاعر غزير");
    const insertPoem = sqlite.prepare(
      `INSERT INTO poem
        (id, author_id, slug, verses, name_arabic, content_arabic)
       VALUES (?, 'a-many', ?, 1, ?, '{"content":["بيت"]}')`
    );
    sqlite.transaction(() => {
      for (let index = 0; index < AUTHOR_PAGE_SIZE + 5; index += 1) {
        const suffix = String(index).padStart(4, "0");
        insertPoem.run(`p-${suffix}`, `poem-${suffix}`, `قصيدة ${suffix}`);
      }
    })();
    const database = catalogRepository(sqlite);

    const first = await database.getAuthorPage("many-poems");
    assert.ok(first && "poems" in first);
    const second = await database.getAuthorPage("many-poems", 2);
    assert.ok(second && "poems" in second);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.poemCount, AUTHOR_PAGE_SIZE + 5);
    assert.equal(first.pageCount, 2);
    assert.equal(first.poems.length, AUTHOR_PAGE_SIZE);
    assert.equal(second.poems.length, 5);
    assert.deepEqual(
      await database.getAuthorPage("many-poems", 2, { redirectOnly: true }),
      { author: second.author, pageNumber: 2, redirect: true }
    );
    assert.equal(
      await database.getAuthorPage("many-poems", 3, { redirectOnly: true }),
      undefined
    );
    assert.equal(
      new Set([...first.poems, ...second.poems].map(({ id }) => id)).size,
      AUTHOR_PAGE_SIZE + 5
    );
    assert.equal(await database.getAuthorPage("many-poems", 3), undefined);
    assert.equal(await database.getAuthorPage("many-poems", 0), undefined);
    assert.equal(
      await database.getAuthorPage("many-poems", Number.MAX_SAFE_INTEGER),
      undefined
    );
  } finally {
    sqlite.close();
  }
});

await test("sitemap partitioning is stable and rejects invalid shards", async () => {
  const sqlite = createDatabase();
  try {
    const database = catalogRepository(sqlite);
    sqlite
      .prepare("INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)")
      .run("a-sitemap", "sitemap-poet", "شاعر");
    const insertPoem = sqlite.prepare(
      `INSERT INTO poem
        (id, author_id, slug, verses, name_arabic, content_arabic, sitemap_shard)
       VALUES (?, 'a-sitemap', ?, 1, 'قصيدة', '{"content":["بيت"]}', ?)`
    );
    const hexadecimalPrefixes = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ];
    for (const [shard, prefix] of hexadecimalPrefixes.entries()) {
      insertPoem.run(`${prefix}-poem`, `${prefix}-poem`, shard);
    }
    for (let shard = 1; shard <= 16; shard += 1) {
      const sitemapPoems = await database.listSitemapPoems(shard);
      assert.deepEqual(
        sitemapPoems.map(({ poem }) => poem.id),
        [`${(shard - 1).toString(16)}-poem`]
      );
    }
    assert.deepEqual(await database.listSitemapPoems(0), []);
    assert.deepEqual(await database.listSitemapPoems(17), []);
  } finally {
    sqlite.close();
  }
});

for (const authorCount of [0, 1, 199, 200, 201]) {
  await test(`author index lists all ${String(authorCount)} authors with poems`, async () => {
    const sqlite = createDatabase();
    try {
      const insertAuthor = sqlite.prepare(
        "INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)"
      );
      const insertPoem = sqlite.prepare(
        `INSERT INTO poem
          (id, author_id, slug, verses, name_arabic, content_arabic)
         VALUES (?, ?, ?, 1, ?, '{"content":["بيت"]}')`
      );
      sqlite.transaction(() => {
        for (let index = 0; index < authorCount; index += 1) {
          const suffix = String(index).padStart(3, "0");
          insertAuthor.run(`a-${suffix}`, `poet-${suffix}`, `شاعر ${suffix}`);
          insertPoem.run(
            `p-${suffix}`,
            `a-${suffix}`,
            `poem-${suffix}`,
            `قصيدة ${suffix}`
          );
        }
        insertAuthor.run("a-zero", "zero-poems", "شاعر بلا قصائد");
      })();
      const database = catalogRepository(sqlite);
      const page = await database.getAuthorIndex();
      assert.ok(page);
      assert.equal(page.authors.length, authorCount);
      const ids = page.authors.map(({ author }) => author.id);
      assert.equal(ids.length, authorCount);
      assert.equal(new Set(ids).size, authorCount);
      assert.ok(!ids.includes("a-zero"), "authors with zero poems stay hidden");
    } finally {
      sqlite.close();
    }
  });
}

await test("invalid writes cannot enter indexed public poem counts", () => {
  const database = createDatabase();
  try {
    database.exec(`
      INSERT INTO author (id, slug, name_arabic)
      VALUES ('a-trigger', 'trigger', 'اختبار');
    `);
    const count = () =>
      database
        .prepare(
          "SELECT count(*) AS count FROM poem WHERE author_id = 'a-trigger'"
        )
        .get() as { count: number };
    assert.equal(count().count, 0);
    const insert = database.prepare(
      `INSERT INTO poem (id, author_id, slug, verses, name_arabic, content_arabic)
       VALUES ('p-trigger', 'a-trigger', 'trigger-poem', 1, 'اختبار', ?)`
    );
    assert.throws(
      () => insert.run(JSON.stringify({ content: [] })),
      /invalid poem/u
    );
    assert.throws(
      () => insert.run(JSON.stringify({ content: [1, "بيت"] })),
      /invalid poem/u
    );
    assert.throws(
      () => insert.run(JSON.stringify({ content: [{ line: "بيت" }] })),
      /invalid poem/u
    );
    assert.equal(count().count, 0);
    insert.run(JSON.stringify({ content: ["بيت"] }));
    assert.equal(count().count, 1);
    assert.throws(
      () =>
        database
          .prepare("UPDATE poem SET content_arabic = ? WHERE id = 'p-trigger'")
          .run(JSON.stringify({ content: ["بيت\u{0000}"] })),
      /invalid poem/u
    );
    assert.equal(count().count, 1);
    database.prepare("DELETE FROM poem WHERE id = 'p-trigger'").run();
    assert.equal(count().count, 0);
  } finally {
    database.close();
  }
});

await test("stable poem pagination index replaces translation-derived ordering", () => {
  const database = createDatabase();
  try {
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];
    const names = new Set(indexes.map(({ name }) => name));
    assert.ok(names.has("idx_poem_author_title_canonical"));
    assert.ok(!names.has("idx_poem_public_author_title"));
    assert.ok(!names.has("idx_poem_public_author_order"));
  } finally {
    database.close();
  }
});

await test("catalogs use normalized Arabic alphabetical order", async () => {
  const sqlite = createDatabase();
  try {
    const insertAuthor = sqlite.prepare(
      "INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)"
    );
    const insertPoem = sqlite.prepare(
      `INSERT INTO poem
        (id, author_id, slug, verses, name_arabic, content_arabic)
       VALUES (?, ?, ?, 1, ?, '{"content":["بيت"]}')`
    );
    const names = ["آمنة", "بدر", "أحمد", "إبراهيم"];
    sqlite.transaction(() => {
      for (const [index, name] of names.entries()) {
        insertAuthor.run(`a-${String(index)}`, `author-${String(index)}`, name);
        insertPoem.run(
          `p-${String(index)}`,
          `a-${String(index)}`,
          `poem-${String(index)}`,
          name
        );
      }
      for (const [index, name] of names.entries()) {
        insertPoem.run(
          `ps-${String(index)}`,
          "a-0",
          `sorted-poem-${String(index)}`,
          name
        );
      }
    })();

    const authors = await catalogRepository(sqlite).listAuthors();
    assert.deepEqual(
      authors.map(({ author }) => author.nameArabic),
      ["إبراهيم", "أحمد", "آمنة", "بدر"]
    );
    const poems = await catalogRepository(sqlite).getAuthorPage("author-0");
    assert.ok(poems && "poems" in poems);
    assert.deepEqual(
      poems.poems.map(({ nameArabic }) => nameArabic),
      ["إبراهيم", "أحمد", "آمنة", "آمنة", "بدر"]
    );
  } finally {
    sqlite.close();
  }
});

await test("standalone glosses stop aligning after source changes", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(
      "INSERT INTO author(id,slug,name_arabic) VALUES('a-standalone','standalone','شاعر')"
    );
    sqlite
      .prepare(
        `INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic,source_hash)
      VALUES('p-standalone','a-standalone','standalone',1,'قصيدة','{"content":["بيت"]}',?)`
      )
      .run("a".repeat(64));
    const publication = publicationSnapshotFromPoem({
      id: "p-standalone",
      authorId: "a-standalone",
      slug: "standalone",
      verses: 1,
      nameArabic: "قصيدة",
      linesArabic: ["بيت"],
      linesEnglish: ["Historical verse"],
      wordGlosses: {
        model: "gpt-6-sol",
        sourceHash: "a".repeat(64),
        meanings: {
          tokenizerVersion: "saqi-orthographic-v1",
          lines: [
            {
              lineIndex: 0,
              segments: [
                {
                  kind: "word",
                  surface: "بيت",
                  tokenIndex: 0,
                  meaning: "verse",
                },
              ],
            },
          ],
        },
      },
    });
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='p-standalone'")
      .run(JSON.stringify(publication));
    const reader = catalogRepository(sqlite);
    const before = await reader.getPoemPage("standalone", "p-standalone");
    assert.equal(before?.poem.wordGlosses?.model, "gpt-6-sol");
    sqlite
      .prepare("UPDATE poem SET source_hash=? WHERE id='p-standalone'")
      .run("b".repeat(64));
    const after = await reader.getPoemPage("standalone", "p-standalone");
    assert.equal(after?.poem.wordGlosses, undefined);
    assert.deepEqual(after?.poem.linesEnglish, ["Historical verse"]);
  } finally {
    sqlite.close();
  }
});

await test("catalog SQL whitespace rules agree with JavaScript validation", async () => {
  // A legacy read fixture deliberately bypasses current write guards.
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE author(id TEXT PRIMARY KEY, slug TEXT, name_arabic TEXT, name TEXT, sort_name_arabic TEXT);
      CREATE TABLE poem(id TEXT PRIMARY KEY, slug TEXT, author_id TEXT, verses INTEGER,
        name_arabic TEXT, name_english TEXT, content_arabic TEXT, publication_json TEXT,
        source_hash TEXT, publication_source_hash TEXT, sort_name_arabic TEXT);
      INSERT INTO author VALUES ('a','poet','شاعر',NULL,'شاعر');
      INSERT INTO poem VALUES ('p','poem','a',1,'قصيدة',NULL,'{"content":["بيت"]}',NULL,NULL,NULL,'قصيدة');
    `);
    sqlite.exec(`
      ALTER TABLE poem ADD COLUMN public_slug TEXT;
      CREATE TABLE public_author_namespace(id TEXT PRIMARY KEY,author_id TEXT UNIQUE,canonical_slug TEXT);
      CREATE TABLE public_author_segment(segment TEXT PRIMARY KEY,namespace_id TEXT);
      CREATE TABLE public_poem_alias(author_namespace_id TEXT,segment TEXT,poem_id TEXT,PRIMARY KEY(author_namespace_id,segment));
      INSERT INTO public_author_namespace VALUES('namespace-a','a',NULL);
      INSERT INTO public_author_segment VALUES('poet','namespace-a');
      INSERT INTO public_poem_alias VALUES('namespace-a','p','p');
    `);
    const reader = catalogRepository(sqlite);
    for (const whitespace of [
      "\t",
      "\n",
      "\r",
      "\u{00a0}",
      "\u{2003}",
      "\u{feff}",
    ]) {
      sqlite.prepare("UPDATE author SET name=?").run(whitespace);
      const authors = await reader.listAuthors();
      assert.equal(authors.length, 1);
      assert.equal(authors[0]?.author.nameEnglish, undefined);
      sqlite.prepare("UPDATE author SET name_arabic=?").run(whitespace);
      assert.deepEqual(await reader.listAuthors(), []);
      sqlite.prepare("UPDATE author SET name_arabic='شاعر'").run();
    }
    sqlite
      .prepare("UPDATE poem SET content_arabic=?")
      .run(JSON.stringify({ content: ["\t", "\n", "بيت", "\u{00a0}"] }));
    const page = await reader.getAuthorPage("poet");
    assert.ok(page && "poems" in page);
    const detail = await reader.getPoemPage("poet", "p");
    assert.deepEqual(
      page.poems.map(({ verses }) => verses),
      [1]
    );
    assert.equal(detail?.poem.verses, 1);
    assert.deepEqual(detail.poem.linesArabic, ["بيت", " "]);
    sqlite
      .prepare("UPDATE poem SET content_arabic=?")
      .run(JSON.stringify({ content: ["\t", "\n", "\u{00a0}"] }));
    const emptyPage = await reader.getAuthorPage("poet");
    assert.ok(emptyPage && "poems" in emptyPage);
    assert.deepEqual(emptyPage.poems, []);
    assert.equal(await reader.getPoemPage("poet", "p"), undefined);
  } finally {
    sqlite.close();
  }
});

await test("persistent aliases resolve exact history to the current author without catalog fanout", async () => {
  const sqlite = createDatabase();
  sqlite.pragma("foreign_keys=ON");
  try {
    sqlite.exec(`
      INSERT INTO author(id,slug,name_arabic) VALUES ('old','poet-old','قديم'),('current','poet-current','حالي');
      INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic) VALUES ('stable-id','old','poem-route-fixture',1,'قصيدة','{"content":["صدر"]}');
      INSERT INTO public_author_segment(segment,namespace_id) SELECT 'clean-current',id FROM public_author_namespace WHERE author_id='current';
      UPDATE public_author_namespace SET canonical_slug='clean-current' WHERE author_id='current';
      UPDATE poem SET public_slug='first-arabic-line' WHERE id='stable-id';
      UPDATE poem SET public_slug='first-english-line' WHERE id='stable-id';
      UPDATE poem SET author_id='current' WHERE id='stable-id';
      DELETE FROM author WHERE id='old';
    `);
    sqlite
      .prepare("UPDATE poem SET publication_json=? WHERE id='stable-id'")
      .run(
        JSON.stringify({
          schemaVersion: 2,
          active: false,
          fields: {
            id: "forged",
            authorId: "forged",
            publicSlug: "forged",
            linesEnglish: ["Published English"],
          },
        })
      );
    const repository = catalogRepository(sqlite);
    for (const [author, poem] of [
      ["poet-old", "stable-id"],
      ["poet-old", "first-arabic-line"],
      ["poet-old", "first-english-line"],
      ["clean-current", "stable-id"],
      ["clean-current", "first-english-line"],
    ] as const) {
      const page = await repository.getPoemPage(author, poem);
      assert.ok(page);
      assert.equal(page.poem.id, "stable-id");
      assert.equal(page.poem.publicSlug, "first-english-line");
      assert.equal(page.author.slug, "poet-current");
      assert.equal(page.author.publicSlug, "clean-current");
    }
    assert.equal(await repository.getAuthorPage("poet-old"), undefined);
    assert.equal(
      await repository.getPoemPage("poet-old", "unreserved"),
      undefined
    );
    assert.equal(
      await repository.getPoemPage("POET-OLD", "stable-id"),
      undefined
    );
    const index = await repository.listAuthors();
    assert.equal(index.length, 1);
    assert.equal(index[0]?.poemCount, 1);
    assert.equal(index[0].author.publicSlug, "clean-current");
    const page = await repository.getAuthorPage("clean-current");
    assert.ok(page && "poems" in page);
    assert.ok(page);
    assert.equal(page.poems.length, 1);
    assert.equal(page.poems[0]?.publicSlug, "first-english-line");
    const sitemap = await repository.listSitemapPoems(1);
    assert.equal(sitemap.length, 1);
    assert.equal(sitemap[0]?.poem.publicSlug, "first-english-line");
    assert.equal(sitemap[0].author.publicSlug, "clean-current");
    sqlite.prepare("DELETE FROM poem WHERE id='stable-id'").run();
    assert.equal(
      await repository.getPoemPage("poet-old", "stable-id"),
      undefined
    );
  } finally {
    sqlite.close();
  }
});

await test("case and canonical-equivalent Unicode aliases never cross owners", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`INSERT INTO author(id,slug,name_arabic) VALUES ('nfc','é','شاعر'),('nfd','é','شاعر');
      INSERT INTO poem(id,author_id,slug,verses,name_arabic,content_arabic) VALUES ('P','nfc','unicode-nfc',1,'قصيدة','{"content":["صدر"]}'),('p','nfd','unicode-nfd',1,'قصيدة','{"content":["صدر"]}');`);
    const repository = catalogRepository(sqlite);
    const nfc = await repository.getPoemPage("é", "P");
    const nfd = await repository.getPoemPage("e\u{301}", "p");
    assert.equal(nfc?.poem.id, "P");
    assert.equal(nfd?.poem.id, "p");
    assert.equal(await repository.getPoemPage("é", "p"), undefined);
    assert.equal(await repository.getPoemPage("e\u{301}", "P"), undefined);
  } finally {
    sqlite.close();
  }
});
