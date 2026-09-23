import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import type { D1Database } from "@cloudflare/workers-types";
import Database from "better-sqlite3";

import { loadCollectionInsights } from "../src/lib/insights";

const MIGRATIONS = new URL("../../operations/migrations/", import.meta.url);

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  for (const fileName of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(new URL(fileName, MIGRATIONS), "utf8"));
  }
  return database;
}

function asD1(database: Database.Database): D1Database {
  return {
    withSession: () => ({
      prepare: (query: string) => ({ query }),
      batch: async (statements: { query: string }[]) =>
        statements.map(({ query }) => ({ results: database.prepare(query).all() })),
    }),
  } as unknown as D1Database;
}

void test("monthly insight rollups track writes and replay without double counting", async () => {
  const sqlite = createDatabase();
  try {
    sqlite.exec(`
      INSERT INTO author (id, slug, name_arabic, poem_count)
      VALUES ('author-1', 'author-1', 'شاعر', 3);
      INSERT INTO poem (id, author_id, slug, verses, name_arabic, content_arabic)
      VALUES ('poem-1', 'author-1', 'poem-1', 1, 'قصيدة', '{"content":["بيت"]}');
      INSERT INTO author (id, slug, name_arabic)
      VALUES ('author-unknown', 'author-unknown', 'شاعر آخر');
      INSERT INTO poem (id, author_id, slug, verses, name_arabic, content_arabic)
      SELECT 'unknown-' || value, 'author-unknown', 'unknown-' || value,
             1, 'قصيدة', '{"content":["بيت"]}'
      FROM json_each('[1,2,3,4,5,6,7,8,9,10]');
      INSERT INTO source_author_identity (
        id, source_name, external_id, canonical_url, name_arabic,
        canonical_author_id, first_observed_at, last_observed_at
      ) VALUES (
        'source-author-1', 'test', 'author-1', 'https://example.com/author-1',
        'شاعر', 'author-1', 1780000000, 1780000000
      );
      INSERT INTO source_poem_identity (
        id, source_name, external_id, source_author_id, canonical_url,
        canonical_poem_id, first_observed_at, last_observed_at
      ) VALUES (
        'source-poem-1', 'test', 'poem-1', 'source-author-1',
        'https://example.com/poem-1', 'poem-1', 1780000000, 1780000000
      );
      INSERT INTO source_poem_identity (
        id, source_name, external_id, source_author_id, canonical_url,
        canonical_poem_id, first_observed_at, last_observed_at
      ) VALUES (
        'source-poem-2', 'test', 'poem-2', 'source-author-1',
        'https://example.com/poem-2', 'poem-1', 1780086400, 1780086400
      );
    `);
    const expected = await loadCollectionInsights(asD1(sqlite));
    assert.deepEqual(expected, {
      authorCount: 2,
      poemCount: 11,
      sourcePoemCount: 2,
      modelCounts: [],
      collectionMonths: [{ month: "2026-05-01", poemCount: 2 }],
    });

    sqlite.exec(readFileSync(new URL("0041_monthly_collection_insights.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await loadCollectionInsights(asD1(sqlite)), expected);

    sqlite.exec(`
      INSERT INTO source_poem_identity (
        id, source_name, external_id, source_author_id, canonical_url,
        canonical_poem_id, first_observed_at, last_observed_at
      ) VALUES (
        'source-poem-3', 'test', 'poem-3', 'source-author-1',
        'https://example.com/poem-3', 'poem-1', 1780444800, 1780444800
      );
    `);
    const nextMonth = await loadCollectionInsights(asD1(sqlite));
    assert.equal(nextMonth.sourcePoemCount, 3);
    assert.deepEqual(nextMonth.collectionMonths, [
      { month: "2026-06-01", poemCount: 1 },
      { month: "2026-05-01", poemCount: 2 },
    ]);

    sqlite.exec("UPDATE author SET poem_count = 4 WHERE id = 'author-1'");
    const updated = await loadCollectionInsights(asD1(sqlite));
    assert.equal(updated.authorCount, 2);

    sqlite.exec("UPDATE poem SET author_id = 'author-1' WHERE id = 'unknown-1'");
    const reparented = await loadCollectionInsights(asD1(sqlite));
    assert.equal(reparented.poemCount, 11);
    sqlite.exec("DELETE FROM poem WHERE id = 'unknown-1'");
    const restored = await loadCollectionInsights(asD1(sqlite));
    assert.equal(restored.poemCount, 10);
    sqlite.exec("DELETE FROM author WHERE id = 'author-unknown'");
    assert.equal((await loadCollectionInsights(asD1(sqlite))).authorCount, 1);
  } finally {
    sqlite.close();
  }
});
