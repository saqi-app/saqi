import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import Database from "better-sqlite3";

import {
  AUTHOR_PAGE_SIZE,
  type CatalogDatabase,
  CatalogRepository,
} from "../src/lib/catalog";
import { publicationSnapshotFromPoem } from "../src/lib/publication-snapshot";

class TestStatement {
  readonly #database: Database.Database;
  readonly #query: string;
  readonly #values: unknown[];

  constructor(
    database: Database.Database,
    query: string,
    values: unknown[] = [],
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
      this.#values.map((value, index) => [String(index + 1), value]),
    );
    return {
      results:
        this.#values.length === 0 ? statement.all() : statement.all(parameters),
    };
  }
}

function catalogRepository(database: Database.Database): CatalogRepository {
  const adapter: CatalogDatabase = {
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.all()));
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

void test("canonical publication preserves visible alternatives and attribution", async () => {
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
    assert.deepEqual(
      summary?.poems[0]?.translationModels.map(({ key }) => key),
      ["legacy", "gemini"],
    );
    assert.equal(summary.poems[0].translationModels[0]?.model, "Claude 2");
    sqlite
      .prepare(
        "UPDATE poem SET source_hash=?, publication_source_hash=? WHERE id='p'",
      )
      .run("a".repeat(64), "b".repeat(64));
    const changedSource = await reader.getPoemPage("poet", "p");
    assert.equal(changedSource?.poem.publicationOutdated, true);
    assert.deepEqual(changedSource.poem.linesEnglish, ["Legacy English"]);
    assert.equal(await reader.getPoemPage("wrong-poet", "p"), undefined);
    sqlite.exec("UPDATE poem SET hidden=1 WHERE id='p'");
    assert.equal(await reader.getPoemPage("poet", "p"), undefined);
    assert.deepEqual(await reader.listAuthors(), []);
    sqlite.exec(
      "UPDATE poem SET hidden=0 WHERE id='p'; UPDATE author SET hidden=1 WHERE id='a'",
    );
    assert.equal(await reader.getPoemPage("poet", "p"), undefined);
  } finally {
    sqlite.close();
  }
});

void test("invalid publication cannot hide readable Arabic or advertise English", async () => {
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
    assert.equal(summary?.poems[0]?.hasEnglish, false);
    sqlite
      .prepare("UPDATE poem SET content_arabic=? WHERE id='p'")
      .run(JSON.stringify({ content: [] }));
    assert.equal(await reader.getPoemPage("poet", "p"), undefined);
  } finally {
    sqlite.close();
  }
});

void test("word-gloss publications keep the author-page insights badge", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author(id, slug, name_arabic, hidden)
      VALUES ('a-gloss', 'gloss-poet', 'شاعر', 0);
      INSERT INTO poem(id, author_id, slug, verses, name_arabic, content_arabic, hidden)
      VALUES ('p-gloss', 'a-gloss', 'gloss', 1, 'قصيدة', '{"content":["بيت"]}', 0);
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
    assert.equal(detail?.poem.insights, undefined);
    assert.ok(detail?.poem.modelEnrichments?.[0]?.wordGlosses);
    const summary = await reader.getAuthorPage("gloss-poet");
    assert.equal(summary?.poems[0]?.hasInsights, true);
  } finally {
    sqlite.close();
  }
});

void test("database rejects generated title preambles at write time", () => {
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
            "p-title-guard",
          ),
      /invalid generated poem title/u,
    );
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE poem SET name_english = ? WHERE id = ?")
          .run(
            "I will not provide translations without proper context.",
            "p-title-guard",
          ),
      /invalid generated poem title/u,
    );
    assert.equal(
      sqlite
        .prepare("SELECT name_english FROM poem WHERE id = ?")
        .pluck()
        .get("p-title-guard"),
      "I Have a Friend Who Keeps My Secrets",
    );
  } finally {
    sqlite.close();
  }
});

void test("author pages bound result size and reject pages beyond the catalog", async () => {
  const sqlite = createDatabase();
  try {
    sqlite
      .prepare("INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)")
      .run("a-many", "many-poems", "شاعر غزير");
    const insertPoem = sqlite.prepare(
      `INSERT INTO poem
        (id, author_id, slug, verses, name_arabic, content_arabic)
       VALUES (?, 'a-many', ?, 1, ?, '{"content":["بيت"]}')`,
    );
    sqlite.transaction(() => {
      for (let index = 0; index < AUTHOR_PAGE_SIZE + 5; index += 1) {
        const suffix = String(index).padStart(4, "0");
        insertPoem.run(`p-${suffix}`, `poem-${suffix}`, `قصيدة ${suffix}`);
      }
    })();
    const database = catalogRepository(sqlite);

    const first = await database.getAuthorPage("many-poems");
    const second = await database.getAuthorPage("many-poems", 2);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.poemCount, AUTHOR_PAGE_SIZE + 5);
    assert.equal(first.pageCount, 2);
    assert.equal(first.poems.length, AUTHOR_PAGE_SIZE);
    assert.equal(second.poems.length, 5);
    assert.equal(
      new Set([...first.poems, ...second.poems].map(({ id }) => id)).size,
      AUTHOR_PAGE_SIZE + 5,
    );
    assert.equal(await database.getAuthorPage("many-poems", 3), undefined);
    assert.equal(await database.getAuthorPage("many-poems", 0), undefined);
    assert.equal(
      await database.getAuthorPage("many-poems", Number.MAX_SAFE_INTEGER),
      undefined,
    );
  } finally {
    sqlite.close();
  }
});

void test("sitemap partitioning is stable and rejects invalid shards", async () => {
  const sqlite = createDatabase();
  try {
    const database = catalogRepository(sqlite);
    sqlite
      .prepare("INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)")
      .run("a-sitemap", "sitemap-poet", "شاعر");
    const insertPoem = sqlite.prepare(
      `INSERT INTO poem
        (id, author_id, slug, verses, name_arabic, content_arabic, sitemap_shard)
       VALUES (?, 'a-sitemap', ?, 1, 'قصيدة', '{"content":["بيت"]}', ?)`,
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
        [`${(shard - 1).toString(16)}-poem`],
      );
    }
    assert.deepEqual(await database.listSitemapPoems(0), []);
    assert.deepEqual(await database.listSitemapPoems(17), []);
  } finally {
    sqlite.close();
  }
});

for (const authorCount of [0, 1, 199, 200, 201]) {
  void test(`author index lists all ${String(authorCount)} publishable authors`, async () => {
    const sqlite = createDatabase();
    try {
      const insertAuthor = sqlite.prepare(
        "INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)",
      );
      const insertPoem = sqlite.prepare(
        `INSERT INTO poem
          (id, author_id, slug, verses, name_arabic, content_arabic)
         VALUES (?, ?, ?, 1, ?, '{"content":["بيت"]}')`,
      );
      sqlite.transaction(() => {
        for (let index = 0; index < authorCount; index += 1) {
          const suffix = String(index).padStart(3, "0");
          insertAuthor.run(`a-${suffix}`, `poet-${suffix}`, `شاعر ${suffix}`);
          insertPoem.run(
            `p-${suffix}`,
            `a-${suffix}`,
            `poem-${suffix}`,
            `قصيدة ${suffix}`,
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

void test("publishability triggers update indexed live counts", () => {
  const database = createDatabase();
  try {
    database.exec(`
      INSERT INTO author (id, slug, name_arabic, hidden)
      VALUES ('a-trigger', 'trigger', 'اختبار', 0);
      INSERT INTO poem (id, author_id, slug, verses, name_arabic, content_arabic, hidden)
      VALUES ('p-trigger', 'a-trigger', 'trigger-poem', 1, 'اختبار', '{"content":[]}', 0);
    `);
    const count = () =>
      database
        .prepare(
          "SELECT count(*) AS count FROM poem WHERE author_id = 'a-trigger' AND hidden = 0 AND publishable = 1",
        )
        .get() as { count: number };
    assert.equal(count().count, 0);
    database
      .prepare("UPDATE poem SET content_arabic = ? WHERE id = 'p-trigger'")
      .run(JSON.stringify({ content: [1, "بيت"] }));
    assert.equal(count().count, 0);
    database
      .prepare("UPDATE poem SET content_arabic = ? WHERE id = 'p-trigger'")
      .run(JSON.stringify({ content: [{ line: "بيت" }] }));
    assert.equal(count().count, 0);
    database
      .prepare("UPDATE poem SET content_arabic = ? WHERE id = 'p-trigger'")
      .run(JSON.stringify({ content: ["بيت"] }));
    assert.equal(count().count, 1);
    database.prepare("UPDATE poem SET hidden = 1 WHERE id = 'p-trigger'").run();
    assert.equal(count().count, 0);
    database.prepare("UPDATE poem SET hidden = 0 WHERE id = 'p-trigger'").run();
    assert.equal(count().count, 1);
    database.prepare("DELETE FROM poem WHERE id = 'p-trigger'").run();
    assert.equal(count().count, 0);
  } finally {
    database.close();
  }
});

void test("stable poem pagination index replaces translation-derived ordering", () => {
  const database = createDatabase();
  try {
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];
    const names = new Set(indexes.map(({ name }) => name));
    assert.ok(names.has("idx_poem_public_author_title"));
    assert.ok(!names.has("idx_poem_public_author_order"));
  } finally {
    database.close();
  }
});

void test("catalogs use normalized Arabic alphabetical order", async () => {
  const sqlite = createDatabase();
  try {
    const insertAuthor = sqlite.prepare(
      "INSERT INTO author (id, slug, name_arabic) VALUES (?, ?, ?)",
    );
    const insertPoem = sqlite.prepare(
      `INSERT INTO poem
        (id, author_id, slug, verses, name_arabic, content_arabic)
       VALUES (?, ?, ?, 1, ?, '{"content":["بيت"]}')`,
    );
    const names = ["آمنة", "بدر", "أحمد", "إبراهيم"];
    sqlite.transaction(() => {
      for (const [index, name] of names.entries()) {
        insertAuthor.run(`a-${String(index)}`, `author-${String(index)}`, name);
        insertPoem.run(
          `p-${String(index)}`,
          `a-${String(index)}`,
          `poem-${String(index)}`,
          name,
        );
      }
      for (const [index, name] of names.entries()) {
        insertPoem.run(
          `ps-${String(index)}`,
          "a-0",
          `sorted-poem-${String(index)}`,
          name,
        );
      }
    })();

    const authors = await catalogRepository(sqlite).listAuthors();
    assert.deepEqual(
      authors.map(({ author }) => author.nameArabic),
      ["إبراهيم", "أحمد", "آمنة", "بدر"],
    );
    const poems = await catalogRepository(sqlite).getAuthorPage("author-0");
    assert.deepEqual(
      poems?.poems.map(({ nameArabic }) => nameArabic),
      ["إبراهيم", "أحمد", "آمنة", "آمنة", "بدر"],
    );
  } finally {
    sqlite.close();
  }
});
